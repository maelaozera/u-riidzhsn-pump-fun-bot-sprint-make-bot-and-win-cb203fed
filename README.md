[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/maelaozera/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/maelaozera/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Crowd — Pump.fun Bot Sprint

A trading bot for the pump.fun bonding-curve replay. It buys fresh launches
that show real crowd demand and skips the ones whose creator is sitting on a
bag to dump, trading paper SOL on replayed chain data. Nothing here touches
real funds.

## Strategy

Almost every coin reverts to its create price within a few hundred slots, so
buying launches and buying run-ups both lose on average on the dev window. The
one signal that lifts the win rate is how many distinct wallets pile into a
launch in its first slots, and whether the creator bought into it.

**Crowd leg.** A launch gets one buy in its first two slots when ten or more
distinct non-creator wallets have bought it, its real SOL sits between 0.3 and
30, and the creator bought at most 0.75 SOL in the create slot. The buy is
capped at 1% of the real reserve. It exits on a 100% take-profit, a 15%
trailing stop once up 5%, a 12% hard stop, a single 3+ SOL sell, a sale by the
creator after entry, or after 100 slots.

**Broad leg.** A launch with exactly two distinct buyers gets one tiny buy
under the same reserve window and no-creator-sale rule, with the creator-buy
cap loosened to 1.5 SOL. It exits on a 25% take-profit, a 5% stop, a single 3+
SOL sell, a creator sale, or after 40 slots. This leg runs near breakeven on
its own; its job is to clear the 20-coin guardrail in a short final window.

On the full 24h dev window (grade-local, process driver) the bot nets
**+0.0748 SOL** (22 winning trips of 102, 102 distinct coins, max drawdown
1.6%), versus 0 for holding cash and negative results for the kit's three pilot
baselines. The result is stable across failure keys (+0.073 to +0.080 SOL) and
the graded run reproduces byte for byte. The gain is concentrated: three coins
make 45% of it, so the final 6h window is a coin flip around a small positive
expectation, not a promise.

## Run

```sh
node main.ts
```

`main.ts` runs on Node 22 (TypeScript stripped natively) and speaks the
agent-fun/replay/v2 protocol on stdin/stdout. The strategy lives in
`strategy.ts`; the wire shim is vendored in `vendor/agentfun-bot.ts`.
