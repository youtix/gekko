# 🚀 Quick Start Guide

Get Gekko up and running in minutes. This guide walks you through from installation to live trading.

---

## 📦 1. Install

### Clone, Install Dependencies and Build the Executable

```bash
# Clone the repository
git clone https://github.com/youtix/gekko.git

# Change directory
cd gekko

# Install dependencies
bun install

# Compile Gekko into a standalone executable
bun run build:exec # This creates `dist/gekko` — a single binary you can run anywhere without Bun installed.
```

Run every command of this guide from the root of the checkout, the `gekko` directory: the executable reads `.env` and `.env.local` from the directory it runs in, and the paths that `GEKKO_CONFIG_FILE_PATH` and the configurations name (`./config/…`, `./db/…`) are relative to it.

### Configure with `.env.local`

Gekko takes no command-line option: two environment variables decide what it runs. **Create** `.env.local`, which git ignores, to set them (`.env` is a file of the repository, tracked by git: leave it as it is):

```bash
# .env.local
# The configuration to run (step 3 writes this one): its watch.mode picks importer, backtest or realtime
GEKKO_CONFIG_FILE_PATH=./config/backtest.local.yml
# What Gekko prints, from the most severe level down to this one: error (the default), warn, info, debug
GEKKO_LOG_LEVEL=info
```

At the default `error` level, Gekko prints its logo, its errors and the tables of an analyzer whose `enableConsoleTable` is set, and nothing else: the import of step 2 runs for minutes without a line, and the realtime runs of steps 4 to 6 print nothing while they follow the market. At `info`, it logs the progress of each download, the orders and the round trips, one JSON line per message.

### Run Gekko

**Using the executable**:

```bash
# Runs the configuration that .env.local names
./dist/gekko

# Or name it on the command line, which wins over .env and .env.local
GEKKO_CONFIG_FILE_PATH=./config/backtest.local.yml ./dist/gekko
```

The executable loads `.env`, then `.env.local`, by itself: there is nothing to `source`. A variable set on the command line, or exported in your shell, wins over both files.

> **Tip:** To switch between modes (importer, backtest, realtime), point `GEKKO_CONFIG_FILE_PATH` at another configuration: in `.env.local` for every run, or on the command line for one run, as the steps below do. Not in `.env`, which `.env.local` overrides.

### Keep Your Configurations Out of Git

Each step below has you write a configuration. Save it in `config/` under a name that ends in `.local.yml`, as the steps do: git ignores every `config/*.local.*` file, so neither your settings nor the keys and tokens of steps 4 to 6 can be committed by mistake, and the examples git tracks in `config/` (`importer.yml`, `backtest.yml`, the `realtime-*.yml` files, …) stay untouched, for `git pull` to update them without a conflict. To start from one of those examples instead, copy it to such a name first (`cp config/realtime-trader.yml config/realtime-trader.local.yml`) and edit the copy.

---

## 📥 2. Retrieve Historical Data

Before backtesting, you need historical candle data from an exchange.

**Create** `config/importer.local.yml`:

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
GEKKO_CONFIG_FILE_PATH=./config/importer.local.yml ./dist/gekko
```

This downloads the 1-minute candles of BTC/USDT from Binance, from 2024-01-01 00:00 to 2024-12-01 00:00 UTC, both minutes included, and stores them in `./db/binance-BTC_USDT.sql`, creating the `db/` directory, which git ignores. An import reads public market data only: it needs no API key. It takes about 8 minutes: Binance answers 1000 minutes per request, and `watch.tickrate` spaces the requests at least 1000 ms apart by default. At the `info` level, Gekko logs its progress at every percent; at `error`, it prints its logo and nothing more.

A minute Binance has no candle for, between two it has, is stored as a flat candle without volume, up to 7 days in a row. A longer gap stops the import with an error naming the pair and the gap, before it writes a flat candle of that gap, and a pair whose history ends before the range does keeps its last minutes missing, with a warning saying how many. Only closed minutes are imported: an `end` at or after the minute in progress is moved back to the last closed minute, with a warning.

---

## 📊 3. Backtest a Strategy

Test your strategy on historical data without risking real money.

**Create** `config/backtest.local.yml`:

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
GEKKO_CONFIG_FILE_PATH=./config/backtest.local.yml ./dist/gekko
```

The backtest replays the candles of step 2: the same database, over the same range, 2024-01-01 00:00 to 2024-12-01 00:00 UTC. It refuses to start when a minute of its `daterange` is missing from the database (`Missing candles in database: …`, followed by the ranges the database holds), so a range of your own must lie within the minutes you imported; without the import, it stops at once (`Cannot open the database …`). The first 365 candles of 1 hour go to the warmup (`warmup.candleCount` counts timeframe candles), and the strategy only trades after them.

With `enableConsoleTable: true`, the RoundTripAnalyzer prints each round trip as a table when it closes and, at the end of the backtest, the report of the whole run (net profit, total and market return, win rate, Sharpe and Sortino ratios, …), whatever `GEKKO_LOG_LEVEL`.

---

## 🔔 4. Screener (Realtime Alerts)

Monitor the market and receive Telegram alerts when your strategy signals. No API key is needed: the `paper-binance` exchange reads Binance's public market data and simulates the orders locally.

**Get a Telegram bot:** create one with Telegram's [@BotFather](https://t.me/BotFather), which gives you its token and its username.

**Create** `config/screener.local.yml`, with your bot's token and username:

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
GEKKO_CONFIG_FILE_PATH=./config/screener.local.yml ./dist/gekko
```

**Subscribe from your chat.** Once Gekko runs, send the bot `/subscribe_all`, and again after every restart: the EventSubscriber sends nothing until its chat subscribes, and keeps its subscriptions in memory only. The bot answers `Subscribed to all events` (`/sub_strat_create` subscribes to the signals alone, and `/start` lists every command). Without `chatId`, the bot binds itself to the first chat that sends it a command after start-up, and drops the commands sent before; Gekko logs that chat's id at the `info` level, for you to set as `chatId`. With `chatId` set, a command your chat sent while Gekko was not running is handled as it starts.

Gekko first downloads the warmup, 365 candles of 4 hours (about a minute and a half at the default `warmup.tickrate`), then follows the market minute by minute. The strategy decides on the close of each 4-hour candle (00:00, 04:00, … UTC), and Gekko sends a Telegram message when a buy/sell signal triggers. No real trades are executed: the orders are only simulated, on the `simulationBalance` portfolio. Keep the `Trader` all the same: without it no order ever ends, so the strategy signals once per run, and Gekko warns at start-up (a `warn` line, which the `warn` and `info` levels show).

---

## 🧪 5. Sandbox Trading (Testnet)

Test your strategy with fake money on an exchange's testnet.

**Create** `config/sandbox.local.yml`, with your testnet keys:

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

Gekko reads the keys from this file only, exactly as written: it expands no environment variable in it (`apiKey: ${BINANCE_API_KEY}` is read as that very text), so the file holds them in clear. Keep them in a `config/*.local.*` file, which git ignores, and never in a file git tracks, such as `config/realtime-sandbox-trader.yml`: a `git commit -a` would commit them.

**Get sandbox API keys:**
- Binance Testnet: https://testnet.binance.vision/

**Run sandbox trading:**

```bash
GEKKO_CONFIG_FILE_PATH=./config/sandbox.local.yml ./dist/gekko
```

Real orders are placed on the testnet with fake funds. Perfect for validating your strategy behavior. At the `info` level, Gekko logs the warmup download (365 hours of minutes, about 20 seconds), then each order, and each round trip as it closes.

**Stopping it.** Ctrl-C closes the storage and exits (code 130) without finalising the plugins, so the RoundTripAnalyzer's report of the whole run (win rate, Sharpe and Sortino ratios, …) is not printed: it comes only when a failure or the circuit breaker stops the run, the round trips having been logged one by one as they closed. However Gekko stops, an order still open stays on the exchange (DEMA places STICKY orders, limit orders that follow the price): Gekko cancels none, and the next run does not follow it. Check the open orders on the exchange after you stop Gekko.

---

## 💰 6. Live Trading (Real Money)

> ⚠️ **WARNING:** You can lose money. Only proceed if you understand the risks and have tested thoroughly.

**Create** `config/live.local.yml`, with your live keys and your bot's token and username:

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

'I understand that Gekko only automates MY OWN trading strategies': true
```

As in step 5, Gekko reads the keys from this file only: keep them in this ignored file, never in a file git tracks, such as `config/realtime-trader.yml`. Gekko only reads your account and trades: a key that can trade but not withdraw is enough.

The last line, at the top level of the file, outside every section, is the disclaimer that takes you live: Gekko refuses to start a `Trader` on a real exchange until you set it to `true` yourself, confirming that it only automates your own strategy. The sandbox and screener configurations above risk no real money and do not need it.

**Run live trading:**

```bash
GEKKO_CONFIG_FILE_PATH=./config/live.local.yml ./dist/gekko
```

Gekko executes real trades with real money. Monitor closely and use stop-losses. Once Gekko runs, send the bot `/subscribe_all`, and again after every restart, as in step 4. Stopped with Ctrl-C, it prints no final report, and however it stops, it cancels no open order (see step 5): check your open orders on the exchange.

---

## 📋 Summary

| Step | Mode       | Config             | What it does               |
|------|------------|--------------------|----------------------------|
| 1    | —          | .env.local         | Install & Build Gekko      |
| 2    | `importer` | importer.local.yml | Download historical data   |
| 3    | `backtest` | backtest.local.yml | Simulate trades on history |
| 4    | `realtime` | screener.local.yml | Get alerts, no trading     |
| 5    | `realtime` | sandbox.local.yml  | Fake money, real orders    |
| 6    | `realtime` | live.local.yml     | Real money trading         |

---

## Next Steps

- Explore the [built-in strategies](./built-in-strategies.md), whose code is in `src/strategies/`
- Write your own with the [Custom Strategies](./custom-strategies.md) guide: a file of your own anywhere, loaded through the TradingAdvisor's `strategyPath`, or a private strategy kept in your checkout's `src/strategies/custom/`, exported from its `index.ts`
- Adjust strategy parameters and backtest again, over the range you imported or inside it (import another range first to test on other dates)
- Set up Telegram monitoring with the EventSubscriber or Supervision plugins, each on a bot of its own (two plugins on one token conflict, with HTTP 409 errors). Supervision starts subscribed to nothing, and runs no check, so sends no alert, until its chat subscribes: send `/subscribe_all` to each bot once Gekko runs, and again after every restart
