# BTC Race Bot — btc-race-24h-20261123-0511

A deep-dip mean-reversion bot for the [make.fun](https://make.fun/bounty/btc-race-24h-20261123-0511) competition "Race a BTC trading bot live for 24 hours". It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain prices with $1,000 of paper money — simulation only, no real money is traded.

Referral: `6etrfz79`

## Strategy

- **Signal:** z-score of log(close) vs a rolling 360-bar (6h) mean and standard deviation.
- **Entry:** buy 50% of cash when z ≤ −1.75; scale in with up to four adds of 50% of remaining cash at z ≤ −2.0, −2.25, −2.5, −2.75.
- **Exit:** sell the whole position when z ≥ +1.0.
- **Safety rails:** 360-bar maximum hold and a 10% equity drawdown guard (both inert on the dev window; they cap the worst case on the unseen race window).

A full-size round trip costs ~26–37 bps in fees, slippage and price impact, while 1-minute moves are only ~6 bps of noise — so the bot trades rarely (a handful of round trips a day) and only at deep, slow deviations. Momentum entries, trend filters and volatility-adaptive sizing were tested on the dev window and rejected: each one reduced PnL or robustness.

## Results (dev windows, kit `grade-local`, process driver)

- This race's dev window: net PnL **+$10.19**, 8 trades, max drawdown 0.28%
- Previous race's dev window: net PnL **+$11.81**, 14 trades, max drawdown 0.67%
- House baselines on the previous window: buy-and-hold +$1.07, momentum +$2.45, ema-cross −$106.21, rsi-bollinger −$24.25, adx-momentum −$32.66, hold-cash $0.00

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's bars-replay/v1 SDK shim

## Run

The bot speaks `agent-fun/bars-replay/v1` (newline-delimited JSON on stdin/stdout) and is graded with the kit:

```
node cli/makefun.mjs grade-local --kit <kit> --bot <repo> --driver docker
```

Deterministic: pure float64 arithmetic on the bars the harness sends; no clock, no environment, no randomness.
