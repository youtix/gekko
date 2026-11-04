# 🚀 Quick Start Guide

Get Gekko up and running in minutes. This guide walks you through from installation to live trading.

You need: [Bun](https://bun.sh/docs/installation) (the repository pins 1.4.4, which CI builds with) and git, a POSIX shell (Linux, macOS, or WSL on Windows: the commands set variables as `VAR=value command`), and for the last steps a Telegram account (steps 4 and 6), a Binance testnet account (step 5) and a Binance account (step 6). Node.js is only needed to run the tests (see [CONTRIBUTING](../CONTRIBUTING.md)).

---

## 📦 1. Install

```bash
# Clone the repository
git clone https://github.com/youtix/gekko.git

# Change directory
cd gekko

# Install dependencies
bun install

# Compile Gekko and Fox into standalone executables
bun run build:exec
```

`bun run build:exec` creates `dist/gekko`, a single binary that runs without Bun on any machine of the system and architecture it was built on, and `dist/fox`, the parameter sweeper of the [Fox](./fox.md) guide.

Run every step's command from the root of the checkout, the `gekko` directory, where the paths `./config/…` and `./db/…` start: each names its configuration in front of the executable (`GEKKO_CONFIG_FILE_PATH=<file> ./dist/gekko`). Save each configuration as `config/<name>.local.yml`, which git ignores.

By default Gekko prints its logo, its errors and the tables of an analyzer with `enableConsoleTable`; put `GEKKO_LOG_LEVEL=info` in front of a command to follow its progress. At `info`, it also logs the progress of each download, each order and round trip (some 270 lines in step 3's backtest, beside its tables) and, in steps 4 to 6, the Trader's read of the balances every 10 minutes.

Apart from its logo and what an analyzer prints with `enableConsoleTable`, each line Gekko prints is one JSON object, its text the `message`, where a line break is written `\n`. The levels run from `error`, the default, through `warn` and `info` to `debug` (see [Logs and Exit Codes](./modes.md#logs-and-exit-codes)), and both variables can also be set in a `.env.local` file (see [Environment Variables](./modes.md#environment-variables)).

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

This downloads the 1-minute candles of BTC/USDT from Binance, from 2024-01-01 00:00 to 2024-12-01 00:00 UTC, both minutes included, and stores them in `./db/binance-BTC_USDT.sql`, creating the `db/` directory, which git ignores. An import reads public market data only: it needs no API key. It takes about 8 minutes; put `GEKKO_LOG_LEVEL=info` in front of the command to see its progress at every percent.

A minute Binance lacks is stored as a flat candle; see [Importer Mode](./modes.md#-importer-mode) for gaps of more than 7 days, for pairs listed or delisted within the range, and for an `end` that is not past yet.

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

`marketData` gives the simulator the fees and order limits of each watched pair, which it applies as the exchange would (see [Backtest Mode](./modes.md#-backtest-mode)). Write assets, the currency and symbols in upper case, as `watch` does.

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
GEKKO_LOG_LEVEL=info GEKKO_CONFIG_FILE_PATH=./config/screener.local.yml ./dist/gekko
```

**Subscribe from your chat.** Once Gekko runs, send the bot `/subscribe_all`, and again after every restart: it sends nothing until its chat subscribes, and answers `Subscribed to all events`. `/portfolio` shows the balances the Trader read last, at any time. Without `chatId`, the bot belongs to the first chat that sends it a command, whoever that is: at the `info` level, which the command above sets, Gekko logs your chat's id (`set chatId: <id>`); set it as `chatId` before step 6 (see [EventSubscriber](./plugins.md#-eventsubscriber)).

Gekko first downloads the warmup, 365 candles of 4 hours (about a minute and a half at the default `warmup.tickrate`), then follows the market minute by minute. The strategy decides on the close of each 4-hour candle (00:00, 04:00, … UTC), and Gekko sends a Telegram message when a buy/sell signal triggers. No real trades are executed: the orders are only simulated, on the `simulationBalance` portfolio. Stop it with Ctrl-C (see [Stopping and Restarting a Live Run](./modes.md#stopping-and-restarting-a-live-run)).

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
```

Gekko reads the keys from this file only, exactly as written: it expands no environment variable in it (`apiKey: ${BINANCE_API_KEY}` is read as that very text), so the file holds them in clear. Keep them in a `config/*.local.*` file, which git ignores, and never in a file git tracks, such as `config/realtime-sandbox-trader.yml`: a `git commit -a` would commit them.

**Get sandbox API keys:**
- Binance Testnet: https://testnet.binance.vision/

**Run sandbox trading:**

```bash
GEKKO_CONFIG_FILE_PATH=./config/sandbox.local.yml ./dist/gekko
```

Real orders are placed on the testnet with fake funds. Perfect for validating your strategy behavior. At the `info` level, Gekko logs the warmup download (365 hours of minutes, about 20 seconds), then each order, and each round trip as it closes.

**Stopping it.** Ctrl-C stops Gekko at once, without the RoundTripAnalyzer's report of the whole run (at the `info` level, each round trip was logged as it closed). However Gekko stops, it cancels no order, and the next run does not follow the ones left open: check the open orders on the exchange (see [Stopping and Restarting a Live Run](./modes.md#stopping-and-restarting-a-live-run)).

---

## 💰 6. Live Trading (Real Money)

> ⚠️ **WARNING:** You can lose money. Only proceed if you understand the risks and have tested thoroughly.

**Create** `config/live.local.yml`, with your live keys, your bot's token and username, and your chat id:

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

  - name: EventSubscriber
    token: YOUR_TELEGRAM_BOT_TOKEN
    botUsername: YOUR_BOT_USERNAME
    chatId: 123456789 # Your chat id, logged at step 4: the only chat the bot answers

'I understand that Gekko only automates MY OWN trading strategies': true
```

As in step 5, Gekko reads the keys from this file only: keep them in this ignored file, never in a file git tracks, such as `config/realtime-trader.yml`. Gekko only reads your account and trades: a key that can trade but not withdraw is enough.

The last line, at the top level of the file, outside every section, is the disclaimer that takes you live: Gekko refuses to start a `Trader` on a real exchange until you set it to `true` yourself, confirming that it only automates your own strategy. The sandbox and screener configurations above risk no real money and do not need it.

**Run live trading:**

```bash
GEKKO_CONFIG_FILE_PATH=./config/live.local.yml ./dist/gekko
```

Gekko executes real trades with real money. DEMA trades the whole free balance of its pair: each BUY spends the free USDT (5 % kept back for the fee), each SELL sells all the free BTC, coins you held before included. It places no stop-loss, and a stop order you place by hand on Binance holds the BTC its SELL would sell: that SELL is refused, DEMA takes itself for flat and buys again at its next signal. Run it on an account holding only what you mean it to trade, and monitor it closely (see [Pairs and Capital](./built-in-strategies.md#pairs-and-capital); a strategy of your own can protect each BUY with a [trailing stop](./custom-strategies.md#trailing-stops), which lasts as long as the run).

Once Gekko runs, send the bot `/subscribe_all`, and again after every restart, as in step 4. As in step 5, Ctrl-C stops it without the final report, and however it stops, it cancels no order: check your open orders on the exchange (see [Stopping and Restarting a Live Run](./modes.md#stopping-and-restarting-a-live-run)).

---

## If a Step Fails

Each error below is the `message` of one JSON line, which Gekko prints at every level:

- `Cannot read the configuration file <path>: ENOENT: …`: no file at that path, a typo in it or a command run outside the root of the checkout.
- `Invalid configuration file <path>:`, then each problem after a `✖`, with the key at fault after `→ at` (`→ at watch.assets[0]` for an asset written `btc`). `Invalid YAML in configuration file <path>: …`: a fault in the YAML itself, such as a bad indentation, at the line and column it names.
- `Cannot open the database …` or `Missing candles in database: …`: the backtest of step 3 finds no database at `storage.database`, or not every minute of its range in it (see [Troubleshooting](./custom-strategies.md#cannot-open-the-database--or-missing-candles-in-database)).
- The Telegram bot does not answer: see the `chatId` note of the [EventSubscriber](./plugins.md#-eventsubscriber).

---

## 📋 Summary

| Step | Mode       | Config             | What it does               |
|------|------------|--------------------|----------------------------|
| 1    | —          | —                  | Install & Build Gekko      |
| 2    | `importer` | importer.local.yml | Download historical data   |
| 3    | `backtest` | backtest.local.yml | Simulate trades on history |
| 4    | `realtime` | screener.local.yml | Get alerts, no trading     |
| 5    | `realtime` | sandbox.local.yml  | Fake money, real orders    |
| 6    | `realtime` | live.local.yml     | Real money trading         |

---

## Next Steps

- Explore the [built-in strategies](./built-in-strategies.md)
- Write your own with the [Custom Strategies](./custom-strategies.md) guide: a file of your own anywhere, loaded through the TradingAdvisor's `strategyPath`, or a private strategy kept in your checkout's `packages/strategies/src/custom/`, exported from its `index.ts`
- Adjust strategy parameters and backtest again, over the range you imported or inside it (import another range first to test on other dates), or let [Fox](./fox.md) backtest every combination of the values you list, side by side
- Watch over a running Gekko from Telegram with the [Supervision](./plugins.md#-supervision) plugin, on a bot of its own: CPU and memory alerts, a check that the candles keep coming, and its warnings and errors, forwarded
