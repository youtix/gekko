![CI](https://github.com/youtix/gekko2/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/github/license/youtix/gekko2)
![Bun](https://img.shields.io/badge/runtime-bun-blue?logo=bun)
![TypeScript](https://img.shields.io/badge/language-typescript-blue?logo=typescript)
![Vitest](https://img.shields.io/badge/test-vitest-6E9F18?logo=vitest)

# Gekko 2

![Gordon Gekko](https://github.com/user-attachments/assets/769a2373-e22d-4b30-979f-09e636a49e4d)

_The most valuable commodity I know of is information._

— Gordon Gekko

## About

**Gekko 2** is a modular crypto trading bot framework for backtesting, alerting, paper trading, and live automated trading. Built with TypeScript and powered by [Bun](https://bun.sh/), it lets you develop, test, and deploy custom trading strategies on cryptocurrency markets.

---

## ⚠️ Disclaimer

**USE AT YOUR OWN RISK.**

Gekko 2 is not financial advice software. The author is not responsible for any losses. Always test thoroughly with backtesting and paper trading before using real funds.

---

## Summary

- **[Quick Start](./documentation/quick-start.md)** — Step-by-step instructions for importing data, backtesting, setting up alerts, sandbox trading, and live trading with real money.
- **[Modes](./documentation/modes.md)** — Gekko 2 operates in three modes that cover the complete trading workflow — from data collection to live trading.
- **[Built-in Strategies](./documentation/built-in-strategies.md)** — Comprehensive guide to all 8 built-in strategies: DEMA, MACD, RSI, CCI, TMA, SMACrossover, EMARibbon and GridBot, with configuration examples.
- **[Custom Strategies](./documentation/custom-strategies.md)** — Step-by-step guide to building your own external trading strategies, with full interface documentation, lifecycle methods, indicator usage, and deployment with the standalone executable.
- **[Technical Indicators](./documentation/indicators.md)** — Complete reference for 31 built-in indicators including moving averages (SMA, EMA, DEMA, WMA, TEMA), momentum (MACD, Stochastic), oscillators (RSI, CCI), volatility (ATR, Bollinger Bands), and volume indicators.
- **[Plugins](./documentation/plugins.md)** — Comprehensive guide to all 8 plugins including TradingAdvisor, Trader, PortfolioAnalyzer, RoundTripAnalyzer, PerformanceReporter, CandleWriter, EventSubscriber, and Supervision with configuration examples and event documentation.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

This project adheres to a [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE)
