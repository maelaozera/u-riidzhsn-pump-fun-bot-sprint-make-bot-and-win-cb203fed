// Climber: a pump.fun bonding-curve bot for the agent-fun/replay/v2 harness.
//
// The bot rides coins that are climbing toward completion. A coin becomes a candidate the first
// time its real SOL reserve crosses a threshold (strong, sustained buying got it there), while
// its price is still near the peak it reached on the way up and fresh buy flow is still coming
// in. It buys once, small, then exits on a take-profit, a trailing stop from its best value, a
// hard stop, or a time limit; a curve that completes is closed by the replay at its final
// reserves. No clock, no randomness, no I/O: a pure function of the batches the harness sends,
// so the two graded executions produce byte-identical action logs.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
