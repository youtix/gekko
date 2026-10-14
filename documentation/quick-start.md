# 🚀 Quick Start Guide

Get Gekko 2 up and running in minutes. This guide walks you through from installation to live trading.

---

## 📦 1. Install

### Clone, Install Dependencies and Build the Executable

```bash
# Clone the repository
git clone https://github.com/youtix/gekko2.git

# Change directory
cd gekko2

# Install dependencies
bun install

# Compile Gekko into a standalone executable
bun run build:exec # This creates `dist/gekko2` — a single binary you can run anywhere without Bun installed.
```

### Configure with `.env`

Create a `.env` file to set your configuration path:

```bash
# .env
GEKKO_CONFIG_FILE_PATH=./config/backtest.yml
```

### Run Gekko

**Using the executable**:

```bash
# Load environment and run
source .env && ./dist/gekko2

# Or inline
GEKKO_CONFIG_FILE_PATH=./config/backtest.yml ./dist/gekko2
```

> **Tip:** Change `GEKKO_CONFIG_FILE_PATH` in `.env` to switch between modes (importer, backtest, realtime).

---


## 📥 2. Retrieve Historical Data

Before backtesting, you need historical candle data from an exchange.

**Create** `config/importer.yml`:

```yaml
watch:
  assets: [BTC]
  currency: USDT
  mode: importer
  daterange:
    start: '2024-01-01T00:00:00.000Z'
    end: '2024-12-01T00:00:00.000Z'

exchange:
  name: binance

storage:
  type: sqlite
  database: ./db/binance-BTC_USDT.sql

plugins:
  - name: CandleWriter
```

**Run the importer:**

```bash
GEKKO_CONFIG_FILE_PATH=./config/importer.yml ./dist/gekko2
```

This downloads candles from Binance and stores them locally. Duration depends on date range.

---

## 📊 3. Backtest a Strategy

Test your strategy on historical data without risking real money.

**Create** `config/backtest.yml`:

```yaml
watch:
  assets: [BTC]
  currency: USDT
  mode: backtest
  timeframe: 1h
  warmup:
    candleCount: 365
  daterange:
    start: '2024-01-01T00:00:00.000Z'
    end: '2024-12-01T00:00:00.000Z'

exchange:
  name: dummy-cex
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
  simulationBalance:         # Starting balances
    - assetName: BTC
      balance: 0
    - assetName: USDT
      balance: 1000

storage:
  type: sqlite
  database: ./db/binance-BTC_USDT.sql

strategy:
  name: RSI
  src: ohlc4
  period: 21
  thresholds:
    high: 70
    low: 30
    persistence: 0

plugins:
  - name: TradingAdvisor
    strategyName: RSI
  - name: Trader
  - name: RoundTripAnalyzer
    enableConsoleTable: true
```

The simulator receives each order as the live exchange does: its amount truncated to the amount step (`precision.amount`), its price rounded half up to the price tick (`precision.price`). An amount truncated to 0, or whose cost falls under `cost.min`, is refused, and an order fills for the amount truncated. The cost is worked out in decimal, as the exchange works it out: an order costing exactly `cost.min` passes. For Hyperliquid, whose tick depends on the price, add `priceSignificantDigits: 5` under `precision`.

Write assets, the currency and symbols in upper case, as the exchange lists them (`BTC`, `1INCH`, `BTC/USDT`), each `marketData` symbol once. `simulationBalance` lists only the watched assets and the currency, each once and spelt as in `watch`: a balance of any other asset is refused, the simulator never holding it.

**Run the backtest:**

```bash
GEKKO_CONFIG_FILE_PATH=./config/backtest.yml ./dist/gekko2
```

You'll see trade history and performance metrics (profit/loss, win rate, Sharpe ratio, etc).

---

## 🔔 4. Screener (Realtime Alerts)

Monitor the market and receive Telegram alerts when your strategy signals. No API key is needed: the `paper-binance` exchange reads Binance's public market data and simulates the orders locally.

**Create** `config/screener.yml`:

```yaml
watch:
  assets: [BTC]
  currency: USDT
  mode: realtime
  timeframe: 4h
  warmup:
    candleCount: 365

exchange:
  name: paper-binance        # Real Binance prices, simulated orders: no API key
  simulationBalance:         # Simulated balances, required by paper-binance: the watched assets and the currency only
    - assetName: BTC
      balance: 1
    - assetName: USDT
      balance: 10000

strategy:
  name: RSI
  src: ohlc4
  period: 21
  thresholds:
    high: 70
    low: 30
    persistence: 0

plugins:
  - name: TradingAdvisor
    strategyName: RSI

  - name: Trader             # Fills the orders on paper: every built-in strategy waits for its order to end before it signals again

  - name: EventSubscriber
    token: YOUR_TELEGRAM_BOT_TOKEN
    botUsername: YOUR_BOT_USERNAME
    # chatId: 123456789 # Optional: the chat the bot talks to; without it, the first chat that sends it a command after start-up is bound
```

**Run the screener:**

```bash
GEKKO_CONFIG_FILE_PATH=./config/screener.yml ./dist/gekko2
```

Gekko watches the market and sends Telegram messages when buy/sell signals trigger. No real trades are executed: the orders are only simulated, on the `simulationBalance` portfolio. Keep the `Trader` all the same: without it no order ever ends, so the strategy signals once per run, and Gekko warns at start-up (a `warn` line, which `GEKKO_LOG_LEVEL=warn` shows).

---

## 🧪 5. Sandbox Trading (Testnet)

Test your strategy with fake money on an exchange's testnet.

**Create** `config/sandbox.yml`:

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
  sandbox: true
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

  - name: Trader

  - name: RoundTripAnalyzer
    riskFreeReturn: 5
```

**Get sandbox API keys:**
- Binance Testnet: https://testnet.binance.vision/

**Run sandbox trading:**

```bash
GEKKO_CONFIG_FILE_PATH=./config/sandbox.yml ./dist/gekko2
```

Real orders are placed on the testnet with fake funds. Perfect for validating your strategy behavior.

---

## 💰 6. Live Trading (Real Money)

> ⚠️ **WARNING:** You can lose money. Only proceed if you understand the risks and have tested thoroughly.

**Create** `config/live.yml`:

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

  - name: EventSubscriber
    token: YOUR_TELEGRAM_BOT_TOKEN
    botUsername: YOUR_BOT_USERNAME
    # chatId: 123456789 # Optional: the chat the bot talks to; without it, the first chat that sends it a command after start-up is bound

[I understand that Gekko only automates MY OWN trading strategies]: true
```

The last line is the disclaimer that takes you live: Gekko refuses to start a `Trader` on a real exchange until you set it to `true` yourself, confirming that it only automates your own strategy. The sandbox and screener configurations above risk no real money and do not need it.

**Run live trading:**

```bash
GEKKO_CONFIG_FILE_PATH=./config/live.yml ./dist/gekko2
```

Gekko executes real trades with real money. Monitor closely and use stop-losses.

---

## 📋 Summary

| Step | Mode       | Config       | What it does               |
|------|------------|--------------|----------------------------|
| 1    | —          | —            | Install & Build Gekko      |
| 2    | `importer` | importer.yml | Download historical data   |
| 3    | `backtest` | backtest.yml | Simulate trades on history |
| 4    | `realtime` | screener.yml | Get alerts, no trading     |
| 5    | `realtime` | sandbox.yml  | Fake money, real orders    |
| 6    | `realtime` | live.yml     | Real money trading         |

---

## Next Steps

- Explore the [built-in strategies](./built-in-strategies.md), whose code is in `src/strategies/`
- Write your own with the [Custom Strategies](./custom-strategies.md) guide: a file of your own anywhere, loaded through the TradingAdvisor's `strategyPath`, or a private strategy kept in your checkout's `src/strategies/custom/`, exported from its `index.ts`
- Adjust strategy parameters and backtest again
- Set up Telegram monitoring with EventSubscriber or Supervision plugins
