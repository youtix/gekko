# 📋 Modes

Gekko 2 operates in three distinct modes, each designed for a specific stage of your trading workflow. Understanding these modes is essential for effectively developing, testing, and deploying your trading strategies.

---

## Overview

| Mode         | Purpose                              | Data Source     | Execution Speed | Risk Level |
|--------------|--------------------------------------|-----------------|-----------------|------------|
| **Importer** | Collect historical market data       | Live exchange   | API-limited     | None       |
| **Backtest** | Simulate strategies on past data     | Local database  | Ultra-fast      | None       |
| **Realtime** | Live market monitoring and trading   | Live exchange   | Real-time       | Variable   |

---

## 📥 Importer Mode

**Purpose:** Fetch and store historical candle data from cryptocurrency exchanges into a local database.

### When to Use

- Before running backtests (backtesting requires historical data)
- To update your local data with the latest market information
- When switching to a new trading pair or exchange
- To fill gaps in your existing data

### How It Works

1. Gekko connects to the specified exchange's public API
2. Requests historical candle data for the configured trading pair
3. Downloads candles in batches (respecting API rate limits)
4. Stores data in the local SQLite database for future use

### Configuration

```yaml
watch:
  assets: [BTC]
  currency: USDT
  mode: importer
  tickrate: 500              # Milliseconds between API requests (rate limiting)
  daterange:
    start: '2024-01-01T00:00:00.000Z'
    end: '2024-12-01T00:00:00.000Z'

exchange:
  name: binance              # Exchange to fetch data from

storage:
  type: sqlite
  database: ./db/binance-BTC_USDT.sql
  # insertThreshold: 1000    # Optional: minutes of candles buffered before each write

plugins:
  - name: CandleWriter       # Required: saves candles to database
```

### Key Configuration Options

| Option                    | Description                                                      | Example Values                                                                           |
|---------------------------|------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| `assets`                  | The base assets to import, in upper case                         | `[BTC, ETH, SOL]`                                                                        |
| `currency`                | The quote currency, in upper case                                | `USDT`, `EUR`, `BTC`                                                                     |
| `tickrate`                | Delay between API calls (ms)                                     | `500` (recommended)                                                                      |
| `daterange.start`         | First minute of the range, included                              | `2024-01-01` (its midnight UTC), `'2024-01-01T00:00:00Z'`, `'2024-01-01T02:00:00+02:00'` |
| `daterange.end`           | Last minute of the range, included (equal bounds are one minute) | The same forms                                                                           |
| `storage.insertThreshold` | Optional: minutes of candles buffered before each write          | `1` to `1440` (a day); default `1000`, `1` in realtime                                   |

A `daterange` bound is a day, read as its midnight UTC, or a day and a time with `Z` or an offset, quoted or not: `end: 2024-12-31` reads only the first minute of December 31st, `2024-12-31T23:59:00Z` the whole day. A day that does not exist (`2023-02-29`), a time without `Z` or an offset, and a range that ends before the minute it starts in are refused at start-up. Write assets and the currency as the exchange lists them, in upper case (`BTC`, `1INCH`): `btc` is refused.

### Important Notes

> [!IMPORTANT]
> The `CandleWriter` plugin is **required** for importer mode. Without it, fetched data will not be saved.

> [!NOTE]
> Import duration depends on the date range and exchange. Large ranges (multiple years) can take several minutes.

> [!NOTE]
> An import replaces whatever the database already holds for the minutes the exchange returns, a minute without trades included; the candle it makes up for a minute the exchange lacks only replaces a stored candle that is made up too. A realtime run with `CandleWriter` only replaces a stored made-up candle, and only with a candle that traded. Re-importing therefore repairs the flat, zero-volume candles that a realtime run stores for the minutes it missed: re-import the ranges named by its `Total gap detected` and `Partial gap` warnings. A gap of more than 7 days in the exchange's history is not filled: the run stops with an error naming the gap.

> [!NOTE]
> On `hyperliquid` (importer or realtime), write a Unit-wrapped spot token by its token name in `watch.assets` (`UBTC`, `UETH`, `USOL`, `UPUMP`...), not by the coin it wraps: ccxt resolves the token name to its spot market, while a coin name only works when ccxt happens to name the market after it (`BTC/USDC` resolves, `PUMP/USDC` does not).

### Required Plugin

- **CandleWriter** — Saves imported candles to the configured database

---

## 📊 Backtest Mode

**Purpose:** Simulate trading strategies on historical data to evaluate performance without risking real money.

### When to Use

- Testing new strategy ideas
- Optimizing strategy parameters
- Comparing different strategies on the same data
- Validating strategy behavior before live deployment
- Analyzing performance metrics (profit/loss, drawdown, Sharpe ratio)

### How It Works

1. Gekko loads historical candles from the local database
2. Replays market data at high speed through your strategy
3. Simulates order execution via the `dummy-cex` exchange
4. Calculates comprehensive performance metrics
5. Outputs trade history and statistics

### Configuration

```yaml
watch:
  assets: [BTC]
  currency: USDT
  mode: backtest
  timeframe: 1h              # Candle timeframe for strategy
  warmup:
    candleCount: 365         # Candles needed before trading starts
  daterange:
    start: '2024-01-01T00:00:00.000Z'
    end: '2024-12-01T00:00:00.000Z'

exchange:
  name: dummy-cex            # Simulated exchange for backtesting
  marketData:                # Fees and order limits, one entry per watched pair
    - symbol: BTC/USDT
      marketData:
        price:
          min: 0.01
          max: 1000000
        amount:
          min: 0.00001
          max: 9000
        cost:
          min: 5
          max: 9000000
        precision:           # Decimals of a price and of an amount, a whole number (8 = steps of 0.00000001), not a step like 0.01
          price: 8
          amount: 8
        fee:
          maker: 0.0004
          taker: 0.0007
  simulationBalance:         # Starting balances: the watched assets and the currency only, each once
    - assetName: BTC
      balance: 0
    - assetName: USDT
      balance: 1000

storage:
  type: sqlite
  database: ./db/binance-BTC_USDT.sql

strategy:
  name: RSI
  src: ohlc4                 # Price source: open, high, low, close, hl2, hlc3 or ohlc4
  period: 21
  thresholds:
    high: 70
    low: 30
    persistence: 0

plugins:
  - name: TradingAdvisor     # Runs strategy and generates signals
    strategyName: RSI

  - name: Trader             # Executes simulated orders

  - name: RoundTripAnalyzer
    enableConsoleTable: true # Display results in terminal table
```

The simulator receives each order as the live exchange does: its amount truncated to the amount step (`precision.amount`), its price rounded half up to the price tick (`precision.price`). An amount truncated to 0, or whose cost falls under `cost.min`, is refused, and an order fills for the amount truncated. The cost is worked out in decimal, as the exchange works it out: an order costing exactly `cost.min` passes. For Hyperliquid, whose tick depends on the price, add `priceSignificantDigits: 5` under `precision`.

Write assets, the currency and symbols in upper case, as the exchange lists them (`BTC`, `1INCH`, `BTC/USDT`). Each `marketData` symbol, and each `initialTicker` one, appears once. `simulationBalance` lists only the watched assets and the currency, each once and spelt as in `watch`: a balance of any other asset (`usdt`, an asset not watched) is refused, the simulator never holding it.

### Key Configuration Options

| Option               | Description                  | Example Values                      |
|----------------------|------------------------------|-------------------------------------|
| `timeframe`          | Candle period for strategy   | `1m`, `5m`, `15m`, `1h`, `4h`, `1d` |
| `warmup.candleCount` | Candles before trading       | `100`, `365`, `1000`                |
| `exchange.name`      | Must be `dummy-cex`          | `dummy-cex`                         |
| `strategy.name`      | Strategy to backtest         | `RSI`, `DEMA`, `GridBot`, etc.      |

### Important Notes

> [!IMPORTANT]
> Always use `dummy-cex` as the exchange for backtesting. This simulated exchange handles order execution without real API calls.

> [!TIP]
> Set `warmup.candleCount` based on your strategy's indicator requirements. For example, a 200-period moving average needs at least 200 warmup candles. The strategy trades from the candle after the warmup, so `watch.daterange` must hold more whole `timeframe` candles than `warmup.candleCount`, counted from the first timeframe boundary at or after its start (in UTC: a `1w` candle starts on a Monday, a `1M` candle on the 1st); otherwise Gekko refuses the configuration.

> [!NOTE]
> Backtesting runs at maximum speed — years of data can be processed in seconds.

### Typical Plugins

| Plugin                  | Purpose                                             |
|-------------------------|-----------------------------------------------------|
| **TradingAdvisor**      | Runs your strategy and generates buy/sell signals   |
| **Trader**              | Executes orders on the dummy exchange               |
| **RoundTripAnalyzer**   | Calculates returns, win rate, Sharpe ratio, etc.    |

### Performance Metrics

The analyzers provide (configure `RoundTripAnalyzer` or `PortfolioAnalyzer`, not both):
- **Total Return** — Overall profit/loss percentage
- **Max Drawdown** — Largest peak-to-trough decline (`PortfolioAnalyzer`)
- **Longest Drawdown** — Duration of the longest drawdown period (`PortfolioAnalyzer`)
- **Sharpe Ratio** — Risk-adjusted return
- **Win Rate** — Percentage of profitable trades (`RoundTripAnalyzer`)
- **Trade Count** — Total number of executed trades (`RoundTripAnalyzer`)

---

## 🔴 Realtime Mode

**Purpose:** Connect to live markets for real-time monitoring, alerts, paper trading, or live automated trading.

### When to Use

- Monitoring markets for trading signals (screener)
- Paper trading with exchange testnets (sandbox)
- Live trading with real funds
- Automated portfolio supervision and alerts

### How It Works

1. Gekko connects to the exchange's WebSocket or REST API
2. Receives real-time candle updates as they form
3. Runs your strategy on each new candle
4. Optionally executes orders based on strategy signals
5. Sends notifications via Telegram (if configured)

### Use Cases

Realtime mode supports several use cases depending on your plugin configuration:

#### 1. Screener (Alerts Only)

Monitor markets and receive Telegram alerts when your strategy emits signals.

```yaml
watch:
  assets: [BTC]
  currency: USDT
  mode: realtime
  timeframe: 4h
  warmup:
    candleCount: 365

# It will simulate authenticated calls to the exchange (place orders, cancel orders, fetchBalance, etc.) 
# and use real unauthenticated data (fetchCandles, etc.)
exchange:
  name: paper-binance
  simulationBalance:             # Simulated balances, required by paper-binance: the watched assets and the currency only
    - assetName: BTC
      balance: 1
    - assetName: USDT
      balance: 10000

strategy:
  name: RSI
  period: 21
  thresholds:
    high: 70
    low: 30
    persistence: 0

plugins:
  - name: TradingAdvisor
    strategyName: RSI

  - name: Trader                 # Simulates the orders, whose end the strategy waits for (see below)

  - name: EventSubscriber        # Telegram alerts
    token: YOUR_BOT_TOKEN
    botUsername: YOUR_BOT_USERNAME
    # chatId: 123456789 # Optional: the chat the bot talks to; without it, the first chat that sends it a command after start-up is bound
```

> [!IMPORTANT]
> Keep the `Trader`, even for alerts: it is the only plugin that executes the orders the strategy creates, and every built-in strategy waits for its order to end (completed, canceled or errored) before it advises again. Without a Trader, the first order never ends, the strategy advises once per run, and Gekko warns at start-up (`warn` level, so set `GEKKO_LOG_LEVEL` to `warn` or `info` to see it). On `paper-binance` the orders are only simulated, from `simulationBalance`. `hyperliquid` has no paper exchange: there, the Trader places the orders on the account, or on its testnet with `sandbox: true`.

The alerts are the strategy's orders (`/sub_strat_create`) and its log lines at the `info`, `warn` and `error` levels (`/sub_strat_info`), the error line that stops the bot included; its `debug` lines are not sent.

#### 2. Sandbox Trading (Paper Money)

Test strategies with fake money on exchange testnets. Real orders are placed, but with virtual funds.

```yaml
watch:
  assets: [BTC]
  currency: USDT
  mode: realtime
  timeframe: 1d
  warmup:
    candleCount: 365

exchange:
  name: binance
  sandbox: true                  # Use testnet
  apiKey: YOUR_SANDBOX_API_KEY
  secret: YOUR_SANDBOX_API_SECRET

strategy:
  name: DEMA
  period: 12
  thresholds:
    up: 100
    down: -150

plugins:
  - name: TradingAdvisor
    strategyName: DEMA

  - name: Trader                 # Executes orders on sandbox

  - name: RoundTripAnalyzer
    riskFreeReturn: 5
```

> [!TIP]
> Get Binance testnet API keys at: https://testnet.binance.vision/

#### 3. Paper Trading (Local Simulation)

Trade with simulated money using **real market data** from Binance, but with orders executed locally. No API keys required for trading.

```yaml
watch:
  assets: [BTC]
  currency: USDT
  mode: realtime
  timeframe: 1h
  warmup:
    candleCount: 365

exchange:
  name: paper-binance            # Uses real Binance data, simulates orders locally
  simulationBalance:
    - assetName: BTC
      balance: 1                 # Starting BTC balance
    - assetName: USDT
      balance: 10000             # Starting USDT balance
  # feeOverride:                 # Optional: override exchange fees
  #   maker: 0.001
  #   taker: 0.002

strategy:
  name: DEMA
  period: 12
  thresholds:
    up: 100
    down: -150

plugins:
  - name: TradingAdvisor
    strategyName: DEMA

  - name: Trader

  - name: RoundTripAnalyzer
    enableConsoleTable: true
```

`simulationBalance` lists only the watched assets and the currency, each once and spelt as in `watch`: a balance of any other asset is refused, the simulator never holding it, and a watched one left out starts at 0. At start-up Gekko logs the portfolio the simulator starts with, at the `info` level: `Initial portfolio: 1 BTC, 10,000 USDT`.

| Feature              | Sandbox (`sandbox: true`)       | Paper Trading (`paper-binance`) |
|----------------------|---------------------------------|---------------------------------|
| Market data source   | Binance Testnet                 | Binance Mainnet (real prices)   |
| Order execution      | Real orders on testnet          | Simulated locally               |
| API keys required    | ✅ Testnet keys                 | ❌ Not required                 |
| Network dependency   | Requires testnet availability   | Only needs price feed           |
| Best for             | Testing order execution logic   | Quick strategy iteration        |

> [!TIP]
> Use `paper-binance` for rapid strategy testing with real market conditions. Switch to `sandbox` when you need to test actual order execution and API integration.

#### 4. Live Trading (Real Money)

> [!CAUTION]
> **REAL MONEY AT RISK.** Only use live trading if you fully understand the risks and have thoroughly tested your strategy via backtesting and sandbox trading.

```yaml
watch:
  assets: [BTC]
  currency: USDT
  mode: realtime
  timeframe: 1h
  warmup:
    candleCount: 365

exchange:
  name: binance
  apiKey: YOUR_LIVE_API_KEY
  secret: YOUR_LIVE_API_SECRET

strategy:
  name: DEMA
  period: 12
  thresholds:
    up: 100
    down: -150

plugins:
  - name: TradingAdvisor
    strategyName: DEMA

  - name: Trader

  - name: RoundTripAnalyzer
    riskFreeReturn: 5

  - name: EventSubscriber        # Get Telegram notifications
    token: YOUR_BOT_TOKEN
    botUsername: YOUR_BOT_USERNAME
    # chatId: 123456789 # Optional: the chat the bot talks to; without it, the first chat that sends it a command after start-up is bound

[I understand that Gekko only automates MY OWN trading strategies]: true
```

> [!NOTE]
> An exchange takes a limited amount in one order: on Binance, a `MARKET` order is held to MARKET_LOT_SIZE, tens of BTC on BTC/USDT, far below what `LIMIT` and `STICKY` orders can buy. The Trader caps a SELL, and an all-in BUY, at that maximum with a warning (`… above the maximum amount of a MARKET order on BTC/USDT: … sent, the rest stays held`), and the rest waits for a later order (see the Trader's [Sizing](./plugins.md#sizing)).

#### 5. Supervision Mode

Monitor your bot's health with Telegram commands and receive system alerts.

```yaml
plugins:
  - name: Supervision
    token: YOUR_BOT_TOKEN
    botUsername: YOUR_BOT_SECRET
    # chatId: 123456789 # Optional: the chat the bot talks to; without it, the first chat that sends it a command after start-up is bound
    cpuThreshold: 80             # Alert if CPU > 80%
    memoryThreshold: 1024        # Alert if memory > 1024 MB
    cpuCheckInterval: 10000      # Check every 10 seconds
    memoryCheckInterval: 10000
```

### Key Configuration Options

| Option             | Description                        | Values                              |
|--------------------|------------------------------------|-------------------------------------|
| `exchange.sandbox` | Use testnet instead of mainnet     | `true`, `false`                     |
| `exchange.apiKey`  | API key for authenticated requests | Your API key                        |
| `exchange.secret`  | API secret for signing requests    | Your API secret                     |
| `timeframe`        | Live candle period                 | `1m`, `5m`, `15m`, `1h`, `4h`, `1d` |

### Important Notes

> [!WARNING]
> The line `[I understand that Gekko only automates MY OWN trading strategies]: true` is **required** for any configuration that runs a `Trader` on a real exchange (`binance` or `hyperliquid` without `sandbox: true`), where orders spend real money: Gekko refuses to start without it. This confirms you understand that Gekko automates your strategy — it does not provide trading advice. Sandbox (`sandbox: true`), `paper-binance` and `dummy-cex` configurations do not need it.

> [!IMPORTANT]
> Never share your API keys. Use environment variables or a secure secrets manager in production.

### Available Plugins for Realtime

| Plugin                  | Description                                             |
|-------------------------|---------------------------------------------------------|
| **TradingAdvisor**      | Runs strategy and generates signals                     |
| **Trader**              | Executes orders on the exchange                         |
| **RoundTripAnalyzer**   | Tracks live performance metrics                         |
| **EventSubscriber**     | Sends trading events to Telegram                        |
| **Supervision**         | System monitoring and Telegram bot commands             |

---

## Mode Comparison

| Feature               | Importer      | Backtest     | Realtime         |
|-----------------------|---------------|--------------|------------------|
| Requires internet     | ✅ Yes        | ❌ No        | ✅ Yes           |
| Requires database     | ✅ Yes        | ✅ Yes       | ❌ Optional      |
| Required exchange     | Any supported | `dummy-cex`  | Any supported    |
| API keys needed       | ❌ No         | ❌ No        | 🔶 For trading   |
| Strategy required     | ❌ No         | ✅ Yes       | ✅ Yes           |
| Executes trades       | ❌ No         | ✅ Simulated | 🔶 Configurable  |
| Speed                 | API-limited   | Ultra-fast   | Real-time        |
| Risk                  | None          | None         | Low to High      |

---

## Workflow Recommendation

For the safest and most effective workflow, follow these steps:

```mermaid
graph LR
    A[1. Import Data] --> B[2. Backtest]
    B --> C[3. Sandbox Trade]
    C --> D[4. Live Trade]
    
    style A fill:#4CAF50,color:white
    style B fill:#2196F3,color:white
    style C fill:#FF9800,color:white
    style D fill:#f44336,color:white
```

1. **Import** historical data for your trading pair
2. **Backtest** your strategy to validate performance
3. **Sandbox trade** on a testnet to verify execution behavior
4. **Live trade** only after thorough testing and understanding of risks
