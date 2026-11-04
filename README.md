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

**Gekko** is a modular crypto trading bot framework for backtesting, alerting, paper trading, and live automated trading. Gekko succeeds the [original Gekko](https://github.com/askmike/gekko), rewritten from scratch, and went by Gekko 2 until October 2026 ([Upgrading](./documentation/upgrading.md) says what to change in a setup of its last release, 2.0.0). Built with TypeScript and powered by [Bun](https://bun.sh/), it lets you develop, test, and deploy custom trading strategies on cryptocurrency markets.

Gekko works in three modes: it imports an exchange's price history, one candle a minute, into a local database; it backtests a strategy on that history against a simulated exchange; and in realtime it follows the market minute by minute, to send you Telegram alerts when your strategy signals, to paper trade on live Binance prices, or to trade on Binance or Hyperliquid through CCXT, on their testnets or with real money. It compiles into standalone executables that run without Bun, and each [GitHub release](https://github.com/youtix/gekko/releases) comes with both, built for Linux x64: `gekko`, the bot, and `fox` (on another platform, build them with `bun run build:exec`).

Eight strategies come built in: a grid bot, and seven signal strategies that trade every pair you watch, sharing the currency among the pairs. Orders are MARKET, LIMIT or STICKY (a limit order that follows the best price), sized by an amount, a cost or a share of the free balance, and a trailing stop can protect a BUY. An analyzer measures a run's profit, return and risk, and a reporter adds each backtest's figures to a CSV file. On Telegram, one bot sends you the signals, the orders and the round trips and answers `/portfolio`, and a second one watches over Gekko's health.

Fox sweeps a strategy's parameters: give it a backtest configuration as a template and the values to try, as a list (`--strategy.period 12,24`) or a range (`--strategy.period 12..24:2`), and it backtests every combination side by side, each in a worker of its own, the PerformanceReporter of the template collecting their figures in one CSV file. See the [Fox guide](./documentation/fox.md).

---

## ⚠️ Disclaimer

**USE AT YOUR OWN RISK.**

Gekko is not financial advice software. The author is not responsible for any losses. Always test thoroughly with backtesting and paper trading before using real funds.

---

## Summary

- **[Quick Start](./documentation/quick-start.md)** — New to Gekko? Start here: install it, download price history, backtest a strategy and get Telegram alerts without an exchange API key, then trade on a testnet and, when you are ready, with real money.
- **[Modes](./documentation/modes.md)** — The three modes with their options: `importer` stores an exchange's 1-minute candles, `backtest` replays them on a simulated exchange, `realtime` sends alerts, paper trades or trades live; and how to run Gekko and stop it.
- **[Plugins](./documentation/plugins.md)** — The 8 plugins a configuration picks from, with their options, their events and the order to list them in: the TradingAdvisor, the Trader, two analyzers, the PerformanceReporter, the CandleWriter and two Telegram bots.
- **[Built-in Strategies](./documentation/built-in-strategies.md)** — What each built-in strategy does, with its parameters: seven signal strategies (DEMA, MACD, RSI, CCI, TMA, SMACrossover, EMARibbon) that trade every watched pair, and GridBot, which keeps a grid of LIMIT orders on the first pair.
- **[Custom Strategies](./documentation/custom-strategies.md)** — Write your own strategy in TypeScript: its interface and tools, the indicators it reads, its orders and trailing stops, the PositionTracker and PositionBook that keep its position, where it lives, how to run it, and troubleshooting.
- **[Technical Indicators](./documentation/indicators.md)** — Complete reference for the 31 built-in indicators, each with its parameters, its output and the candle of its first value, in six categories: moving averages, momentum, directional movement, oscillators, volatility and volume.
- **[Fox](./documentation/fox.md)** — Backtest every combination of the values you give a template configuration's keys, as lists or ranges, in parallel workers: Fox checks every variant first, and their figures land in one CSV file.
- **[Upgrading](./documentation/upgrading.md)** — Coming from version 2.0.0? The configuration keys, the executable and the commands that changed, what to do with your private strategies and old CSV files, and what the signal strategies now do differently.

---

## Repository

Gekko is a monorepo of [Bun workspaces](https://bun.sh/docs/pm/workspaces), whose tasks [Turborepo](https://turborepo.com/) runs, each package depending only on packages listed above it:

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
bun run dev:fox --template-path apps/fox/templates/dema.yml --strategy.period 12..24  # runs Fox from source, once config/importer.yml has imported the database its template reads (see the Fox guide)
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow: running the tests, the checks a pull request must pass and the commit messages.

This project adheres to a [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE)
