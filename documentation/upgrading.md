# Upgrading from Gekko 2

This guide takes a setup of Gekko 2.0.0, the last release made under the name Gekko 2, to this version of Gekko: the checkout, the executables, the configuration files, the private strategies, and what now trades differently. Gekko refuses a configuration file of Gekko 2 until it is rewritten, and a configuration it accepts again can still trade otherwise than it did: read the guide to the end before you restart a live run.

---

## Table of Contents

- [1. Before You Start](#1-before-you-start)
- [2. Update Your Checkout](#2-update-your-checkout)
- [3. Rebuild the Executables](#3-rebuild-the-executables)
- [4. Rewrite Your Configuration](#4-rewrite-your-configuration)
  - [The `watch` Section](#the-watch-section)
  - [The `exchange` Section](#the-exchange-section)
  - [The Strategy Block and the Plugins](#the-strategy-block-and-the-plugins)
  - [Values Gekko Checks Now](#values-gekko-checks-now)
- [5. Move Your Private Strategies](#5-move-your-private-strategies)
- [6. Check What Trades Differently](#6-check-what-trades-differently)
- [The Release Notes](#the-release-notes)

---

## 1. Before You Start

- **Stop Gekko 2**, if it is running. Its orders still open on Binance or Hyperliquid stay there, holding what they reserved: Gekko neither cancels them nor follows them once you start it, and Gekko's signal strategies start flat, whatever the account holds (see [Stopping and Restarting a Live Run](./modes.md#stopping-and-restarting-a-live-run)). GridBot now refuses to start while any order is open on its pair: cancel the grid Gekko 2 left on the exchange before you start it again (see GridBot's [Restarting](./built-in-strategies.md#restarting)).
- **Back up your files**: your configuration files and `.env`, the strategies of `src/strategies/custom/`, your databases (`db/`) and the CSV files of the PerformanceReporter (`performance_reports.csv` by default). The steps below keep them all, but a copy costs nothing.
- **Check your Bun**: Gekko needs Bun 1.3 or later, and the repository pins 1.4.4, with which the release executables are built (`bun --version`; `bun upgrade` installs the latest).

Your SQLite databases keep working: Gekko reads the table of each pair as Gekko 2 wrote it, so a range Gekko 2 imported needs no new import.

---

## 2. Update Your Checkout

Gekko 2's quick start had you write your configurations over the examples of `config/`, which git tracks. Every one of them has changed since, and so has the placeholder of your private strategies, `src/strategies/custom/index.ts`, which moved: `git pull` refuses to overwrite such a file you edited, and stops:

```text
error: Your local changes to the following files would be overwritten by merge:
	config/backtest.yml
	src/strategies/custom/index.ts
Please commit your changes or stash them before you merge.
Aborting
```

Keep your edits in files git ignores: a copy of a configuration named `config/<name>.local.yml`, and `.env.local` for your environment variables. Copy your edits there, put the tracked files back as Gekko 2 shipped them, then pull and install:

```bash
cp config/backtest.yml config/backtest.local.yml     # the same for each file of config/ you edited
cp src/strategies/custom/index.ts ../custom-index.ts  # the exports of your strategies, for step 5
git checkout -- config/ src/strategies/custom/index.ts
git pull
bun install
```

- Rename each configuration of your own in `config/` to `config/<name>.local.yml` too, such as the `config/screener.yml`, `config/sandbox.yml` and `config/live.yml` that Gekko 2's quick start had you create: they hold your keys, and git ignores the `.local.` files only.
- Move the values you set in `.env` (`GEKKO_CONFIG_FILE_PATH`, `GEKKO_LOG_LEVEL`) to `.env.local`, whose values win over those of `.env`, then put `.env` back with `git checkout -- .env`: the pull keeps your `.env`, unchanged since Gekko 2, but a later one may not (see [Environment Variables](./modes.md#environment-variables)).
- The repository is now `youtix/gekko`. GitHub redirects the old name to it, so the pull works as it is; `git remote set-url origin https://github.com/youtix/gekko.git` names the new one.

`bun install` also marks the new placeholder of your strategies, `packages/strategies/src/custom/index.ts`, so that git leaves your edits of it out (see [Where Your Strategy Lives](./custom-strategies.md#where-your-strategy-lives)).

---

## 3. Rebuild the Executables

The executable is now `dist/gekko`, and a second one, `dist/fox`, comes with it. `bun run build:exec` builds both and deletes nothing, so delete Gekko 2's builds yourself:

```bash
rm -f dist/gekko2 dist/gekko2.js   # Gekko 2's executable, and the bundle bun run start ran
bun run build:exec                 # writes dist/gekko and dist/fox
```

- Run `./dist/gekko` where your scripts, cron jobs and systemd units ran `./dist/gekko2`. It reads `.env` and `.env.local`, and resolves a relative path (`GEKKO_CONFIG_FILE_PATH`, `storage.database`, `strategyPath`), from the directory it runs in: start it from your checkout, or give a unit that `WorkingDirectory`. Drop the `source .env` of Gekko 2's quick start: Gekko reads both files itself, and a variable of the shell wins over them (see [Environment Variables](./modes.md#environment-variables)).
- When the circuit breaker stops Gekko (see [6. Check What Trades Differently](#6-check-what-trades-differently)), it exits with code 0, so that a supervisor that restarts it on failure leaves it stopped (see [Logs and Exit Codes](./modes.md#logs-and-exit-codes)).
- `bun run start` and `bun run build:js` are gone: `bun run dev` runs Gekko from source, from the root of the checkout, and `bun run build:exec` builds the executables.
- Each GitHub release now comes with both executables, built for Linux x64, under the names `gekko` and `fox`: `https://github.com/youtix/gekko/releases/latest/download/gekko` downloads the latest bot. On another system, build them with `bun run build:exec`.
- Fox is new: it backtests the variants of a configuration side by side, to sweep a strategy's parameters (see the [Fox guide](./fox.md)).

---

## 4. Rewrite Your Configuration

Gekko now checks every section of a configuration file and refuses a key it does not know, where Gekko 2 dropped it without a word. So it refuses a configuration of Gekko 2 until you rewrite it, with a message that lists every issue with its path (the `message` of one JSON line, its `\n` shown here as line breaks):

```text
[CONFIGURATION] Invalid configuration file ./config/backtest.local.yml:
✖ Unrecognized key: "asset"
  → at watch
✖ Invalid input: expected array, received undefined
  → at watch.assets
✖ Invalid input: expected array, received undefined
  → at exchange.simulationBalance
```

It is often quicker to copy the example of `config/` closest to your file to `config/<name>.local.yml`, and to bring your values over: each example is valid once its keys are filled in, and `config/realtime-trader.yml` once its disclaimer is set to `true`. The changes, section by section:

### The `watch` Section

- `asset: BTC` is now `assets: [BTC]`, a list of 1 to 20 assets.
- `timeframe` is required in backtest and realtime mode: Gekko 2 used `1m` without one.
- `fillGaps` is gone: an import and a realtime run always fill the minutes the exchange skipped with flat candles, up to 7 days of them (see [Importer Mode](./modes.md#-importer-mode)).
- The assets and the currency are written in upper case: `btc` is refused, not read as `BTC`.

Gekko 2:

```yaml fragment
watch:
  asset: BTC
  currency: USDT
  mode: backtest
  fillGaps: empty
  daterange:
    start: '2024-01-01T00:00:00.000Z'
    end: '2024-12-01T00:00:00.000Z'
```

Now:

```yaml
watch:
  assets: [BTC]
  currency: USDT
  mode: backtest
  timeframe: 1m
  daterange:
    start: '2024-01-01T00:00:00.000Z'
    end: '2024-12-01T00:00:00.000Z'
```

Gekko 2's `daterange` bounds keep working. A bound may now also be a day alone, which means its midnight UTC: `end: 2024-12-31` ends with the first minute of December 31st, so write `2024-12-31T23:59:00Z` to end with that day. Both bounds are included, as before.

### The `exchange` Section

- `apiKey` holds Binance's key: Gekko refuses `key`, which Gekko 2's guides wrote and Gekko 2 ignored.
- `simulationBalance`, of `dummy-cex` and of `paper-binance`, is a list of `{ assetName, balance }`, which names the watched assets and the currency, and no other asset.
- `dummy-cex` needs one `marketData` entry for each watched pair, where Gekko 2 took default fees and limits without one. Its `precision` is a number of decimals, no longer a step: Gekko 2's step `0.00001` is `5`, and its step `1` is `0`. A `1` left as it was reads as one decimal, a step of 0.1, without a warning.
- `initialTicker` is a list of `{ symbol, ticker: { bid, ask } }`.
- `simulationBalance`, `marketData` and `initialTicker` name each asset or pair once.
- Hyperliquid's `privateKey` and `walletAddress`, written in quotes, are now optional: an import needs neither, and a realtime run the ones its plugins need (see [Hyperliquid](./modes.md#hyperliquid)).

Gekko 2:

```yaml fragment
exchange:
  name: dummy-cex
  simulationBalance:
    asset: 0
    currency: 1000
```

Now, with the fees and limits Gekko 2 took when `marketData` was left out:

```yaml
exchange:
  name: dummy-cex
  simulationBalance:
    - assetName: BTC
      balance: 0
    - assetName: USDT
      balance: 1000
  marketData:
    - symbol: BTC/USDT
      marketData:
        price: { min: 1, max: 1000000 }
        amount: { min: 0.0001, max: 1000 }
        cost: { min: 10, max: 1000000 }
        precision: { price: 0, amount: 5 }
        fee: { maker: 0.0004, taker: 0.0007 }
```

### The Strategy Block and the Plugins

- A strategy's parameters sit directly under `strategy:`. Gekko 2's strategy guide nested them under `params:`, where its strategies found none; Gekko refuses that block as the run starts.
- `strategy.name` must equal the TradingAdvisor's `strategyName`.
- Each built-in strategy checks its block as the run starts, and refuses a parameter it does not take, and a required one left out: EMARibbon needs a new one (see [6. Check What Trades Differently](#6-check-what-trades-differently)). DebugAdvice, which `config/realtime-screener.yml` and `config/realtime-supervision.yml` run, still takes `each` and `wait`; `waittime`, which it never read, is refused, as any unknown key.
- `PerformanceAnalyzer` is gone: configure the `PortfolioAnalyzer`, which follows the value of the portfolio as it did, or the `RoundTripAnalyzer`, which follows each round trip from its BUY to its SELL, not both. Both take `riskFreeReturn` and `enableConsoleTable` as before (see [How Both Work](./plugins.md#how-both-work)).
- The PerformanceReporter writes other columns, and refuses to add a row to a CSV file whose first line is not its header, such as a file Gekko 2 wrote: it logs `report not written: the first line of … is not the expected header (another column layout or an older version of this plugin): move or rename it`, and the run exits with code 1. Move or rename Gekko 2's files (`performance_reports.csv` by default, in the directory Gekko runs from) before your first backtest (see [CSV Output Format](./plugins.md#csv-output-format)).
- A plugin entry refuses an option it does not know, as the sections do.
- Live trading on a real exchange needs the disclaimer at the top level of the file, as it did. Write its key quoted, as below: Gekko still reads Gekko 2's `[I understand …]: true` as the sentence, but other YAML tools read it as a list.

Gekko 2:

```yaml fragment
strategy:
  name: DEMA
  params:
    period: 12
    thresholds:
      up: 100
      down: -150

plugins:
  - name: TradingAdvisor
    strategyName: DEMA
  - name: Trader
  - name: PerformanceAnalyzer
    riskFreeReturn: 5

[I understand that Gekko only automates MY OWN trading strategies]: true
```

Now:

```yaml
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
  - name: PortfolioAnalyzer
    riskFreeReturn: 5

'I understand that Gekko only automates MY OWN trading strategies': true
```

### Values Gekko Checks Now

Gekko now also checks these values, and refuses one out of bounds, naming its path:

- `storage` is required in backtest mode and with a `CandleWriter`;
- `tickrate` and `warmup.tickrate` are whole numbers of milliseconds, 100 or more, and `exchangeSynchInterval` and `orderSynchInterval` 1000 or more;
- `storage.insertThreshold` is 1 to 1440 minutes, and `watch.batchSize` 31 days of minutes at most (44640);
- each mode takes its exchanges: `dummy-cex` for a backtest, `binance` or `hyperliquid` for an import, `binance`, `hyperliquid` or `paper-binance` for a realtime run;
- a backtest with a TradingAdvisor needs a `daterange` that holds more whole timeframe candles than `warmup.candleCount`.

[Modes](./modes.md) gives the options of each mode, and [Plugins](./plugins.md) those of each plugin.

---

## 5. Move Your Private Strategies

Gekko's code moved into packages, and the place of your private strategies with it:

- **A strategy of your checkout** moves from `src/strategies/custom/` to `packages/strategies/src/custom/`, the one directory Gekko reads them from, and its exports, which you set aside in step 2, into `packages/strategies/src/custom/index.ts`. Git still ignores the files left in `src/strategies/custom/`, and Gekko no longer reads them. The executables hold the strategies of that directory: build them again once your strategies are there.
- **Its imports** name Gekko's modules by their new paths: `@strategies/strategy.types` is `@gekko/strategies/strategy.types`, `@models/<name>.types` is `@gekko/shared/models/<name>.types`, and so on, as [the map of the old paths](./custom-strategies.md#cannot-find-package-helpers-or-strategies-from-your-checkouts-custom-strategies) gives them. Until they are rewritten, an old path that brings a value (a class, a function) stops every run as it starts, whatever its configuration, and `bun run type:check` lists every old path. Gekko 2's type `IndicatorParamaters`, misspelt, is now `IndicatorParameters`.
- **A file loaded through `strategyPath`** keeps its place, and imports only types from Gekko, from the same new paths: Bun drops type imports, so an old path does not stop it, but your editor no longer finds its types (a `tsconfig.json` beside it gives them back, see [Where Your Strategy Lives](./custom-strategies.md#where-your-strategy-lives)).

The strategy interface changed too:

| Gekko 2                                         | Now                                                                                     |
|-------------------------------------------------|-----------------------------------------------------------------------------------------|
| `addIndicator('EMA', { period: 12 })`           | `addIndicator('EMA', pair, { period: 12 })`: the pair second, and the parameters always |
| `candle.close`                                  | `candle.get(pair)?.close`: `candle` holds the candle of every watched pair              |
| An indicator argument is the indicator's result | `{ results, symbol }`: read `ema.results`                                               |
| `portfolio.currency.free`                       | `portfolio.get('USDT')?.free`, in an order hook's `exchange.portfolio` too              |
| An order hook's `exchange.balance`              | Gone: read `exchange.portfolio`                                                         |
| `tools.marketData.amount`                       | `tools.marketData.get(pair)?.amount`                                                    |
| `createOrder({ type: 'STICKY', side: 'BUY' })`  | `createOrder({ type: 'STICKY', side: 'BUY', symbol: pair })`                            |
| Every hook required                             | Every hook optional                                                                     |
| `end()`                                         | `end(interruption)`: the message of the error that stopped the run, if one did          |
| `init` gets the first timeframe candle          | `init` gets the first one-minute candle of each pair, before any timeframe candle       |
| `createOrder` works during the warmup           | `createOrder` throws during the warmup, so from `init` too                              |

A strategy written for Gekko 2 stops Gekko as it starts, on its first `addIndicator` call (`[STRATEGY] Impossible to add the DEMA indicator on [object Object]: symbol must be one of the watched pairs (BTC/USDT), got { period: 12 }`), and once that call is fixed may run without ever trading. In a strategy of `packages/strategies/src/custom/`, `bun run type:check` reports the calls and the reads these changes break (`addIndicator`, `candle.close`, `createOrder` without `symbol`, `portfolio.currency`, `tools.marketData.amount`, `exchange.balance`), but not the indicator arguments when they are typed `unknown[]`, as Gekko 2 typed them: they compile, and a check such as `typeof ema === 'number'` fails on every candle. [The entry for strategies written for Gekko 2](./custom-strategies.md#impossible-to-add-the--indicator-on-object-object-from-a-strategy-written-for-gekko-200) says what to write for each, and [Strategy Interface](./custom-strategies.md#strategy-interface) gives the whole interface.

---

## 6. Check What Trades Differently

These change what a configuration does once Gekko accepts it:

- **The signal strategies follow their position.** The seven signal strategies (CCI, DEMA, EMARibbon, MACD, RSI, SMACrossover and TMA) buy only when flat and sell only when long on a pair, and place no order there while one of theirs is pending. Gekko 2's acted on their signals whatever their orders had done: DEMA advised a SELL at each new downtrend, with nothing bought too, and TMA a BUY on every candle of an uptrend.
- **They start flat.** An asset the account holds as Gekko starts, such as one Gekko 2 bought, is not sold at the next SELL signal: the first signal a strategy acts on is a BUY. With enough currency, that BUY goes through and the next SELL signal sells everything held; with too little, the BUY is refused, and the strategy takes the asset held for its position, when it is enough to sell, and sells it at the next SELL signal (see [Position and Orders](./built-in-strategies.md#position-and-orders)).
- **They trade every watched pair.** Gekko 2 watched one asset. `watch.assets` takes up to 20, and the seven signal strategies trade every one of them, each BUY taking an equal share of the free currency among the pairs not invested: list one asset to trade one pair, as before. GridBot trades the first pair alone, and warns of the others. The development builds made after 2.0.0, which took several assets, traded the first pair alone too: a configuration written for one of them that watches several assets to trade the first now trades them all (see [Pairs and Capital](./built-in-strategies.md#pairs-and-capital)).
- **EMARibbon trades otherwise.** It takes a new parameter, `spreadCompressionThreshold`, required, in the quote currency. It buys a bullish ribbon only while its spread is below that threshold and not narrowing, and sells as soon as the spread narrows, where Gekko 2's bought any bullish ribbon and sold once it was no longer bullish (see [EMARibbon](./built-in-strategies.md#emaribbon--exponential-moving-average-ribbon)).
- **A circuit breaker stops a run.** Gekko 2 went on whatever the exchange refused. Gekko stops once `maxConsecutiveErrors` orders in a row have ended in error (a TradingAdvisor option, 5 by default), finalising the plugins, with exit code 0: `Max consecutive order errors reached (5)`. An order completed or canceled resets the count, and `-1` disables the breaker (see the [TradingAdvisor](./plugins.md#-tradingadvisor)).
- **A screener needs a Trader.** Gekko 2's quick start ran its screener, a TradingAdvisor and an EventSubscriber, on `binance`, without keys and without a Trader. On `binance`, the TradingAdvisor now reads the account's open orders and balance as the run starts, so the run fails without keys; and without a Trader, which ends each order, a built-in strategy waits for its first order to end, and advises once per run on each pair. Run a screener on `paper-binance` with a `Trader` and a `simulationBalance`, as `config/realtime-screener.yml` does: its orders are only simulated (see [Screener](./modes.md#1-screener-alerts-only)).
- **A Telegram bot answers one chat.** An EventSubscriber or Supervision bot binds itself to the first chat that sends it a command after Gekko starts, and answers that chat alone, where Gekko 2's followed whichever chat had written to it last. Set its `chatId` to your chat's id, which the bot logs at the `info` level once your first command binds it: the bot then talks to that chat from the start, and handles the commands the chat sent while Gekko was down (those of the last 24 hours, which Telegram keeps). A command no longer needs the bot's name after it: `/subscribe_all` works as `/subscribe_all@<bot>` did. As before, a bot sends nothing until its chat subscribes, after every restart (see the [EventSubscriber](./plugins.md#-eventsubscriber) and [Supervision](./plugins.md#-supervision)).

---

## The Release Notes

The notes of this release quote the breaking changes of the commits made since 2.0.0, some of them changes to features 2.0.0 did not have, such as the payload of the RoundTripAnalyzer's `roundtripCompleted` (`exitEquity` replaced by `cost`, `proceeds` and `fees`), or import paths under `@helpers/…` and `src/helpers/`, which a later change of this release moved again. This guide lists what a setup of 2.0.0 changes: take the import paths from [the map](./custom-strategies.md#cannot-find-package-helpers-or-strategies-from-your-checkouts-custom-strategies).
