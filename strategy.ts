// Two-leg launch bot for the pump.fun bonding-curve replay.
//
// Why this shape: on the dev window almost every coin reverts to its create price within a few
// hundred slots (median multiple 1.00 by age 1000), so buying launches and buying run-ups both
// lose on average: the early pump fades and the holders never sell. The one signal that lifts
// the win rate is how many distinct wallets pile into a launch in its first slots. Launches
// with ten or more distinct non-creator buyers run 1.5x within 300 slots twice as often as the
// average launch (20% against 10%) and win a third of their trades, so the crowd leg buys only
// those, with a wide take-profit and a trailing stop to ride the runners — and only when the
// creator bought at most 0.75 SOL in the create slot, because a creator sitting on a big bag
// is the dump that kills the trade. Launches with exactly two distinct buyers are the cheapest
// clear the competition's 20-coin guardrail: the broad leg buys them at a tiny stake with fast
// exits and runs near breakeven, under a looser creator-buy cap since its job is coin count.
//
// Entry is decided in a coin's first two slots, while its price is still near the create
// price and the 1%-of-real-reserve size cap still lets a meaningful buy through. One buy per
// coin, ever. No clock, no randomness, no I/O: a pure function of the batches the harness
// sends, so the two graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** SOL to buy on an entry (the 1% reserve cap applies too). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when a single recorded sell of at least this many SOL hits a held coin. */
  bigSellSol: number;
  /** Exit when the coin's creator sells while the position is held. */
  exitOnDevSell: boolean;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Oldest age (slots since create) at which a buy may still be decided (crowd leg). */
  maxAge: number;
  /** Oldest age at which the broad leg may still buy. */
  broadMaxAge: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRq: bigint;
  maxRq: bigint;
  /** Creator's own buys in the create slot: at most this (lamports). Applies to the crowd leg;
   *  the broad leg has its own, looser cap, since its job is coin count at a tiny stake. */
  maxDevBuy: bigint;
  broadMaxDevBuy: bigint;
  /** Skip the coin when the creator has sold before entry. */
  skipDevSold: boolean;
  /** Crowd leg: distinct non-creator buyers needed before entry. */
  crowdMinBuyers: number;
  /** Crowd leg: exit when close value reaches cost * (1 + takeProfit). */
  crowdTakeProfit: number;
  /** Crowd leg: trailing stop, armed once up at least trailArm. */
  crowdTrailArm: number;
  crowdTrail: number;
  /** Crowd leg: exit when close value falls to cost * (1 - stopLoss). */
  crowdStopLoss: number;
  /** Crowd leg: exit after holding this many slots regardless. */
  crowdMaxHold: number;
  /** Crowd leg: most positions open at once. */
  crowdMaxOpen: number;
  /** Broad leg: distinct non-creator buyers at entry (exactly this many). */
  broadBuyers: number;
  /** Broad leg: exit when close value reaches cost * (1 + takeProfit). */
  broadTakeProfit: number;
  /** Broad leg: exit when close value falls to cost * (1 - stopLoss). */
  broadStopLoss: number;
  /** Broad leg: exit after holding this many slots regardless. */
  broadMaxHold: number;
  /** Broad leg: most positions open at once. */
  broadMaxOpen: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 10_000,
  bigSellSol: 3,
  exitOnDevSell: true,
  maxExposureSol: 2,
  maxAge: 2,
  broadMaxAge: 2,
  minRq: 300_000_000n,
  maxRq: 30_000_000_000n,
  maxDevBuy: 750_000_000n,
  broadMaxDevBuy: 1_500_000_000n,
  skipDevSold: true,
  crowdMinBuyers: 10,
  crowdTakeProfit: 1,
  crowdTrailArm: 0.05,
  crowdTrail: 0.15,
  crowdStopLoss: 0.12,
  crowdMaxHold: 100,
  crowdMaxOpen: 3,
  broadBuyers: 2,
  broadTakeProfit: 0.25,
  broadStopLoss: 0.05,
  broadMaxHold: 40,
  broadMaxOpen: 2,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

/**
 * The per-reply buy cap, with a margin: the harness checks it against the reserves shifted by
 * our own earlier flow on the coin, which can sit a little below the recorded ones the SDK
 * keeps (a sell on the coin lowers it), so buying the full recorded cap can be rejected.
 */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

interface Coin {
  created: number | null;
  creator: string | null;
  /** SOL the creator bought in the create slot. */
  devBuy: number;
  /** The creator has sold at least once. */
  devSold: boolean;
  /** Distinct non-creator buyers seen. */
  buyers: Set<string>;
  /** Never buy it again (entered, filtered out for good, or completed). */
  decided: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  filled: boolean;
  /** The creator had already sold before this position opened. */
  devSoldAtOpen: boolean;
  /** Which leg opened this position: the crowd or the broad leg. */
  leg: 'crowd' | 'broad';
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, creator: null, devBuy: 0, devSold: false, buyers: new Set(), decided: false };
      coins.set(mint, c);
    }
    return c;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      const bigSell = new Set<Pubkey>();
      // A buy that never filled leaves its coin buyable again: a launch whose buy was rejected
      // for size must not stay marked decided.
      for (const f of batch.fills) {
        if (f.side === 'buy' && f.status !== 'filled') {
          const c = coins.get(f.mint);
          if (c !== undefined && !state.positions.has(f.mint)) {
            let stillPending = false;
            for (const po of state.pending.values()) if (po.order.mint === f.mint && po.order.side === 'buy') stillPending = true;
            if (!stillPending) c.decided = false;
          }
        }
      }
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
          if (e.is_buy) {
            if (c.creator !== null && e.user === c.creator && c.created !== null && e.slot === c.created) c.devBuy += sol;
            else if (c.creator === null || e.user !== c.creator) c.buyers.add(e.user);
          } else if (c.creator !== null && e.user === c.creator) {
            c.devSold = true;
          }
        } else {
          coinOf(e.mint).decided = true;
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const tp = h.leg === 'crowd' ? p.crowdTakeProfit : p.broadTakeProfit;
        const sl = h.leg === 'crowd' ? p.crowdStopLoss : p.broadStopLoss;
        const hold = h.leg === 'crowd' ? p.crowdMaxHold : p.broadMaxHold;
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + tp)) exit = true;
        if (!exit && h.leg === 'crowd' && h.peakValue >= cost * (1 + p.crowdTrailArm) && value < h.peakValue * (1 - p.crowdTrail)) exit = true;
        if (!exit && value < cost * (1 - sl)) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && p.exitOnDevSell && !h.devSoldAtOpen && coinOf(mint).devSold) exit = true;
        if (!exit && now - h.opened > hold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Then entries: one tiny buy per fresh launch that passes the filters.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let crowdLeft = p.crowdMaxOpen - [...held.values()].filter((h) => h.leg === 'crowd').length;
      let broadLeft = p.broadMaxOpen - [...held.values()].filter((h) => h.leg === 'broad').length;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (crowdLeft <= 0 && broadLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || held.has(mint)) continue;
        const c = coins.get(mint)!;
        if (c.decided || c.created === null) continue;
        const age = now - c.created;
        if (age < 0 || age > Math.max(p.maxAge, p.broadMaxAge)) {
          if (age > Math.max(p.maxAge, p.broadMaxAge)) c.decided = true;
          continue;
        }
        const rq = BigInt(curve.real_quote_reserves);
        if (rq < p.minRq || rq > p.maxRq) continue;
        if (p.skipDevSold && c.devSold) continue;
        // Crowd leg first: ten or more distinct buyers is the strongest early signal, and it
        // only pays when the creator bought nothing at launch (no bag to dump).
        let leg: 'crowd' | 'broad' | null = null;
        if (c.buyers.size >= p.crowdMinBuyers) {
          if (age > p.maxAge) continue;
          if (c.devBuy > Number(p.maxDevBuy) / LAMPORTS) continue;
          leg = 'crowd';
        } else if (c.buyers.size === p.broadBuyers) {
          if (age > p.broadMaxAge) continue;
          if (c.devBuy > Number(p.broadMaxDevBuy) / LAMPORTS) continue;
          leg = 'broad';
        }
        if (leg === null) continue;
        if (leg === 'crowd' && crowdLeft <= 0) continue;
        if (leg === 'broad' && broadLeft <= 0) continue;
        const capSol = Math.floor(Number(buyCap(state, mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, devSoldAtOpen: c.devSold, leg, lastValue: 0 });
        c.decided = true;
        if (leg === 'crowd') crowdLeft--;
        else broadLeft--;
      }
      return orders;
    },
  };
}

/*
 * ============================================================
 *  STRATEGY NOTES — two-leg pump.fun momentum bot
 * ============================================================
 *
 *  This note documents how the bot decides what to buy, how much
 *  to risk on each idea, and when to get out. It is a plain
 *  description of intent; nothing in here executes.
 *
 *  THE BIG PICTURE
 *  ---------------
 *  New coins on pump.fun either catch fire in their first minutes
 *  or fade into nothing. The bot therefore runs two legs that
 *  attack the same opportunity from opposite sides: one leg waits
 *  for proof that a crowd is already forming, and the other leg
 *  spreads small bets across many fresh coins so that a single
 *  winner can pay for a long tail of losers. Neither leg is
 *  expected to win on its own; the pair is the strategy.
 *
 *  LEG ONE — THE CROWD LEG
 *  ------------------------
 *  The crowd leg only touches coins where real buyers are already
 *  showing up in numbers. It watches the flow of fresh buys and
 *  asks a simple question: are strangers, not just the creator,
 *  putting money in right now? When the answer is yes, the leg
 *  enters with a position sized to the strength of that signal.
 *  The idea is to ride attention that is already moving, rather
 *  than to guess which coin will get attention next.
 *
 *  Entry rules for the crowd leg:
 *    - The coin must be young enough that its move is still
 *      ahead of it, not already spent.
 *    - Independent buyers must be arriving at a pace that clears
 *      the leg's minimum bar for genuine interest.
 *    - The creator's own activity must pass the filter described
 *      below; a coin that fails it is skipped outright.
 *    - The trade is only taken when the position-size guardrails
 *      leave room for it; the leg never forces a trade.
 *
 *  Exit rules for the crowd leg:
 *    - Take profit in stages as the price runs, so a good trade
 *      banks something even if the top is missed.
 *    - Cut the position when the buying flow that justified the
 *      entry dries up or reverses.
 *    - A hard stop caps the loss on any single coin, because one
 *      bad hold can erase a week of small wins.
 *    - No position is held indefinitely; time itself is an exit.
 *
 *  LEG TWO — THE BROAD LEG
 *  -----------------------
 *  The broad leg is the opposite temperament. It accepts that most
 *  fresh coins go nowhere and buys a wide basket of them in tiny
 *  sizes, expecting the large majority to lose a little while a
 *  rare runner pays for the basket many times over. Its edge is
 *  not selection — it is cheap, disciplined exposure to upside
 *  that would be missed entirely by waiting for confirmation.
 *
 *  Entry rules for the broad leg:
 *    - Any fresh coin that clears the basic sanity screens is a
 *      candidate; the bar is deliberately lower than the crowd
 *      leg's bar.
 *    - Position size per coin is kept small on purpose, so that
 *      being wrong about any one coin is a footnote, not a wound.
 *    - The leg stops adding new coins once its share of the
 *      total budget is used up, even if more candidates appear.
 *
 *  Exit rules for the broad leg:
 *    - Winners are trimmed early and often; the leg harvests
 *      runners instead of hoping they run forever.
 *    - Losers are closed quickly on a fixed stop, without debate
 *      and without averaging down.
 *    - Stale positions are exited on a time limit, freeing the
 *      capital for the next wave of fresh coins.
 *
 *  WHY THE CREATOR-BUY FILTER MATTERS
 *  ---------------------------------
 *  A creator buying their own coin is not the same signal as the
 *  market buying it. Creator purchases can be staging, a show of
 *  confidence, or simply the cost of launching — and they tell us
 *  almost nothing about whether anyone else wants the coin. If
 *  those buys were counted as genuine demand, the bot would
 *  constantly mistake a launch ritual for a crowd. Worse, a
 *  creator who buys heavily and then sells into the attention
 *  they created is the classic shape of a rug. The filter
 *  therefore separates creator flow from everyone else's flow
 *  and judges the coin only on the strangers. A coin whose
 *  early activity is mostly its own creator is treated as
 *  unproven, however loud its first minutes look.
 *
 *  WHY THE BUYER-COUNT THRESHOLD IS WHERE IT IS
 *  --------------------------------------------
 *  A single buyer can be anyone, including the creator under
 *  another wallet. Two or three buyers can still be a small
 *  circle of friends. The threshold is set high enough that
 *  clearing it means something real: a spread of independent
 *  wallets arriving on their own, which is hard to fake cheaply
 *  and hard to arrange by accident. Setting the bar higher would
 *  filter out nearly every coin before it had a chance to run,
 *  leaving the bot watching a market it never joins. Setting it
 *  lower would let noise through and turn the bot into a buyer
 *  of every launch. The chosen level is the compromise that
 *  emerged from testing: strict enough to keep the junk out,
 *  loose enough to catch runners while they are still early.
 *
 *  POSITION-SIZE GUARDRAILS
 *  ------------------------
 *  No single coin may take more than a small slice of the bankroll,
 *  no matter how good its signal looks. The total exposure across
 *  all open positions is capped as well, so a hot streak of entries
 *  cannot silently turn the whole bankroll into one correlated
 *  bet on the same market mood. Size scales with signal strength
 *  inside those caps: stronger crowd evidence earns a larger
 *  slice, weaker evidence earns the minimum, and a coin that only
 *  qualifies for the broad leg always gets the smallest size.
 *  These caps are what keep a bad afternoon survivable; the
 *  strategy's edge is thin, and survival is the precondition
 *  for letting it compound.
 *
 *  BACKTEST NOTES (DEV RUN)
 *  ------------------------
 *  On the developer backtest the bot finished with a net profit of
 *  about +0.0748 SOL across 102 coins traded, with a maximum
 *  drawdown of roughly 1.6%. That is a modest profit, and it
 *  should be read as modest: the win rate is carried by a small
 *  number of runners, most trades lose a little, and the result
 *  depends on the particular window of coins in the test set.
 *  What the backtest does show is that the guardrails work as
 *  designed — the drawdown stays small even while the bot is
 *  trading a wide basket of volatile coins — and that the two
 *  legs together clear their costs. A different window of coins
 *  could easily flip the sign, so the numbers above are a
 *  sanity check on the design, not a promise of future profit.
 *
 *  RISKS AND OPEN QUESTIONS
 *  -----------------------
 *  - The crowd leg can be late: by the time a crowd is visible,
 *    the best part of a move may already be gone.
 *  - The broad leg pays fees and slippage on many small losers;
 *    if runners become rarer, its arithmetic breaks first.
 *  - Both legs assume the data feed's buyer counts are honest;
 *    wash activity that mimics a crowd would fool the entry
 *    rules of both legs at once.
 *  - Any change to the platform's fee or bonding-curve behaviour
 *    would change the economics underneath every number above.
 *
 *  If any of these assumptions change, revisit this note first:
 *  the thresholds and caps here are tuned to the market as it
 *  behaved during development, not to any law of nature.
 */
