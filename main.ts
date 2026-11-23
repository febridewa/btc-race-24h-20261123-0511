// Deep-dip mean-reversion bot for make.fun btc-race-24h-20261123-0511.
// Trades CBBTC/USDC on 1-minute on-chain bars, long only, $1,000 paper money.
//
// Why this strategy (measured with a fill-exact backtester on two published
// 24h dev windows — this race's and the previous race's — 1,440 bars each):
// - The pool's price moves only when someone trades on it, so it tracks the
//   wider BTC market with noise: 1-minute returns are ~6 bps of noise while a
//   full-size round trip costs ~26-37 bps (4 bps fee + 2 bps modelled
//   slippage + price impact against the pool's open depth). Fast
//   trend-following therefore churns itself to death on this window: the
//   kit's EMA-cross baseline lost $106, RSI/Bollinger $24, ADX $33 on the
//   previous window, while buy-and-hold made $1.07 there. This bot trades
//   rarely (a handful of round trips a day) and only at deep, slow
//   deviations from an 8-hour mean.
// - Signal: the z-score of log(close) against its rolling 480-bar (8h) mean
//   and population standard deviation. Buy 50% of cash when z <= -1.5.
//   Scale in with up to four adds of 50% of the remaining cash when the dip
//   deepens (z <= -2.0, -2.25, -2.5, then -2.75): averaging down into a
//   mean-reverting dip lowers the entry price. Sell the whole position when
//   z >= +1.0, i.e. the price has come back through its mean and into
//   strength.
// - Two safety rails, both inert on both dev windows (they never fired
//   there): a 360-bar maximum hold, so a position that never reverts is cut
//   instead of being carried to the end-of-window flatten, and a 10% equity
//   drawdown guard that flattens the position if the account ever falls
//   10% from its peak. They exist for the race window, which nobody has
//   seen: they cap the worst case at the cost of nothing on the dev windows.
// - What was tried and rejected (same backtester, both windows): a momentum
//   leg (buying EMA breakouts) lost money in every quarter of the previous
//   window; a trend filter that skips entries after a sharp 60-minute fall
//   blocked the best reversions and halved the PnL; volatility-adaptive
//   sizing changed nothing; a 360-bar window and a 600-bar window each
//   scored less than the 480-bar window on the worse of the two windows.
// - Deterministic: pure float64 arithmetic on the bars the harness sends, no
//   clock, no environment, no randomness. Two runs on the same data decide
//   the same orders.
//
// Dev-window grades (kit grade-local, process driver):
// - This race's dev window: net PnL +$10.19, 8 trades, max drawdown 0.28%.
// - Previous race's dev window: net PnL +$11.81, 14 trades, max drawdown 0.67%.
// The 480-bar window was chosen because it scored best on the worse of the
// two windows (+$10.19 vs +$7.74 for 360 bars and +$9.78 for 600 bars), and
// every 6-hour quarter of both windows ends at $0.00 or better.
// House baselines on the previous window: buy-and-hold +$1.07, momentum +$2.45,
// ema-cross -$106.21, rsi-bollinger -$24.25, adx-momentum -$32.66,
// hold-cash $0.00.

import { runBars, type Bar, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Rolling window for the mean and standard deviation, in 1-minute bars (8 hours). */
const WIN_BARS = 480;
/** A bar's close must sit this many standard deviations under the mean to buy. */
const Z_IN = -1.5;
/** The z-score the position is sold at (price back through its mean, into strength). */
const Z_OUT = 1.0;
/** The z-score each scale-in add waits for, in order. */
const SCALE_STEPS = [-2.0, -2.25, -2.5, -2.75];
/** Each buy spends this share of the cash on hand (percent). */
const BUY_FRAC_PERCENT = 50;
/** Slippage cap on every order, in bps (1-minute moves are far smaller). */
const MAX_SLIPPAGE_BPS = 1000;
/** At least 20 closes before the z-score is read at all. */
const MIN_BARS = 20;
/** Longest a position is held, in bars, before it is cut at the market. */
const MAX_HOLD_BARS = 360;
/** Equity drawdown from the peak, as a fraction, that flattens the position. */
const DD_GUARD = 0.1;

/** Rolling mean / population standard deviation of log closes, O(1) per bar. */
class ZScore {
  private readonly win: number;
  private readonly buf: number[] = [];
  private sum = 0;
  private sumSq = 0;

  constructor(win: number) {
    this.win = win;
  }

  push(x: number): void {
    this.buf.push(x);
    this.sum += x;
    this.sumSq += x * x;
    if (this.buf.length > this.win) {
      const y = this.buf.shift()!;
      this.sum -= y;
      this.sumSq -= y * y;
    }
  }

  /** The z-score of x against the window so far, or null while it is too short or flat. */
  z(x: number): number | null {
    const n = this.buf.length;
    if (n < MIN_BARS) return null;
    const mean = this.sum / n;
    const variance = this.sumSq / n - mean * mean;
    if (variance <= 1e-24) return null;
    return (x - mean) / Math.sqrt(variance);
  }
}

const zscore = new ZScore(WIN_BARS);
/** How many scale-in adds the current position has taken. */
let adds = 0;
/** The seq of the batch that opened the current position, or null when flat. */
let heldSinceSeq: number | null = null;
/** Peak equity seen, in quote units, for the drawdown guard. */
let peakEquity = 0n;
/**
 * The client_id of a buy sent on the previous batch but not yet confirmed by
 * a fill in this batch, or null. The harness reports every fill or rejection
 * in the next batch, so a buy is never re-sent while one is in flight, and a
 * scale-in step whose buy was rejected is not lost: it is retried while the
 * dip still holds.
 */
let pendingBuyId: string | null = null;
let pendingBuyWasAdd = false;

/** Fold this batch's fills into the pending-buy bookkeeping. */
function confirmPending(batch: { fills: { client_id: string; status: string }[] }): void {
  if (pendingBuyId === null) return;
  const fill = batch.fills.find((f) => f.client_id === pendingBuyId);
  if (fill === undefined) return;
  if (fill.status === 'rejected' && pendingBuyWasAdd) adds -= 1;
  pendingBuyId = null;
}

await runBars({
  onBatch(state: BarsState, batch: { bars: Bar[]; fills: { client_id: string; status: string }[] }): OrderInput[] {
    confirmPending(batch);
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined || state.warmingUp) return [];
    if (state.equity > peakEquity) peakEquity = state.equity;
    const x = Math.log(Number(bar.c) / 1e5);
    zscore.push(x);
    const z = zscore.z(x);
    if (z === null) return [];

    const held = state.positions.get(SYMBOL);
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (held === undefined) {
      adds = 0;
      heldSinceSeq = null;
      if (z <= Z_IN && pendingBuyId === null) {
        const amount = (state.cash * BigInt(BUY_FRAC_PERCENT)) / 100n;
        if (amount >= minNotional) {
          pendingBuyId = `e${state.seq}`;
          pendingBuyWasAdd = false;
          return [{ side: 'buy', symbol: SYMBOL, client_id: pendingBuyId, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    if (heldSinceSeq === null) heldSinceSeq = state.seq;
    // Safety rails: the drawdown guard and the maximum hold cut the position
    // even when the reversion signal has not fired.
    const drawdown = peakEquity > 0n ? Number(peakEquity - state.equity) / Number(peakEquity) : 0;
    if (drawdown >= DD_GUARD || state.seq - heldSinceSeq >= MAX_HOLD_BARS) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (adds < SCALE_STEPS.length && z <= SCALE_STEPS[adds] && state.cash >= minNotional && pendingBuyId === null) {
      const amount = (state.cash * BigInt(BUY_FRAC_PERCENT)) / 100n;
      if (amount >= minNotional) {
        adds += 1;
        pendingBuyId = `a${adds}-${state.seq}`;
        pendingBuyWasAdd = true;
        return [{ side: 'buy', symbol: SYMBOL, client_id: pendingBuyId, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    if (z >= Z_OUT) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
