![CI](https://github.com/youtix/gekko/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/github/license/youtix/gekko)
![Bun](https://img.shields.io/badge/runtime-bun-blue?logo=bun)
![TypeScript](https://img.shields.io/badge/language-typescript-blue?logo=typescript)
![Vitest](https://img.shields.io/badge/test-vitest-6E9F18?logo=vitest)

# Gekko

![Gordon Gekko](https://github.com/user-attachments/assets/769a2373-e22d-4b30-979f-09e636a49e4d)

_The most valuable commodity I know of is information._

— Gordon Gekko

## About

**Gekko** is a modular crypto trading bot framework for backtesting, alerting, paper trading, and live automated trading. Gekko succeeds the [original Gekko](https://github.com/askmike/gekko), rewritten from scratch, and went by Gekko 2 until October 2026. Built with TypeScript and powered by [Bun](https://bun.sh/), it lets you develop, test, and deploy custom trading strategies on cryptocurrency markets.

Gekko works in three modes: it imports an exchange's price history, one candle a minute, into a local database; it backtests a strategy on that history against a simulated exchange; and in realtime it follows the market minute by minute, to send you Telegram alerts when your strategy signals, to paper trade on live Binance prices, or to trade on Binance or Hyperliquid through CCXT, on their testnets or with real money. It compiles into standalone executables that run without Bun, and each [GitHub release](https://github.com/youtix/gekko/releases) comes with both: `gekko`, the bot, and `fox`.

Eight strategies come built in: a grid bot, and seven signal strategies that trade every pair you watch, sharing the currency among the pairs. Orders are MARKET, LIMIT or STICKY (a limit order that follows the best price), sized by an amount, a cost or a share of the free balance, and a trailing stop can protect a BUY. An analyzer measures a run's profit, return and risk, and a reporter adds each backtest's figures to a CSV file. On Telegram, one bot sends you the signals, the orders and the round trips and answers `/portfolio`, and a second one watches over Gekko's health.

Fox sweeps a strategy's parameters: give it a backtest configuration as a template and the values to try, as a list (`--strategy.period 12,24`) or a range (`--strategy.period 12..24:2`), and it backtests every combination side by side, each in a worker of its own, the PerformanceReporter of the template collecting their figures in one CSV file. See the [Fox guide](./documentation/fox.md).

---

## ⚠️ Disclaimer

**USE AT YOUR OWN RISK.**

Gekko is not financial advice software. The author is not responsible for any losses. Always test thoroughly with backtesting and paper trading before using real funds.

---

## Summary

- **[Quick Start](./documentation/quick-start.md)** — New to Gekko? Start here, one step at a time: install it, download price history, test a strategy on that history, get Telegram alerts, then trade with fake money on a testnet and, when you are ready, with real money. The steps before the testnet need no exchange API key.
- **[Modes](./documentation/modes.md)** — The three modes and when to use each: `importer` stores the 1-minute candles of Binance or Hyperliquid in a local SQLite database, `backtest` replays them on a simulated exchange, and `realtime` follows the live market to send Telegram alerts, to paper trade on live Binance prices, or to trade on Binance or Hyperliquid, on their testnets or with real money.
- **[Built-in Strategies](./documentation/built-in-strategies.md)** — The 8 built-in strategies, with their parameters and configuration examples: seven signal strategies (DEMA, MACD, RSI, CCI, TMA, SMACrossover and EMARibbon), which trade every pair of `watch.assets`, each BUY taking an equal share of the free currency among the pairs not yet invested, and GridBot, which trades a grid of LIMIT orders on the first pair.
- **[Custom Strategies](./documentation/custom-strategies.md)** — Write your own strategy in TypeScript, in a file of your own or inside your checkout: its hooks and tools, the indicators it registers, MARKET, LIMIT and STICKY orders sized by `amount`, `cost` or `allocation` (a share of the free balance) or all-in, trailing stops on BUY orders, the PositionTracker and the PositionBook that keep a position on one pair or on several, and how to run it with the standalone executable.
- **[Technical Indicators](./documentation/indicators.md)** — Complete reference for the 31 built-in indicators, with their parameters, their output and the candle of their first value, in six categories: moving averages (SMA, EMA, DEMA, WMA, TEMA…), momentum (MACD, Stochastic, PSAR…), directional movement (ADX, +DI, -DI…), oscillators (RSI, CCI, AO), volatility (ATR, Bollinger Bands…) and volume (OBV, EFI).
- **[Fox](./documentation/fox.md)** — Backtest every combination of the parameter values you list, from one template configuration, in parallel workers: the template, the lists and ranges of values, the check of every variant before the first backtest, the CSV file that gathers their figures, and what Fox logs.
- **[Plugins](./documentation/plugins.md)** — The 8 plugins a configuration chooses from, with their options and events: the TradingAdvisor runs the strategy and the Trader executes its orders; the PortfolioAnalyzer or the RoundTripAnalyzer measures the run, and the PerformanceReporter writes its report to a CSV file after a backtest; the CandleWriter stores the candles; the EventSubscriber sends the signals, the orders and the round trips to Telegram and answers `/portfolio` with the balances, the last prices and the total value; Supervision, a Telegram bot of its own, watches the CPU, the memory, the candles and the logs.

---

## Repository

Gekko is a monorepo of [Bun workspaces](https://bun.sh/docs/install/workspaces), whose tasks [Turborepo](https://turborepo.com/) runs, each package depending only on packages listed above it:

- `packages/shared`: the constants, the errors, the types and the helpers every package shares
- `packages/schemas`: the zod schemas of the configuration, the exchanges, the plugins and the strategies
- `packages/indicators`: the 31 indicators
- `packages/strategies`: the built-in strategies, the PositionTracker and the PositionBook, and your private strategies (`custom/`)
- `packages/core`: the configuration, the candle pipeline, the orders, the exchanges, the storage and the Telegram bots
- `packages/plugins`: the 8 plugins
- `apps/gekko`: the bot, compiled to `dist/gekko`, and its end-to-end tests
- `apps/fox`: Fox, compiled to `dist/fox`, and its templates

From the root of the checkout:

```bash
bun install          # the dependencies of every package, and the git hooks
bun run build:exec   # compiles dist/gekko and dist/fox, which run without Bun
bun run dev          # runs the bot from source, on the configuration GEKKO_CONFIG_FILE_PATH names
bun run dev:fox --template-path apps/fox/templates/dema.yml --strategy.period 12..24  # runs Fox from source
bun run test         # the unit tests of every package
bun run test:e2e     # the end-to-end tests of the bot
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

This project adheres to a [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE)
