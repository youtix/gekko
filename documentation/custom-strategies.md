# Custom Strategies

This guide explains how to create your own custom trading strategies and run them with Gekko. Custom strategies live **outside** the Gekko codebase, enabling you to develop and iterate on your trading logic independently; a private strategy can also live inside your checkout, in `packages/strategies/src/custom/` (see [Where Your Strategy Lives](#where-your-strategy-lives)).

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
  - [1. Create Your Strategy File](#1-create-your-strategy-file)
  - [2. Create Your Configuration File](#2-create-your-configuration-file)
  - [3. Run Your Strategy](#3-run-your-strategy)
- [Where Your Strategy Lives](#where-your-strategy-lives)
- [Strategy Interface](#strategy-interface)
- [Lifecycle Methods](#lifecycle-methods)
  - [`init` — Strategy Initialization](#init--strategy-initialization)
  - [`onEachTimeframeCandle` — Every Candle (Including Warmup)](#oneachtimeframecandle--every-candle-including-warmup)
  - [`onTimeframeCandleAfterWarmup` — Trading Logic (After Warmup)](#ontimeframecandleafterwarmup--trading-logic-after-warmup)
  - [`log` — Logging Hook](#log--logging-hook)
  - [`onOrderCompleted` — Order Filled](#onordercompleted--order-filled)
  - [`onOrderCanceled` — Order Canceled](#onordercanceled--order-canceled)
  - [`onOrderErrored` — Order Failed](#onordererrored--order-failed)
  - [`end` — Strategy Cleanup](#end--strategy-cleanup)
- [Tools Available](#tools-available)
- [Using Indicators](#using-indicators)
- [Creating Orders](#creating-orders)
  - [Order Types](#order-types)
  - [Order Parameters](#order-parameters)
  - [Examples](#examples)
  - [Trailing Stops](#trailing-stops)
- [Tracking Your Position](#tracking-your-position)
- [Configuration File](#configuration-file)
  - [TradingAdvisor Plugin Configuration](#tradingadvisor-plugin-configuration)
  - [Strategy Parameters](#strategy-parameters)
  - [Validating Your Parameters](#validating-your-parameters)
- [Running with Executable](#running-with-executable)
  - [Build the Executable](#build-the-executable)
  - [Run Your Strategy](#run-your-strategy)
- [Complete Example](#complete-example)
  - [Strategy File: `/home/user/strategies/emaCrossover.strategy.ts`](#strategy-file-homeuserstrategiesemacrossoverstrategyts)
  - [Configuration File: `config/emaCrossover.local.yml`](#configuration-file-configemacrossoverlocalyml)
  - [Run the Backtest](#run-the-backtest)
- [Best Practices](#best-practices)
  - [1. Type and Validate Your Parameters](#1-type-and-validate-your-parameters)
  - [2. Validate Indicator Values](#2-validate-indicator-values)
  - [3. Track the Order, Not the Signal](#3-track-the-order-not-the-signal)
  - [4. Use Appropriate Log Levels](#4-use-appropriate-log-levels)
  - [5. Set Adequate Warmup](#5-set-adequate-warmup)
- [Troubleshooting](#troubleshooting)
  - ["Cannot import the strategy file …" or "Cannot find external … strategy"](#cannot-import-the-strategy-file--or-cannot-find-external--strategy)
  - ["Cannot find package '@helpers/…'" or "'@strategies/…'" from your checkout's custom strategies](#cannot-find-package-helpers-or-strategies-from-your-checkouts-custom-strategies)
  - ["Cannot find package '@gekko/strategies'" or "Cannot find module '../helpers/…'" from a strategy that imported the PositionTracker or the PositionBook](#cannot-find-package-gekkostrategies-or-cannot-find-module-helpers-from-a-strategy-that-imported-the-positiontracker-or-the-positionbook)
  - ["Impossible to add the … indicator on [object Object]" from a strategy written for Gekko 2.0.0](#impossible-to-add-the--indicator-on-object-object-from-a-strategy-written-for-gekko-200)
  - ["Invalid parameters for strategy … (strategy block)"](#invalid-parameters-for-strategy--strategy-block)
  - ["Orders are not available until the warmup is over"](#orders-are-not-available-until-the-warmup-is-over)
  - ["Impossible to create the … order on …"](#impossible-to-create-the--order-on-)
  - ["Impossible to track positions …" or "… the position book does not track it …"](#impossible-to-track-positions--or--the-position-book-does-not-track-it-)
  - ["All-in BUY … sized from 0 USDT: 0 BTC sent …"](#all-in-buy--sized-from-0-usdt-0-btc-sent-)
  - ["… below the minimum cost of … on …" or "… below the minimum amount of … of a … order on …"](#-below-the-minimum-cost-of--on--or--below-the-minimum-amount-of--of-a--order-on-)
  - ["[…] BUY skipped: … is below the minimum cost of … of the market" or "… below the minimum amount …"](#-buy-skipped--is-below-the-minimum-cost-of--of-the-market-or--below-the-minimum-amount-)
  - ["Impossible to add the … indicator on …", "… indicator not found." or "Indicator …: …"](#impossible-to-add-the--indicator-on---indicator-not-found-or-indicator--)
  - ["Cannot open the database …" or "Missing candles in database"](#cannot-open-the-database--or-missing-candles-in-database)
  - ["watch.daterange must hold more whole … candles than warmup.candleCount"](#watchdaterange-must-hold-more-whole--candles-than-warmupcandlecount)
  - ["Max consecutive order errors reached (5)"](#max-consecutive-order-errors-reached-5)
  - [Trailing stop lines](#trailing-stop-lines)
  - ["Unknown log level … in tools.log"](#unknown-log-level--in-toolslog)
  - [Indicators returning null](#indicators-returning-null)
  - [Your hooks stay silent](#your-hooks-stay-silent)

---

## Overview

Custom strategies allow you to:

- **Develop independently** — Keep your proprietary trading logic separate from the Gekko core
- **Iterate quickly** — Modify and test strategies without rebuilding Gekko
- **Use any indicators** — Access all 31 built-in technical indicators
- **Handle order events** — React to order completions, cancellations, and errors
- **Leave your position to Gekko** — Trade through `tools.positions`, which tells you whether you are flat or long on each pair (`canBuy`, `canSell`), gives each BUY its pair's share of the currency and follows the outcome of each order, wherever your strategy lives
- **Protect a position** — Attach a trailing stop to a BUY: Gekko trails it and sells for you when it is hit

---

## Quick Start

### 1. Create Your Strategy File

Create a new TypeScript file anywhere on your system outside your Gekko checkout, `/home/user/strategies/myStrategy.strategy.ts` for instance:

```typescript
import {
  IndicatorResults,
  InitParams,
  OnCandleEventParams,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Strategy,
} from '@gekko/strategies/strategy.types';

// Define your parameters interface
interface MyStrategyParams {
  period: number;
  threshold: number;
}

// Export your strategy class with the exact name you'll reference in config. A parameter its body does not use yet starts with _,
// as bun run lint:check asks of a strategy kept in your checkout: rename a parameter once you use it
export class MyStrategy implements Strategy<MyStrategyParams> {
  init(_params: InitParams<MyStrategyParams>): void {
    // Initialize indicators here
  }

  onTimeframeCandleAfterWarmup(_params: OnCandleEventParams<MyStrategyParams>, ..._indicators: IndicatorResults[]): void {
    // Your main trading logic goes here
  }

  // Every hook is optional, the two above included: keep only the ones you use
  onEachTimeframeCandle(_params: OnCandleEventParams<MyStrategyParams>, ..._indicators: IndicatorResults[]): void {}
  log(_params: OnCandleEventParams<MyStrategyParams>, ..._indicators: IndicatorResults[]): void {}
  onOrderCompleted(_params: OnOrderCompletedEventParams<MyStrategyParams>, ..._indicators: IndicatorResults[]): void {}
  onOrderCanceled(_params: OnOrderCanceledEventParams<MyStrategyParams>, ..._indicators: IndicatorResults[]): void {}
  onOrderErrored(_params: OnOrderErroredEventParams<MyStrategyParams>, ..._indicators: IndicatorResults[]): void {}
  end(_interruption?: string): void {}
}
```

The file imports nothing from Gekko but types, which Bun drops as it loads the file: this is what lets it live anywhere (see [Where Your Strategy Lives](#where-your-strategy-lives)).

### 2. Create Your Configuration File

Create a YAML configuration file, `config/myStrategy.local.yml` for instance, a name git ignores in your checkout (`config/*.local.*`):

```yaml
watch:
  assets: [BTC]
  currency: USDT
  mode: backtest
  timeframe: 1h
  warmup:
    candleCount: 100
  daterange:
    start: 2024-01-01
    end: 2024-11-30T23:59:00Z

exchange:
  name: dummy-cex
  marketData:
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
        precision: # Decimals of a price and of an amount, a whole number (8 = steps of 0.00000001), not a step like 0.01
          price: 8
          amount: 8
        fee:
          maker: 0.0004
          taker: 0.0007
  simulationBalance:
    - assetName: BTC
      balance: 0
    - assetName: USDT
      balance: 1000

storage:
  type: sqlite
  database: ./db/binance-BTC_USDT.sql

strategy:
  name: MyStrategy
  period: 14
  threshold: 0.5

plugins:
  - name: TradingAdvisor
    strategyName: MyStrategy
    strategyPath: /home/user/strategies/myStrategy.strategy.ts

  - name: Trader

  - name: RoundTripAnalyzer
    enableConsoleTable: true
```

A `daterange` bound is a day, read as its midnight UTC (`2024-01-01`), or a day and a time with `Z` or an offset (`2024-11-30T23:59:00Z`, `2024-01-01T02:00:00+02:00`), quoted or not. Both bounds are included, so the range above ends with the last minute of November 2024: `end: 2024-11-30` would read only the first minute of November 30th. A day that does not exist (`2023-02-29`), or a time without `Z` or an offset, is refused at start-up.

The simulator takes each order on the market's steps and limits, as the exchange would (see [Backtest Mode](./modes.md#-backtest-mode)).

### 3. Run Your Strategy

A backtest reads its candles from `storage.database`, and refuses to start while a minute of `watch.daterange` is missing there: import them first. The importer of the [Quick Start guide](./quick-start.md#-2-retrieve-historical-data) does: it writes the candles of BTC/USDT from 2024-01-01 to 2024-12-01 into `./db/binance-BTC_USDT.sql`, a range that holds this one (see [Troubleshooting](#cannot-open-the-database--or-missing-candles-in-database) for the errors otherwise).

```bash
# Using the compiled executable (bun run build:exec builds it, see Running with Executable)
GEKKO_CONFIG_FILE_PATH=./config/myStrategy.local.yml ./dist/gekko
```

---

## Where Your Strategy Lives

A strategy lives in one of two places, which decide how Gekko finds it and what it can import:

|                     | Outside the codebase (this guide)                                      | In your checkout, in `packages/strategies/src/custom/`                                                                                                                       |
|---------------------|------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Selected by         | `strategyPath`, its file, and `strategyName`, the class it exports     | `strategyName` alone, once your class is exported from `packages/strategies/src/custom/index.ts`                                                                             |
| Loaded              | From its file, each time Gekko starts: no build needed after a change  | Compiled into `dist/gekko` and `dist/fox` by `bun run build:exec`, like the built-in strategies                                                                              |
| Imports from Gekko  | Types only                                                             | What the strategies' package may: types, the utilities and helpers of `@gekko/shared`, the schemas and the indicators; not the core, the plugins or another strategy's files |
| Its position        | Kept by [`tools.positions`](#tracking-your-position), no import needed | The same                                                                                                                                                                     |
| Packages (`zod`, …) | Installed next to its file (see below)                                 | Those of the checkout                                                                                                                                                        |
| Type-checked        | Not as Gekko loads it; by your editor, with the `tsconfig.json` below  | By `bun run type:check`, not by the pre-commit hook; its tests run with `bun run test`, never in CI                                                                          |
| Git                 | Yours                                                                  | Gitignored, but for a placeholder `index.ts` that `bun install` marks skip-worktree: your exports stay out of git                                                            |

A file loaded through `strategyPath` can import Gekko's types (`@gekko/strategies/strategy.types`, `@gekko/strategies/trailingStopManager.types`, `@gekko/shared/models/…`), because Bun drops an import that is only used as a type, but nothing else of Gekko: the compiled executable resolves no `@gekko/…` path of a file it loads as it starts, even a file inside the checkout, and Gekko run from source (`bun run dev`) resolves them only for a file inside the checkout, or beside a `tsconfig.json` that maps them to the checkout, as the one below does. Such an import stops Gekko at start-up with `[TRADING ADVISOR] Cannot import the strategy file …/myStrategy.strategy.ts: ResolveMessage: Cannot find package '@gekko/strategies' imported from …/myStrategy.strategy.ts`: Bun names Gekko's own package, which is not one to install. So model an external strategy on the [Complete Example](#complete-example), not on a built-in strategy: those import modules of Gekko, their schema and some of Gekko's utilities, and a copy of `dema.strategy.ts` placed outside the codebase stops on the first of them, `ResolveMessage: Cannot find package '@gekko/shared' imported from …/dema.strategy.ts`. Their position tracking needs no import: `tools.positions`, which they trade through, is your strategy's too, wherever it lives (see [Tracking Your Position](#tracking-your-position)).

A package your strategy imports is looked up from the folder of its file: install it there (`bun add zod` in that folder), unless the file sits inside a Gekko checkout, whose `node_modules` has it. The compiled executable, though, only finds a package by the `index.js` at its root, whatever its `package.json` names as its entry: `zod` has one, but `lodash-es`, which Gekko itself uses, has none, and is not found even installed next to the strategy (`… ResolveMessage: Cannot find package 'lodash-es' imported from …`). Import such a package by its files (`import isNil from 'lodash-es/isNil.js'`), or run Gekko from source (`bun run dev`), which follows the `package.json`.

Bun runs TypeScript without checking it, and outside the checkout your editor finds none of Gekko's types (`TS2307: Cannot find module '@gekko/strategies/strategy.types' or its corresponding type declarations`): a misspelt field or a wrong type shows only when Gekko runs, if at all. A `tsconfig.json` in your strategies' folder gives them the checkout's types, with your checkout's path in place of `/home/user/gekko`:

```json
{
  "extends": "/home/user/gekko/tsconfig.base.json",
  "compilerOptions": {
    "typeRoots": ["/home/user/gekko/node_modules/@types"],
    "types": ["bun"]
  },
  "include": ["**/*.ts", "/home/user/gekko/packages/shared/src/modules/global.d.ts"]
}
```

Your editor then checks every `.ts` file of the folder against Gekko's types, and so does `/home/user/gekko/node_modules/.bin/tsc -p .` run in the folder: a `period: 'x'` given to `addIndicator` is reported before Gekko runs (`error TS2322: Type 'string' is not assignable to type 'number'.`). Each part is needed: `extends` maps the `@gekko/…` paths to the checkout, `compilerOptions` brings the checkout's Bun types, which declare the Node modules Gekko's types import (`node:crypto`), and the last file of `include` declares the global types of Gekko's code (`EpochTimeStamp`). A package your strategy imports, `zod` for one, is checked once installed in the folder. Bun reads that file too: run from source, Gekko then loads a Gekko module your strategy imports, which the compiled executable still refuses as above, so keep to types.

To build on a built-in strategy, a copy of it that you change, or to use Gekko's own code (a utility of `@gekko/shared`, an indicator class fed your own values, see [Feeding an Indicator Your Own Values](./indicators.md#feeding-an-indicator-your-own-values)), keep your strategy in `packages/strategies/src/custom/` and export it from the placeholder, which holds `export {};` until then. Tracking its position is no reason to: `tools.positions` keeps the position of a strategy loaded through `strategyPath` as it keeps that of a strategy of the checkout. A strategy kept there belongs to Gekko's strategies package (`@gekko/strategies`), and imports what that package may: Gekko's types, the utilities and helpers of `@gekko/shared`, the schemas of `@gekko/schemas` and the indicators of `@gekko/indicators`, and, of the strategies' package itself, its two type modules (`@gekko/strategies/strategy.types`, `@gekko/strategies/trailingStopManager.types`) and the files of `custom/` beside it. No strategy imports the files of another, a built-in one's included: nothing checks it in `custom/`, which the test that holds the strategies to that rule leaves out, so keep to it yourself. The core, beside the strategies, and the plugins, above them (`@gekko/core/…`, `@gekko/plugins/…`, the logger and the position book among them), are out of a strategy's reach, and `bun run lint:check` refuses a strategy's import of them: log through `tools.log`, and track your position through `tools.positions`. `bun run lint:check` reads these files too: a parameter left unused must start with `_`. A copy of a built-in strategy keeps its imports of its own package working there (`../strategy.types`), but for those of its own directory, such as `./dema.types`: copy that file beside it.

```typescript
// packages/strategies/src/custom/index.ts
export * from './myStrategy.strategy';
```

```yaml
plugins:
  - name: TradingAdvisor
    strategyName: MyStrategy # No strategyPath: Gekko looks the name up among its own strategies, those of packages/strategies/src/custom/ included
```

Give your class a name of its own. A copy of a built-in strategy that keeps its class name, `dema.strategy.ts` exporting `DEMA`, makes the name ambiguous, and Gekko's strategies then hold neither class: `bun run type:check` reports `TS2308: Module './custom/index' has already exported a member named 'DEMA'`, `bun run build:exec` builds without either, and `strategyName: DEMA` stops Gekko with `[TRADING ADVISOR] Cannot find internal DEMA strategy`.

`bun install` marks the placeholder skip-worktree (`git update-index --skip-worktree`; outside a git checkout it does nothing): `git status` does not show your copy, `git commit -a` does not take it, and it survives `git stash`, `git reset --hard`, `git checkout -- .`, `git restore .` and a commit the pre-commit hook refuses. That hook type-checks what is committed, where the placeholder is `export {};`, and so leaves your strategies out: `bun run type:check` checks them. An update of Gekko that changes the placeholder stops `git pull` (`Your local changes to the following files would be overwritten by merge: packages/strategies/src/custom/index.ts`), which keeps your copy. Copy your exports aside, run `git update-index --no-skip-worktree packages/strategies/src/custom/index.ts` and `git checkout -- packages/strategies/src/custom/index.ts`, pull again, write your exports into the new placeholder, then run `bun install`, which marks it again.

---

## Strategy Interface

Every custom strategy must implement the `Strategy<T>` interface, where `T` is your parameters type. The listing below is an excerpt of [`packages/strategies/src/strategy.types.ts`](../packages/strategies/src/strategy.types.ts), whose comments give the contract of each hook and tool in full:

```typescript
// Every hook is optional. candle is a Map holding the candle of every watched pair, and each indicator arrives as an
// IndicatorResults, { results: unknown; symbol: TradingPair }, in the order of the addIndicator calls.
// Tools is the type of the tools object (see Tools Available), TrailingStopState comes from
// '@gekko/strategies/trailingStopManager.types', UUID from 'node:crypto'.
interface Strategy<T> {
  init?(params: InitParams<T>): void;
  onEachTimeframeCandle?(params: OnCandleEventParams<T>, ...indicators: IndicatorResults[]): void;
  onTimeframeCandleAfterWarmup?(params: OnCandleEventParams<T>, ...indicators: IndicatorResults[]): void;
  log?(params: OnCandleEventParams<T>, ...indicators: IndicatorResults[]): void;
  onOrderCompleted?(params: OnOrderCompletedEventParams<T>, ...indicators: IndicatorResults[]): void;
  onOrderCanceled?(params: OnOrderCanceledEventParams<T>, ...indicators: IndicatorResults[]): void;
  onOrderErrored?(params: OnOrderErroredEventParams<T>, ...indicators: IndicatorResults[]): void;
  // A trailing stop became active: the price reached its trigger, or, for a stop without one, its BUY completed, or errored after a
  // reported fill (see Trailing Stops)
  onTrailingStopActivated?(state: TrailingStopState, tools: Tools<T>): void;
  // A trailing stop was hit: orderId is the MARKET SELL Gekko has just created for it, an order of your strategy's from now on
  onTrailingStopTriggered?(orderId: UUID, state: TrailingStopState, tools: Tools<T>): void;
  // Once, at the end of the run: interruption is the message of the error that stopped it early, undefined after a normal end
  end?(interruption?: string): void;
}
```

What a hook receives is your strategy's own copy: the candles and the indicator results (one copy per timeframe candle, shared by the hooks of that candle), the portfolio (one per change), the `order` and `exchange` of an order hook (one per call), the state of a trailing stop, the orders open at start-up, `tools.strategyParams` and `tools.marketData` (one each, made before the first candle). Writing to it changes nothing elsewhere: not the configuration, the exchange or its simulator, the indicators, the other plugins, nor what Gekko itself goes by. To remember something from one candle to the next, keep it in a field of your class.

---

## Lifecycle Methods

The snippets of this section are methods of one class, which follows two EMAs of the first watched pair and keeps its position itself, to show what each order hook brings: `tools.positions` keeps it for you, and a strategy that trades through it needs none of this bookkeeping (see [Tracking Your Position](#tracking-your-position)). The `init` snippet shows the class with its fields and the two helpers its methods share, `compareWithTolerance`, which compares the two EMAs (see [Validate Indicator Values](#2-validate-indicator-values)), and `holdsSellable`, which reads the position from the portfolio once an order has ended.

### `init` — Strategy Initialization

Called **once**, at start-up, on the first one-minute candle, before any timeframe candle: in realtime the first minute of the warmup history (with no history to replay, the first live minute, once it closes) at which every watched pair has a candle (see [Modes](./modes.md#-importer-mode)), in a backtest the first minute of `watch.daterange`. Its `candle` holds that minute's candle of every watched pair, in the order of `watch.assets`: take your pairs from its keys, not a price (a price to trade from comes with the first candle after the warmup). In a backtest, these one-minute candles also carry an `id`, their row in the candle database; a candle read live from the exchange, one Gekko made up for a missing minute, and every timeframe candle have none: do not rely on it.

Register your indicators here: `addIndicator(name, symbol, params)` is only available in `init`. Kept and called later, it throws `[STRATEGY] Impossible to add the SMA indicator on BTC/USDT: addIndicator is available in init only`, which stops Gekko. Start the tracking of your positions here too, if your strategy trades through `tools.positions`: `tools.positions.track()` is only available in `init` as well (see [Tracking Your Position](#tracking-your-position)). These stop Gekko at start-up, with an error naming the problem:

- an indicator name that does not exist (`[STRATEGY] SMAA indicator not found.`), or parameters the indicator refuses, a required one left out included (`[STRATEGY] Indicator ATR: period must be a whole number, at least 1, got undefined`, see [Parameter Checks](./indicators.md#parameter-checks));
- a third argument that is not a plain object of the indicator's parameters by name, which only a JavaScript strategy can pass (`[STRATEGY] Impossible to add the RSI indicator on BTC/USDT: parameters must be a plain object of the indicator's parameters by name, {} to take its defaults, got 7`);
- a `symbol` that is not a watched pair, a key of `candle` and of `tools.marketData` (`[STRATEGY] Impossible to add the SMA indicator on ETH/USDT: symbol must be one of the watched pairs (BTC/USDT), got 'ETH/USDT'`): an indicator on another pair would never get a candle;
- a `tools.positions.track` given a pair that is not watched, a pair twice, or a list that names none, or called a second time (see ["Impossible to track positions …"](#impossible-to-track-positions--or--the-position-book-does-not-track-it-));
- any error your `init` throws, `tools.log('error', …)` included.

No orders here: the warmup is not over (see [Creating Orders](#creating-orders)).

```typescript
type MyParams = { short: number; long: number }; // From the strategy: block of the configuration, e.g. short: 12 and long: 26
type EndedOrderParams = OnOrderCompletedEventParams<MyParams> | OnOrderCanceledEventParams<MyParams> | OnOrderErroredEventParams<MyParams>;

// The sign of a - b, but 0 when they are within a relative tolerance of each other: Gekko's compareWithTolerance, copied, since a
// file loaded through strategyPath cannot import it
const compareWithTolerance = (a: number, b: number, tolerance = 1e-9): number => {
  if (a === b) return 0;
  const difference = a - b;
  if (Number.isFinite(difference) && Math.abs(difference) <= tolerance * Math.max(Math.abs(a), Math.abs(b))) return 0;
  return Math.sign(difference);
};

// In your file, export the class as the Quick Start's file does (export class MyStrategy …): Gekko finds only an exported class
class MyStrategy implements Strategy<MyParams> {
  private pair?: TradingPair;
  private priceHistory: number[] = [];
  private isLong = false; // Whether the strategy holds the asset, as the outcome of its orders tells
  private pendingOrderId?: UUID; // The order whose outcome it waits for

  init({ candle, tools, addIndicator }: InitParams<MyParams>): void {
    // candle holds one candle per watched pair, in the order of watch.assets: pick the pair to follow, and keep it for the other hooks
    const [pair] = candle.keys();
    this.pair = pair;
    // Register indicators (they'll be updated automatically)
    addIndicator('EMA', pair, { period: tools.strategyParams.short });
    addIndicator('EMA', pair, { period: tools.strategyParams.long });
  }

  // The methods of the next sections

  // Whether the portfolio after an order holds enough of the asset to sell at the minimums of the market, its free balance cut to the
  // amount step; undefined when no balance was read yet, or when the Trader read it before the order ended (its read after the end
  // failed), which tells nothing of what the order left. Worked out in decimal, as the Complete Example explains
  private holdsSellable({ order, exchange, tools }: EndedOrderParams): boolean | undefined {
    const [asset] = order.symbol.split('/');
    const free = exchange.portfolio.get(asset)?.free;
    if (free === undefined || exchange.portfolioReadAfterOrder === false) return undefined;
    const { amount, cost, precision } = tools.marketData.get(order.symbol) ?? {};
    const step = precision?.amount;
    const decimal = (value: number) => Number(value.toPrecision(15));
    const sellable = step ? decimal(Math.floor(decimal(free / step)) * step) : free;
    const isCostEnough = exchange.price <= 0 || decimal(sellable * exchange.price) >= (cost?.min ?? 0);
    return sellable > 0 && sellable >= (amount?.min ?? 0) && isCostEnough;
  }
}
```

`init` also gets:

- `portfolio`, the balances read at start-up: a `Map<Asset, { free, used, total }>` (`Portfolio` of `@gekko/shared/models/portfolio.types`) with an entry for each watched asset and for the currency, 0 when none is held; `portfolio.get('USDT')?.free` is the USDT free.
- `openOrders`, the orders open on each watched pair when the run started, placed by an earlier run, by hand or by another bot: a `Map<TradingPair, OpenOrder[]>` (`OpenOrder` of `@gekko/shared/models/exchange.types`) whose entries are `{ id, side, type, price?, amount, filled, remaining, timestamp }`. `id` is the exchange's. `type` is `'LIMIT'`, `'MARKET'` or `'OTHER'`: `'OTHER'` for a stop-loss or a take-profit waiting for its trigger price, whatever type it executes with, and for a type Gekko does not know. `price` is `undefined` for an order without one, such as a stop-loss that executes at the market. They are read once from the exchange, and there are none in a backtest or a paper-trading session.

Your strategy does not follow these orders: the Trader follows only the orders your strategy creates in this run, so no hook hears of their fills or of their end. `tools.cancelOrder` cannot cancel them either: their `id` is the exchange's, which the Trader does not know, so it sends nothing and only warns `[<id>] Impossible to cancel order: Unknown Order` (a warning, hidden at the default `error` level). Cancel them on the exchange. A strategy that keeps its orders in memory can refuse to start beside them with `tools.log('error', …)`, as GridBot does.

> [!IMPORTANT]
> Indicators are passed to other methods in the **same order** you register them in `init`, each as a `{ results, symbol }` object.

---

### `onEachTimeframeCandle` — Every Candle (Including Warmup)

Called on **every** timeframe candle from the very beginning, including during warmup, before `log` and `onTimeframeCandleAfterWarmup`. It can create orders from the candle after the one that completes the warmup. It is the place to record what you compare with the previous candle: it runs on the warmup candles too, so the first candle after the warmup is compared with the last warmup candle.

```typescript
onEachTimeframeCandle({ candle }: OnCandleEventParams<MyParams>, ..._indicators: IndicatorResults[]): void {
  // Track data even during warmup (candle is a Map: one candle per watched pair)
  const current = this.pair ? candle.get(this.pair) : undefined;
  if (current) this.priceHistory.push(current.close);
}
```

---

### `onTimeframeCandleAfterWarmup` — Trading Logic (After Warmup)

Called on each timeframe candle **after** the warmup period completes, the candle that completes it included. **This is where your main trading logic belongs.**

Its `portfolio` is the balance the TradingAdvisor reads at start-up, then the latest the Trader sends, from the candle after it arrives: the one each synchronization of the Trader reads (every `exchangeSynchInterval` in realtime, 10 minutes by default; in a backtest every `watch.timeframe`, 10 minutes at least), unless the Trader's `portfolioUpdates` filter holds it back, or the one the end of one of your orders carries. So what a pending order reserves shows from the Trader's next synchronization, moved from `free` to `used`, not as soon as the order is placed. With that filter, which sends a portfolio only once a total has moved past its threshold, it shows with the next portfolio sent, or the end of that order.

```typescript
onTimeframeCandleAfterWarmup({ tools }: OnCandleEventParams<MyParams>, ...indicators: IndicatorResults[]): void {
  const { createOrder, log } = tools;
  const [shortEma, longEma] = indicators;
  // results is unknown, and null until the indicator has seen enough candles
  if (!this.pair || typeof shortEma.results !== 'number' || typeof longEma.results !== 'number') return;

  // The short EMA above the long one, beyond the tolerance, flat and nothing pending: the strategy only becomes long once the BUY has
  // completed (see onOrderCompleted)
  if (compareWithTolerance(shortEma.results, longEma.results) > 0 && !this.isLong && !this.pendingOrderId) {
    log('info', 'Short EMA above the long one — going LONG');
    this.pendingOrderId = createOrder({ type: 'STICKY', side: 'BUY', symbol: this.pair });
  }
}
```

---

### `log` — Logging Hook

Called on each timeframe candle after warmup, just before `onTimeframeCandleAfterWarmup`, to log indicator values and debug info (at `debug`, a line is printed with `GEKKO_LOG_LEVEL=debug` and never sent to Telegram).

```typescript
log({ tools }: OnCandleEventParams<MyParams>, ...indicators: IndicatorResults[]): void {
  const [shortEma, longEma] = indicators;
  if (typeof shortEma.results !== 'number' || typeof longEma.results !== 'number') return;
  tools.log('debug', `EMA Short: ${shortEma.results.toFixed(2)} | Long: ${longEma.results.toFixed(2)}`);
}
```

---

### `onOrderCompleted` — Order Filled

Called when an order of yours is filled by the exchange. An order your strategy placed through `tools.positions` has settled its position by then, as it has before `onOrderCanceled` and `onOrderErrored`: `tools.positions.isLong(order.symbol)` already tells what it left (see [Tracking Your Position](#tracking-your-position)). These are the fields a strategy acts on, each defined in full under the Trader's [events](./plugins.md#trader-events):

- `order.amount`: the amount it filled; on a market with an amount step, the amount asked for truncated to that step, in backtest and paper trading as live (an all-in BUY of 0.0310282298100942 BTC fills for 0.03102 on Binance's BTC/USDT).
- `order.price`: the price it executed at, the mean of its trades' prices weighted by their amounts.
- `order.effectivePrice`: that price with the fee in, above it for a BUY, below it for a SELL.
- `order.fee`: the fee in the currency, the fees of its trades added up, a fee taken in BNB counting 0.
- `order.feePercent`: the fee rate in % (`0.1` for 0.1 %), `undefined` when no trade gave a rate.
- `order.feeAsset`: the asset the exchange took the fee in (`'BTC'` for a BUY on BTC/USDT at Binance unless the fees are paid in BNB, `'USDT'` for its SELL and for every order of a backtest or of `paper-binance`, `'BNB'` with the discount), `undefined` when the trades name none or several.
- `order.feeTakenInAsset`: what the fees took of the asset bought, `{ amount, value }` (`{ amount: 0.001, value: 0.1 }` for 1 BTC bought at 100 at Binance without BNB): the account holds `order.amount` less that `amount`. `undefined` when no trade took its fee in the asset.
- `order.orderExecutionDate`: when it executed, the time of its last trade, else the end of the last minute processed. Every order hook also gets `order.orderCreationDate`, when your strategy created the order (see [Creating Orders](#creating-orders)).
- `exchange.price`: the price of the pair the Trader read once the order ended (in realtime the event arrives with the next minute, and the market may have moved since).
- `exchange.portfolio`: the portfolio after the fill, which the Trader read at `exchange.portfolioReadAt`, in epoch milliseconds (`undefined` before its first read, the portfolio then empty).
- `exchange.portfolioReadAfterOrder`: whether the Trader read that portfolio after the order ended. `false` when its read after the end failed, the event then carrying an earlier read, which may still count what the order reserved as used or miss what it filled; `undefined` before its first read. The cancel and error hooks get the same `exchange` part.

When the exchange gives no usable trades, the summary is estimated and an error line says from what: a LIMIT or STICKY order from the prices the exchange reported for its own fills, otherwise its limit price or the last market price.

```typescript
onOrderCompleted(params: OnOrderCompletedEventParams<MyParams>): void {
  const { order, tools } = params;
  tools.log('info', `Order ${order.id} completed: ${order.side} ${order.amount} @ ${order.price}`);
  if (order.id !== this.pendingOrderId) return;
  this.pendingOrderId = undefined;
  // A BUY makes it long. A SELL may have sold less than the position (the Trader caps a SELL at the most the market takes in one
  // order): the strategy is still long when the portfolio after it holds enough to sell, and stays as it was when that tells nothing
  this.isLong = order.side === 'BUY' || (this.holdsSellable(params) ?? this.isLong);
}
```

---

### `onOrderCanceled` — Order Canceled

Called when an order of yours is canceled: by your strategy (`tools.cancelOrder`), or by the exchange (expired, canceled from its interface). It may have filled part of its amount before: `order.filled` is the largest fill any answer of the exchange reported for it, a poll before the cancelation included, `order.remaining` what was left of its amount (of the order's amount, not of what you hold, unless the order was for all of it), and, for a `LIMIT` or `STICKY` order, `order.fillPrice` the mean price of those fills (a `STICKY` order trades at the market, not at `order.price`), left out for a `MARKET` order, whose reported price can be the bound of its slippage, and when no fill had a price reported. A number, `0` included, is a fact: `0` filled means that nothing executed. `order.filled` and `order.remaining` are `undefined` when no answer reported a fill: unknown, not 0 filled. `exchange.portfolio`, the portfolio after the cancelation, then tells what you hold (see [Tracking Your Position](#tracking-your-position)), unless `exchange.portfolioReadAfterOrder` is `false`: the Trader's read after the cancelation failed, and the portfolio is an earlier one. `order.orderCancelationDate` is the time the exchange gives its cancelation. Each field is defined in full under the Trader's [events](./plugins.md#trader-events).

```typescript
onOrderCanceled(params: OnOrderCanceledEventParams<MyParams>): void {
  const { order, tools } = params;
  // undefined when the exchange reported no fill: unknown, not 0
  const fill = order.filled === undefined ? 'no fill reported' : `${order.filled} filled, ${order.remaining} left`;
  tools.log('warn', `Order ${order.id} was canceled (${fill})`);
  if (order.id !== this.pendingOrderId) return;
  // No longer pending: the next candle that calls for it sends the order again
  this.pendingOrderId = undefined;
  // It may have filled part of its amount first: the portfolio after it tells, once the Trader read a balance after it
  this.isLong = this.holdsSellable(params) ?? this.isLong;
}
```

---

### `onOrderErrored` — Order Failed

Called when an order of yours fails or is refused by the exchange, `order.reason` saying why. An amount the market's step truncates to 0, or whose cost then falls under `cost.min`, is refused so, in backtest and paper trading as live (`Order 'cost' with value 4.8987648 is out of range. Expected a value between 5 and 9000000.`). An amount or a price the step rounds to nothing is reported as the order asked for it, with the step: 0.0000099 BTC on Binance's BTC/USDT reads `Order 'amount' with value 0.0000099 rounds to 0 on the amount step 0.00001 of the market. Expected a value between 0.00001 and 9000.` It may have executed part of its amount first: `order.filled` is what the exchange reported it filled, 0 when it reported nothing. For a `LIMIT` or `STICKY` order, `order.fillPrice` is the mean price of those fills, as an order canceled carries it, left out for a `MARKET` order and when no fill had a price reported. `order.orderErrorDate` dates the error with the end of the last minute processed. Each field is defined in full under the Trader's [events](./plugins.md#trader-events).

`order.mayBeLive` is `true` when the order may still be live on the exchange, where Gekko follows it no more: its creation's answer was lost on the network, the order was created but its state could not be read back, the exchange failed the creation without refusing it (an internal error, such as Binance's "execution status unknown"), or a poll or a cancelation failed for good while it was open. It may then have executed more than `order.filled`, or execute later, and no event will tell: placed again, it may be doubled, so check it on the exchange first. `false` when the exchange refused it, or nothing of it was left open: what it executed is `order.filled`. When the order is the SELL of a trailing stop, the stop is active again either way for what that SELL did not sell, unless nothing it can sell is left for it to protect (see [Trailing Stops](#trailing-stops)).

`maxConsecutiveErrors` order errors in a row (a [TradingAdvisor option](#tradingadvisor-plugin-configuration), 5 by default, `-1` to disable it) stop Gekko with `[STRATEGY] Max consecutive order errors reached (5)` and exit code 0: the circuit breaker. A completed or canceled order resets the count. Your `onOrderErrored` still runs for the error that trips it, before the stop, but an order it creates then is never sent.

```typescript
onOrderErrored(params: OnOrderErroredEventParams<MyParams>): void {
  const { order, tools } = params;
  // Not 'error': tools.log('error', …) throws, and stops the bot
  tools.log('warn', `Order ${order.id} failed: ${order.reason}`);
  if (order.mayBeLive) tools.log('warn', `Order ${order.id} may still be live on the exchange: check it there before placing it again`);
  if (order.id !== this.pendingOrderId) return;
  // No longer pending: a BUY refused is sent again on the next candle of the uptrend, each refusal counting towards maxConsecutiveErrors
  this.pendingOrderId = undefined;
  // It may have executed before its error: the portfolio after it tells, once the Trader read a balance after it (see Tracking Your
  // Position)
  this.isLong = this.holdsSellable(params) ?? this.isLong;
}
```

---

### `end` — Strategy Cleanup

Called once, when the run ends: the backtest completes, or an error stops the bot before its end (a crash, missing candles, the circuit breaker). `interruption` is then the message of that error, as the analyzers give it in their reports, and undefined after a normal end. A signal (Ctrl-C, SIGTERM) or an uncaught exception ends Gekko without calling it.

```typescript
end(_interruption?: string): void {
  // Cleanup resources, log final statistics, etc. (rename _interruption to interruption once you read it)
}
```

---

## Tools Available

Every lifecycle method but `end` receives a `tools` object, the same object in each (the trailing-stop hooks get it as their last argument, after the state):

| Tool                  | Type                           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|-----------------------|--------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `strategyParams`      | `T` (your params type)         | Your strategy parameters: the output of your class's `schema` (see [Validating Your Parameters](#validating-your-parameters)), or, without one, the whole `strategy:` block, `name` included. Your own copy: writing to it changes neither the configuration nor what the other plugins read there                                                                                                                                                                         |
| `marketData`          | `Map<TradingPair, MarketData>` | Order limits, precision (as steps: 0.01) and fees of each watched pair, plus the narrower `market` limits of MARKET orders if any. Its keys are the pairs `createOrder`, `addIndicator` and `positions.track` accept. Your own copy: writing to it changes neither the exchange, nor the limits it checks, nor what `tools.positions` goes by                                                                                                                              |
| `log`                 | `(level, msg) => void`         | Log messages (`debug`, `info`, `warn`, `error`), printed if `GEKKO_LOG_LEVEL` lets the level through. `info`, `warn` and `error` lines also go to Telegram (the EventSubscriber's `/sub_strat_info`), whatever `GEKKO_LOG_LEVEL`; `debug` lines never do. `error` also throws a `GekkoError`, which stops the bot: its line is sent at once, so it reaches Telegram even then (caught by your strategy, it arrives ahead of the lines logged before it in the same minute) |
| `createOrder`         | `(order) => UUID`              | Create a new order: returns its id at once, the outcome arrives later in `onOrderCompleted`, `onOrderCanceled` or `onOrderErrored`. Before the warmup is over, or for an order it cannot accept, it sends nothing and throws a `GekkoError`, which stops the bot (see [Creating Orders](#creating-orders))                                                                                                                                                                 |
| `cancelOrder`         | `(orderId) => void`            | Cancel an order of yours: its outcome still arrives through the order hooks, canceled, completed if it filled first, or errored if the cancelation failed                                                                                                                                                                                                                                                                                                                  |
| `cancelTrailingOrder` | `(orderId) => void`            | Drop the trailing stop of a BUY order (given the BUY's id), before or after the BUY completes, and while the stop sells. You need not call it to exit: while your SELL is pending the stops of the pair do not trigger, once it completes they are canceled, and if it fails they protect the position again                                                                                                                                                               |
| `positions`           | `Positions`                    | Your strategy's position book: `track` the pairs in `init`, then read `canBuy`, `canSell`, `isLong` and `isPendingOrder` of a pair, and place its orders with `buy` and `sell`, a BUY of its share of the currency and a SELL of all of its asset, each kept pending until its outcome, which settles the position before your order hooks run (see [Tracking Your Position](#tracking-your-position)). The same object for the whole run                                  |
| `indicatorsBySymbol`  | `(indicators) => Map`          | Groups a hook's indicator arguments by pair, in a `Map`: the arguments of each pair in the order of its `addIndicator` calls, the pairs in the order of their first indicator (see [Tracking Your Position](#tracking-your-position))                                                                                                                                                                                                                                      |

---

## Using Indicators

Register indicators in `init` with `addIndicator(name, symbol, params)` and receive their values in candle handlers. `params` holds the indicator's parameters by name, and TypeScript requires it even when each one has a default: pass `{}` to take the defaults, `undefined` for TrueRange, which takes none. A JavaScript strategy may leave it out or pass `null`, which Gekko reads as `{}`; anything but a plain object, such as `7` given for a period, stops Gekko at start-up (see [Parameter Checks](./indicators.md#parameter-checks)).

```typescript
init({ candle, addIndicator }: InitParams<MyParams>): void {
  const [pair] = candle.keys();
  // Indicators are calculated automatically on each candle of the pair they follow
  addIndicator('SMA', pair, { period: 20 });
  addIndicator('RSI', pair, { period: 14 });
  addIndicator('MACD', pair, { short: 12, long: 26, signal: 9 });
}

onTimeframeCandleAfterWarmup(params: OnCandleEventParams<MyParams>, ...indicators: IndicatorResults[]): void {
  // Access in the same order you registered them, each as { results, symbol }: results is unknown, null until the indicator
  // has seen enough candles, then complete on every candle (the third's, MACD's, is then { macd, signal, hist }, all three set). Only
  // ROC, and TRIX built on it, give null again, on a candle whose base is 0
  const [sma, rsi] = indicators;
  const price = params.candle.get(sma.symbol)?.close;
  if (price === undefined || typeof sma.results !== 'number' || typeof rsi.results !== 'number') return;

  if (rsi.results < 30 && price > sma.results) {
    // Buy signal logic
  }
}
```

See the [Indicators Documentation](./indicators.md) for all available indicators.

---

## Creating Orders

Use `tools.createOrder()` to place trades, or, to have Gekko keep your position, `tools.positions.buy` and `tools.positions.sell`, which place theirs through it, with its checks (see [Tracking Your Position](#tracking-your-position)). It is available once the warmup is over: from `log` and `onTimeframeCandleAfterWarmup` on the candle that completes it (the first candle with `warmup.candleCount: 0`), then from every hook (`onEachTimeframeCandle` from the next candle on). Called earlier, and so always from `init`, it throws `[STRATEGY] Orders are not available until the warmup is over: …`, and so do `tools.positions.buy` and `sell`, which stops Gekko: in realtime the warmup candles are history, replayed with the Trader active, and an order created on one of them would reach the exchange at once.

An order is dated (`orderCreationDate`) with the end of the minute being processed, as the fills and the errors of that minute are.

### Order Types

| Type     | Description                                                                                                                                                                                                   |
|----------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `STICKY` | Limit order `price.min` inside the best bid/ask, re-placed once the market moves past it (checked every `orderSynchInterval` in realtime, every minute in backtest); no timeout, never becomes a market order |
| `MARKET` | Immediate market order (on Hyperliquid, an immediate-or-cancel limit order, see [Order Types](./plugins.md#order-types))                                                                                      |
| `LIMIT`  | Standard limit order at specified price                                                                                                                                                                       |

`STICKY` and `MARKET` orders ignore `price`, which then only sizes a BUY without an `amount` (all-in, or by `cost` or `allocation`) and a SELL by `cost`. In a backtest, the simulated exchange fills a `MARKET` order at the close of the minute and a `LIMIT` order in full once a candle reaches its price, with no partial fill and no slippage (see the Trader's [Order Types](./plugins.md#order-types)).

### Order Parameters

`createOrder` takes a `StrategyOrder`. The listing below is an excerpt of [`packages/shared/src/models/advice.types.ts`](../packages/shared/src/models/advice.types.ts), which declares it:

```typescript
// tools.createOrder(order: StrategyOrder): UUID returns the order id at once. The outcome arrives later, in
// onOrderCompleted, onOrderCanceled or onOrderErrored, whose order.id is that id.
// These eight keys and no other: createOrder refuses any other key, whatever its value.
type StrategyOrder = {
  symbol: TradingPair;                  // A watched pair (a key of tools.marketData), e.g. 'BTC/USDT'
  type: 'STICKY' | 'MARKET' | 'LIMIT';  // In upper case, as written here: ccxt's 'market' is refused
  side: 'BUY' | 'SELL';                 // In upper case, as written here: ccxt's 'buy' is refused
  // The size of the order, by at most one of the next three keys; all three left out, the order is all-in (see below)
  amount?: number;                      // A number above 0, in the asset: 0.5 for 0.5 BTC on BTC/USDT
  cost?: number;                        // A number above 0, in the currency: what a BUY may spend, its fee included, or the worth a SELL sells
  allocation?: number;                  // A share of the free balance the Trader read last, in percent: above 0 and at most 100 (25 for 25%)
  price?: number;                       // A number above 0; left out, the last price of the pair (see below)
  // Optional, BUY orders only: a trailing stop armed when the BUY completes, which then sells the amount bought with a
  // MARKET order (see Trailing Stops). No key but these two
  trailing?: {
    percentage: number;                 // Distance of the stop below the highest price since activation, above 0 and below 100 (2.5 for 2.5%)
    trigger?: number;                   // Price above 0 that activates it (active at once when omitted)
  };
};
```

- **`amount`**: in the asset, `0.5` for 0.5 BTC on BTC/USDT. A BUY with an `amount` is placed as asked, never capped: above the most the market takes in one order, the exchange refuses it.
- **`cost`**: a sum in the currency of the pair, the USDT of BTC/USDT. A BUY may spend it, the 5 % kept back for the fee included, and is sized at `price` as an all-in BUY is: a `cost` of 600 USDT at 100 buys 5.7 BTC. A SELL sells that worth of the asset at `price`, its fee coming out of the proceeds: a `cost` of 600 USDT at 100 sells 6 BTC.
- **`allocation`**: a share, in percent, above 0 and at most 100 (`25` for 25 %), of the balance the Trader read at its last synchronization. A BUY spends that share of the currency read and of what your BUYs still open at that read hold of it, reserved or spent on their fills, sized as a BUY by `cost` is: `allocation: 100` buys what an all-in BUY does. A SELL sells that share of the asset free.
- **None of the three**: the order is all-in. A BUY spends the free currency, sized at `price` with 5 % kept back for the fee, in decimal (600 USDT at 100 buy 5.7 BTC); a SELL sells the free asset. Each is sized from what the orders of its side sent since the Trader's last read leave of that balance.
- **`price` left out**: the last price of the pair, the close of the last one-minute candle or the bid read at the Trader's last synchronization, whichever came last. It is the limit of a `LIMIT` order, and what a BUY without an `amount`, or a SELL by `cost`, is sized at.

The Trader caps the order and warns (see its [Sizing](./plugins.md#sizing)): a SELL at the free balance it read less what the SELLs placed since take, a BUY by `cost` or `allocation` at the currency the BUYs placed since leave, and every SELL, the trailing stop's included, and every BUY without an `amount` at the most the market takes in one order of its type (the maximum of its amount range, narrowed for a `MARKET` order by Binance's MARKET_LOT_SIZE, or in a backtest by the `market` range of the pair's `marketData` when it states one, see [Backtest Mode](./modes.md#-backtest-mode)). `onOrderCompleted` then gets the amount executed, and the rest stays held, or unspent, for a later order. Three consequences to design your strategy around:

- **A share is of the balance read, not of what the orders sent since leave.** With 1000 USDT read, two BUYs of `allocation: 50` sent on one candle, on BTC/USDT and ETH/USDT, spend 500 USDT each (4.75 BTC at 100), where an all-in BUY on the first pair would leave the second nothing. The Trader reads the balance every `exchangeSynchInterval` in realtime (an `exchange` option, 10 minutes by default), every `watch.timeframe` in a backtest (10 minutes at least), and after the end of each order: a deposit, or a trade made by hand or by another bot, counts from the next read. `tools.positions` shares the currency so among the pairs it tracks, as the built-in signal strategies trade (see [Tracking Your Position](#tracking-your-position), and [Pairs and Capital](./built-in-strategies.md#pairs-and-capital) for the share each BUY takes).
- **The second all-in BUY of a candle is refused.** It is sized from what the first leaves of the currency read: nothing. It is sized to 0, warned of, and refused by the exchange: an `onOrderErrored` that counts towards `maxConsecutiveErrors`. Send one, or share the currency with `allocation`.
- **An order too small for the market is refused, and counts.** An order whose amount, truncated to the market's amount step, is below its minimum amount (`amount.min` in `tools.marketData`, that of a market order for a `MARKET` one), or whose cost is below its minimum cost (`cost.min`), is refused by the exchange: an `onOrderErrored` that counts towards `maxConsecutiveErrors`. The Trader warns before it sends one it sized, by `cost`, `allocation` or all-in for a BUY, but not one the step cuts to 0, whose refusal names the step. A BUY keeps 5 % of its budget back for the fee, so a `cost` of 10 USDT places 9.5 USDT worth, under a minimum of 10, and the step can take up to one step's worth off. The Trader values the order at its price, the one your strategy gave or else the last price of the pair (the close of the last one-minute candle or the bid of the Trader's last synchronization, whichever came last), while a live exchange checks a market order at its ticker: near the minimum, the two can disagree.

The order events carry `cost` and `allocation` as your strategy gave them, beside `amount`, the amount the Trader sized (in `onOrderCompleted`, the amount executed). The Trader logs how it sized each order by `cost` or `allocation` at `debug` level (`[<id>] BUY MARKET order of 600 USDT sized to 5.7 BTC at 100`).

`createOrder` checks the order before it sends anything. The order takes no key but the eight of `StrategyOrder` above: any other, a misspelt `prise` or a `quantity` for instance, is refused whatever its value, as the Trader would ignore it (a LIMIT would go at the last price of the pair, an order all-in). `symbol` must be a watched pair. `side` must be `'BUY'` or `'SELL'` and `type` `'MARKET'`, `'STICKY'` or `'LIMIT'`, in upper case. `amount`, `cost` and `price` must be numbers above 0, or left out: `0`, a negative number, `NaN`, `Infinity` and a quoted number such as `'0.5'` are refused, and so is an `allocation` that is not such a number, or is above 100. An order gives at most one of `amount`, `cost` and `allocation`, a key left `undefined`, or `null` in a JavaScript strategy, counting as left out: two of them are refused, even when they agree. `trailing` goes on a BUY only, with no key but `percentage`, above 0 and below 100, and `trigger`, above 0 or left out. Anything else throws a `GekkoError` naming the field and what it accepts, for example `[STRATEGY] Impossible to create the buy MARKET order on BTC/USDT: side must be one of 'BUY', 'SELL', got 'buy'`. The order is not sent and Gekko stops (exit code 1), even for an amount, a cost or a share your strategy computed as 0. A TypeScript strategy cannot pass a lower-case side or type, or a quoted number, without a cast; a JavaScript one, which Bun loads without type-checking, can. TypeScript refuses an unknown key in an object literal only, not in a variable or a spread, such as the order of an event: the keys check catches what the compiler lets through.

### Examples

```typescript
// Full position market buy
createOrder({ symbol: 'BTC/USDT', type: 'MARKET', side: 'BUY' });

// Specific amount sticky sell
createOrder({ symbol: 'BTC/USDT', type: 'STICKY', side: 'SELL', amount: 0.5 });

// Limit order at specific price
createOrder({ symbol: 'BTC/USDT', type: 'LIMIT', side: 'BUY', price: 42000, amount: 0.1 });

// 100 USDT of BTC, the 5% kept back for the fee included: 95 USDT worth at the last price
createOrder({ symbol: 'BTC/USDT', type: 'MARKET', side: 'BUY', cost: 100 });

// A quarter of the BTC the Trader read at its last synchronization. Completed, a SELL of yours cancels the trailing stops armed on
// the pair, whatever it sold (see Trailing Stops below)
createOrder({ symbol: 'BTC/USDT', type: 'MARKET', side: 'SELL', allocation: 25 });

// Half of the USDT the Trader read last for each of two pairs: both BUYs go through on the same candle, where an all-in BUY on
// BTC/USDT would leave the one on ETH/USDT nothing to spend
createOrder({ symbol: 'BTC/USDT', type: 'MARKET', side: 'BUY', allocation: 50 });
createOrder({ symbol: 'ETH/USDT', type: 'MARKET', side: 'BUY', allocation: 50 });

// Full position market buy, then a stop trailing 2.5% below the highest price once the price reaches 45000.
// Keep the id: tools.cancelTrailingOrder(orderId) drops the stop, as does a SELL of yours on the pair once it completes.
const orderId = createOrder({ symbol: 'BTC/USDT', type: 'MARKET', side: 'BUY', trailing: { percentage: 2.5, trigger: 45000 } });

// Through the position book Gekko keeps for your strategy, once init has had it track the pair (see Tracking Your Position): a BUY of the
// pair's share of the currency, pending until its outcome, and undefined when skipped as too small on several pairs
const bookOrderId = tools.positions.buy({ symbol: 'BTC/USDT', type: 'STICKY' });
```

### Trailing Stops

A `trailing` on a BUY asks Gekko to protect what the BUY buys: a stop follows the price up, and sells at the market once the price falls `percentage` below its highest point. On Hyperliquid, which has no market order, its SELL is an immediate-or-cancel limit order 5 % below the bid (see [Order Types](./plugins.md#order-types)): what the book does not fill within that bound is canceled, and a SELL canceled after a partial fill leaves the stop as the table below says. Gekko trails it on every one-minute candle, whatever the timeframe, and tells your strategy through two hooks, which get `tools` as their last argument.

- **Armed when the BUY completes**, for the amount it filled, from a copy of `trailing` taken by `createOrder`: changing your object afterwards changes nothing. A BUY canceled loses its stop, even after a partial fill. A BUY that errors after a reported fill (`order.filled`) gets its stop for that part; one that errors with no fill reported loses it. A warning says which, and whether the BUY may still be live on the exchange.
- **Kept in Gekko's memory, not on the exchange**: a stop lasts as long as the run. When Gekko stops (Ctrl-C, SIGTERM, a deploy, an error), every stop is lost, with no warning when a signal or an uncaught exception ends it. The next run arms none for what you hold: only a BUY of that run arms one. Check your positions on the exchange when you stop Gekko (see [Stopping and Restarting a Live Run](./modes.md#stopping-and-restarting-a-live-run)).
- **Activated**: a stop without `trigger` is active as soon as it is armed, and `onTrailingStopActivated(state, tools)` is called then, right after `onOrderCompleted`, or right after `onOrderErrored` for a BUY that errored after a reported fill (its stop armed for that fill), its peak and its stop price still 0. It takes its first peak from the open of the next one-minute candle, not from the price the BUY filled at: the price can fall more than `percentage` below that price before the stop triggers. A stop with a `trigger` waits until the high of a one-minute candle reaches it. Its peak is then that candle's open when the open reached the trigger, else its high, and `onTrailingStopActivated` is called before the rest of that candle is trailed.
- **Trailed**: each one-minute candle is met as open, low, high, close, each price tested against the stop price, `peak × (1 − percentage / 100)`, before it raises the peak. So a candle that rises more than `percentage` from its open does not trigger the stop on its own low. The candle that activates a stop with a trigger is met from its open when the open reached the trigger; otherwise only its close is tested, after its high.
- **Triggered**: a price at or below the stop price makes Gekko create a MARKET SELL of the stop's amount, then call `onTrailingStopTriggered(orderId, state, tools)`, `state` holding the peak and the stop price of that moment. That SELL is an order of your strategy's from then on: its outcome comes through `onOrderCompleted`, `onOrderCanceled` or `onOrderErrored`, under `orderId`. When the stop's BUY was placed through `tools.positions.buy`, the position book has taken that SELL for its own by the time `onTrailingStopTriggered` runs: the pair is pending until that SELL ends, and its outcome settles the position (see [Tracking Your Position](#tracking-your-position)). A strategy that keeps its position itself adopts it as its pending SELL; otherwise it stays long once the stop has sold everything, and its next SELL is refused, nothing being left to sell.
- **Selling**: the stop (`state.status` `'selling'`, `state.sellOrderId` its SELL) sells until that SELL ends, then is over, or active again for what that SELL did not sell (see the table below). A SELL sells less than the stop's amount when the Trader caps it, to the free balance and to the most the market takes in one order, or when the exchange truncates its amount to the market's step.
- **Your own SELLs**: while a SELL your strategy created is pending on a pair, the stops of that pair keep trailing but do not trigger (`[STRATEGY] Trailing stop of BUY <id> held back: …`, once per stop, at info level): the exchange reserves the asset for your SELL, and the stop's SELL would be refused. Completed, your SELL cancels every stop armed on the pair, whatever the amount sold, with an info line: a strategy that scales out loses its stops at its first SELL. Canceled or errored, with no other SELL of yours pending there, it releases them (`… resumes: …`), and the next price at or below a stop price triggers that stop. So a take-profit LIMIT SELL left pending leaves the position without a working stop for as long as it pends, the part it does not reserve included. The SELL a stop sends cancels no other stop, and a stop whose BUY has not completed yet is kept.
- **Canceled by you**: `tools.cancelTrailingOrder(state.id)`, `state.id` being the BUY's id, at any time. From `onTrailingStopActivated`, the stop is gone before the rest of its activation candle is trailed. To take over from a stop that is selling, cancel the stop, not its SELL: a canceled SELL makes the stop active again.

What becomes of the stop once its SELL ends (each case after the first is logged: see [Trailing stop lines](#trailing-stop-lines)):

| How the stop's SELL ends                                                                                         | What becomes of the stop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
|------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Completed for all of the stop's amount                                                                           | Over                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Errored or canceled after a reported fill (`order.filled`) of all of the stop's amount                           | Over, said at info level under the `trailing stop` tag: `Trailing stop of BUY <id> over: its SELL <id> sold 0.5, all of its 0.5`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| For less (completed, errored or canceled), the rest too little to sell at the minimums of the market             | Over, whatever else your account holds, and even when that SELL may still be live (`… over: …, and the rest, 0.0001 BTC, is too little to sell at the minimums of the market`, at info level). Checked before the rows below                                                                                                                                                                                                                                                                                                                                                  |
| For less, the portfolio read after it showing too little of the asset free, no SELL of yours pending on the pair | Over, at info level, after a SELL that completed (one whose BUY's fee the exchange took from the asset bought, for instance); removed, with a warning (`… removed: …`), after one that errored or was canceled                                                                                                                                                                                                                                                                                                                                                                |
| For less, its portfolio read before its end (`exchange.portfolioReadAfterOrder` `false`)                         | Not ended on that portfolio, an earlier read (the Trader's read after the end failed), which may count as used what the SELL reserved, or still show free what it sold: active again for the rest, or kept when that SELL may still be live, its warning adding that the Trader could not read the balances after it                                                                                                                                                                                                                                                          |
| The same, the rest being gone                                                                                    | The stop's next SELL is refused, and the portfolio read after that refusal removes the stop, unless your account holds other coins of the asset free, which that SELL sells, up to the stop's amount                                                                                                                                                                                                                                                                                                                                                                          |
| Errored while it may still be live on the exchange (`order.mayBeLive`), for a rest it can sell                   | Kept, active again for that rest, with a warning to check that SELL on the exchange (`… kept: …`): its answer was lost, or the exchange was busy or overloaded, and a MARKET SELL, which rests on no book, may only have executed. If it did, the portfolio after it shows the asset gone and the stop is removed, or the stop's next SELL is refused for lack of anything to sell and that refusal removes it, unless your account holds other coins of the asset free, which that SELL sells, up to the stop's amount. If it did not, the stop still protects your position |
| For less, in any other case                                                                                      | Active again for what that SELL did not sell, from the peak and the stop price it triggered at, with a warning (`… active again: its SELL <id> completed after selling 0.3 of its 0.5 BTC …`): the next price at or below that stop price triggers it again, and `onTrailingStopTriggered` announces its new SELL under a new id, which the position book adopts as it adopted the first (a strategy that keeps its position itself adopts it too)                                                                                                                            |
| Refused every time with the asset still free (an API key refused, a cost above the maximum of the market)        | Sent again on each minute whose price reaches the stop price, each refusal counting towards `maxConsecutiveErrors`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`state` is a `TrailingStopState` (`@gekko/strategies/trailingStopManager.types`): `id` (its BUY's), `symbol`, `amount` (what its SELL sells), `config` (the `trailing`), `status` (`'dormant'` until its trigger is reached, `'active'`, `'selling'`), `highestPeak`, `stopPrice`, `activationPrice` (the trigger), `createdAt` and, while it sells, `sellOrderId`.

---

## Tracking Your Position

`createOrder` returns before the exchange has seen the order, and Gekko relays every order you create: a strategy that advises a BUY on every candle of an uptrend sends an all-in BUY on each, each sized from what the ones before left, until they are refused for want of currency and the circuit breaker stops the bot. So a strategy that trades all-in keeps its position and its pending order, and moves them only on the outcome of its orders:

- it buys only when flat and sells only when long, never while an order of its own is pending;
- a completed BUY makes it long, a completed SELL flat, unless it sold less than it asked for (an all-in SELL asks for all of the asset free, and the Trader caps a SELL at the most the market takes in one order): the portfolio after it then tells, long when what is left free is enough to sell;
- an order canceled or errored may have executed before it ended, in part or in full: the position is read from what its event reports, rather than left as it was. The portfolio after the order (`exchange.portfolio`) tells what is left of the asset, a position when it is enough to sell at the minimums of the market (`tools.marketData`);
- a portfolio the Trader read before the order ended (`exchange.portfolioReadAfterOrder` is `false`: its read after the end failed) is not the state after it: read before a SELL was placed, it still shows free what the SELL sold; read while the SELL rested, it shows the order's part as used; read before a BUY filled, it misses what the BUY bought. The order's own figures settle the position when they can, and it stays as it was otherwise, until the end of the next order;
- the SELL a trailing stop sends is the strategy's own from `onTrailingStopTriggered` on: it is pending until it ends, and its outcome settles the position;
- it starts flat: a holding present at start-up is sold only by its first SELL, which follows a BUY that completed, or one that ended without completing while the account held the asset, or, on several pairs, a BUY that was skipped while the portfolio showed the asset free, enough to sell.

A strategy that trades several pairs of one currency keeps this bookkeeping pair by pair, and gives each BUY a share of the currency with `allocation` rather than all of it: all-in, the first BUY of a candle leaves the others nothing to spend, and each of their refusals counts towards the circuit breaker (see [Order Parameters](#order-parameters)).

Gekko keeps that bookkeeping for you: `tools.positions` is the position book the TradingAdvisor keeps for your strategy, wherever the strategy lives, a file loaded through `strategyPath`, which imports none of Gekko's code, included. The seven built-in signal strategies trade through it. It asks for no import and no order hook: Gekko settles the position from the outcome of each order the book placed, before your strategy's order hook runs, and shares the currency among the pairs. The decision stays your strategy's: the book refuses no BUY for being long, nor a SELL for being flat, so a strategy buys a pair only when `canBuy` allows it, and sells it only when `canSell` does.

**Trading through `tools.positions`.** Call `tools.positions.track()` in `init`, then buy a pair only when `canBuy(pair)` allows it, and sell it only when `canSell(pair)` does, through `buy` and `sell`. This strategy, which imports nothing of Gekko but its types, trades every watched pair on its RSI:

```typescript
import { IndicatorResults, InitParams, OnCandleEventParams, Strategy } from '@gekko/strategies/strategy.types';

// From the strategy: block of the configuration, e.g. period: 14, oversold: 30 and overbought: 70
type MyRsiParams = { period: number; oversold: number; overbought: number };

export class MyRsiStrategy implements Strategy<MyRsiParams> {
  init({ tools, addIndicator }: InitParams<MyRsiParams>): void {
    // Every watched pair, in the order of watch.assets, each flat with nothing pending; with several, an info line names them and
    // says how they share the currency
    tools.positions.track();
    for (const pair of tools.positions.pairs) addIndicator('RSI', pair, { period: tools.strategyParams.period });
  }

  onTimeframeCandleAfterWarmup({ tools }: OnCandleEventParams<MyRsiParams>, ...indicators: IndicatorResults[]): void {
    const { positions, strategyParams, log } = tools;
    // The indicator arguments of each pair, in the order init added them: one RSI each
    const byPair = tools.indicatorsBySymbol(indicators);
    for (const pair of positions.pairs) {
      const [rsi] = byPair.get(pair) ?? [];
      if (typeof rsi?.results !== 'number') continue;
      // canBuy: flat on the pair, nothing pending there; canSell: long, nothing pending. An order pending on another pair holds nothing
      // back here
      if (rsi.results < strategyParams.oversold && positions.canBuy(pair)) {
        // Sent with the pair's share of the currency, and pending until its outcome. On several pairs, undefined when the market would
        // refuse it as too small: nothing is sent, and the book says so. The SELL its trailing stop sends is the book's own too
        const id = positions.buy({ type: 'STICKY', symbol: pair, trailing: { percentage: 5 } });
        if (id) log('info', `[${pair}] RSI ${rsi.results.toFixed(2)}, oversold: BUY ${id}`);
      } else if (rsi.results > strategyParams.overbought && positions.canSell(pair)) {
        // All of the pair's asset free
        const id = positions.sell({ type: 'STICKY', symbol: pair });
        log('info', `[${pair}] RSI ${rsi.results.toFixed(2)}, overbought: SELL ${id}`);
      }
    }
  }
}
```

It keeps nothing of its own: no field, no order hook, no `onTrailingStopTriggered`. It buys a pair on every candle its RSI is under `oversold` while it is flat there, so after a trailing stop has sold, it buys again on the next such candle; the [Complete Example](#complete-example) waits for the next cross instead, keeping on which side of the long EMA the short one was. The members of `tools.positions`:

| Member                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                            |
|------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `track(pairs?)`        | Starts the tracking, in `init` only, once: every watched pair, in the order of `watch.assets`, or the pairs given, in their order (`track(['ETH/USDT'])`), each flat with nothing pending. With several pairs, it logs one `info` line naming them and how they share the currency (`Trading BTC/USDT and ETH/USDT: each BUY takes an equal share of the free currency among the pairs not invested, each SELL sells all of its asset`) |
| `pairs`                | The pairs tracked, in the order `track` took them, none before it: the book's own list, to read, not to write to                                                                                                                                                                                                                                                                                                                        |
| `canBuy(pair)`         | Flat on the pair, with nothing pending there; `false` for a pair not tracked                                                                                                                                                                                                                                                                                                                                                            |
| `canSell(pair)`        | Long on the pair, with nothing pending there; `false` for a pair not tracked                                                                                                                                                                                                                                                                                                                                                            |
| `isLong(pair)`         | Whether your strategy holds enough of the pair's asset to sell, as the outcomes of the book's orders tell; `false` for a pair not tracked                                                                                                                                                                                                                                                                                               |
| `isPendingOrder(pair)` | Whether an order of the book on the pair, the SELL of a stop it took over included, waits for its outcome; `false` for a pair not tracked                                                                                                                                                                                                                                                                                               |
| `buy(order)`           | Sends a BUY of `order.symbol` sized by the book, keeps it pending and returns its id, or `undefined` for a BUY it skips (on several pairs, see below). `order` holds `symbol`, `type`, and a `price` or a `trailing` if any. It does not check `canBuy`: a BUY asked for while long, or while an order is pending, is sent all the same                                                                                                 |
| `sell(order)`          | Sends a SELL of all of the pair's asset free, keeps it pending and returns its id. As a SELL of `createOrder`, it holds the trailing stops of its pair back while it pends, and cancels them once it completes. `order` holds `symbol`, `type`, and a `price` if any. It does not check `canSell`                                                                                                                                       |

`tools.indicatorsBySymbol(indicators)` groups a hook's indicator arguments by pair: the arguments of each pair in the order of its `addIndicator` calls, the pairs in the order of their first indicator, so that a strategy that adds the same indicators on every pair reads those of a pair as it would read the flat arguments on one pair (`const [shortEma, longEma] = byPair.get(pair) ?? []`). It groups the arguments it is given, at each call: the results change on every candle. Name the pair in the lines you log about it, as the built-in strategies do (`[BTC/USDT] …`): on several pairs, a line that does not say which is hard to follow.

**How the book settles a position.** It reads the outcome of each of its orders before your strategy's order hook runs, as the list above has it:

- **A completed BUY** makes the pair long.
- **A completed SELL** asked for all of the asset free, an amount the book does not know: it is read from the free balance of the asset in the portfolio after it, long when enough is left to sell (after a SELL the Trader capped at the most the market takes in one order, or when coins reached the account after the Trader last read its balance), said at `info` level, flat otherwise. So is the SELL of a trailing stop the book took over.
- **A canceled or errored order** is read from what its event reports: what a canceled BUY reported filled; otherwise the free balance of the asset in the portfolio after the order. A SELL canceled after a fill is read from that balance too, its fill telling what is left of the order, not of the holding, but never as less than what it left unsold, which the cancelation released (a portfolio read before the cancelation, or never, leaves that out). An order whose event reports neither a fill nor a balance of the asset leaves the position as it was. A position read so that differs from the one held is said at `info` level (`[<id>] BUY order errored: 10 BTC free in the portfolio after it, enough to sell: the strategy is long`).
- **Enough to sell** is what passes the market's minimums: the amount truncated to the market's amount step, then checked against its minimum amount and its minimum cost, the cost worked out in decimal, as the exchange checks a SELL.
- **A portfolio the Trader read before the order ended** (`exchange.portfolioReadAfterOrder` is `false`) is not read. The book goes by the order's own figures: a completed BUY makes the pair long, a canceled BUY's fill settles it as above, and what a SELL canceled after a fill left unsold, which the cancelation released, or what a BUY that errored filled, makes it long when enough to sell. Anything else keeps the position as it was, said at `warn` level, until the end of the next order reads it again: a completed SELL, a cancelation without its fill, a SELL that errored, whose rest the error does not show held, and an unsold rest or an errored BUY's fill too little to sell (`[<id>] SELL order completed after selling 1 BTC, and the Trader could not read the balances after it: the strategy stays long until the end of its next order`). Kept long after a SELL that sold everything, the strategy sells again at its next SELL signal: that SELL is refused, nothing being left to sell (an `onOrderErrored`, which counts towards `maxConsecutiveErrors`), and the portfolio read after the refusal makes the pair flat. A `portfolioReadAfterOrder` of `true`, or left out (before the Trader's first read), reads the portfolio as above.
- **A holding present at start-up**: every pair starts flat. On one pair, an account that holds the asset but too little currency to buy has its first all-in BUY refused; the book then reads the asset free in the portfolio after that refusal, takes it for the position when it is enough to sell, and the strategy sells it at its next SELL signal. On several pairs, a BUY too small for the market is skipped instead, and the book takes the holding at once, said at `info` level (see below).
- **The SELL of a trailing stop** whose BUY the book placed (a `trailing` given to `buy`) is the book's own: taken over before `onTrailingStopTriggered` runs, the pair pending until that SELL ends, its outcome settling the position as that of the book's own SELL does. A stop made active again for what its SELL did not sell, and triggered once more, sells through the book again.
- **An order the book did not place** changes nothing: one your strategy created with `tools.createOrder`, and the SELL of a stop whose BUY it created so. An order counts once: its first outcome settles it.

Every line of the book goes through your strategy's log, under the `strategy` tag: its `info` and `warn` lines reach the EventSubscriber's `strat_info` subscribers, as your own do.

**Several pairs, one currency.** Each BUY takes an equal share of the free currency among the pairs tracked that are not long, the pair buying and those whose BUY is pending among them, sent as its `allocation`: 100 / n %, rounded down to 6 decimals, so 50 % on two pairs and 33.333333 % on three. The last pair not invested, or a pair tracked alone, buys all-in, without an `allocation`. The book estimates a BUY from what Gekko holds, none of it the copies your hooks get: the latest portfolio received (the balance read at start-up, then the one the Trader sends with a portfolio change or with the end of an order, which replaces it before that order's hook runs, so that a BUY placed from `onOrderCompleted` is estimated from the balances read after the order), the market data of the pair, and the BUY's `price`, else the close of the pair in the last timeframe candle. That close is the estimate's price for a BUY placed from an order hook too, while the Trader sizes such a BUY at the last price it knows, which can be a later minute's. Writing to the portfolio, the candle or the market data a hook gets changes nothing for the book. On several pairs, a BUY the market would refuse as too small, its share under the minimum cost of the market or its amount, truncated to the amount step, under its minimum amount or cost, is skipped: nothing is sent, nothing counts towards `maxConsecutiveErrors`, `buy` returns `undefined`, and the book says so, at `warn` level the first time for a pair and at `debug` level until a BUY of that pair is placed (see [Pairs and Capital](./built-in-strategies.md#pairs-and-capital) for the estimate and the lines). When the pair is flat with nothing pending and the portfolio shows enough of its asset free to sell at the close, the skipped BUY makes the pair long instead, said at `info` level; long already, or with an order pending, the pair keeps its position, and the skip is warned of as any other. A book that tracks one pair never skips: its all-in BUY is sent, and refused when the currency is too little, the Trader warning first when it is below a minimum of the market (see [Position and Orders](./built-in-strategies.md#position-and-orders)).

The pairs that share the currency are those the book tracks, not those watched: tracked alone, a pair buys all-in, whatever else is watched. A strategy that tracks a list of pairs of its own sizes the orders of the other pairs itself (see below), and shares the currency between the two: the all-in BUY of the book's last pair not invested spends all that is free. For such a strategy, the skip line's advice to `watch fewer pairs` means fewer pairs tracked.

**What stops Gekko.** `tools.positions` throws a `GekkoError`, which stops Gekko (exit code 1), for a call it cannot have meant:

- `track`, in this order: called once `init` has returned, from a later hook (`[STRATEGY] Impossible to track positions: tools.positions.track is available in init only`); given anything but a list of at least one pair (`[STRATEGY] Impossible to track positions: pairs must be an array of at least one watched pair, or left out to track every watched pair, got []`, or `got 'BTC/USDT'` for a pair alone); given a pair that is not watched (`[STRATEGY] Impossible to track positions on XRP/USDT: symbol must be one of the watched pairs (BTC/USDT, ETH/USDT), got 'XRP/USDT'`, every pair given checked before the next refusal), or a pair twice (`… pairs must name each watched pair once, got 'BTC/USDT' twice`); called a second time from `init` (`[STRATEGY] The position book tracks its pairs already: track is called once, from init`). Left out, or `null` in a JavaScript strategy, the pairs are every watched pair, in the order of `watch.assets`;
- `buy` and `sell`, in this order: during the warmup, as `createOrder` (`[STRATEGY] Orders are not available until the warmup is over: …`); for an order holding a key other than `symbol`, `type`, `price` and, for `buy`, `trailing`, whatever its value (`[STRATEGY] Impossible to create the BUY MARKET order on BTC/USDT: tools.positions.buy takes no key but 'symbol', 'type', 'price', 'trailing', got 'amount': the position book sizes the order (tools.createOrder takes an amount, a cost or an allocation)`, the reason after the keys only for an `amount`, a `cost` or an `allocation`: `…, got 'side'` for a side); for whatever `createOrder` refuses of its pair, its type, its price and its trailing (see [Order Parameters](#order-parameters)); then, in the book, for a watched pair it does not track (`[STRATEGY] Impossible to place the BUY STICKY order on ETH/USDT: the position book does not track it (it tracks BTC/USDT)`, or `(it tracks no pair until init calls track)` before `track`). Each of these refusals comes before the book estimates anything: a BUY so refused is never skipped.

`isLong`, `isPendingOrder`, `canBuy` and `canSell` refuse nothing: they answer `false` for a pair not tracked, and before `track`.

**Sizing your own orders.** The book decides what its orders take, a BUY its pair's share of the currency and a SELL all of the asset free, which the Trader sizes: `buy` and `sell` take `symbol`, `type`, and a `price` (and, for `buy`, a `trailing`) if any, and refuse an `amount`, a `cost` or an `allocation`. A strategy that sizes its orders itself creates them with `tools.createOrder`, and keeps its position itself, by the rules above, as the class of the [Lifecycle Methods](#lifecycle-methods) does on one pair. An order created with `createOrder` is not the book's, and its outcome changes no position, the SELL of a stop its BUY asked for included: on a pair the book tracks, a SELL of your own that sells the position leaves the book long, and the book's next SELL there is refused, nothing being left to sell, while, completed, your SELL cancels the trailing stops of the pair, those of the book's BUYs included, as any SELL of yours does. Keep the two apart: the book on the pairs it tracks (`track(['BTC/USDT'])`), `createOrder` on the others. Even apart, they share the currency, and the book estimates its BUYs without yours: to the currency a share is taken from, the Trader adds back what every BUY of its own still open at its read holds, those you created with `createOrder` included, while the book, which does not see them, adds back what its own BUYs hold alone, so that it can skip as too small a BUY that the Trader would have sized above the minimum of the market.

**Testing your strategy.** A strategy of `packages/strategies/src/custom/` can keep its tests beside it, in a `<name>.test.ts` that `bun run test` runs, never CI. They are vitest suites, as the built-in strategies' are (`describe`, `it` and `expect` imported from `vitest`), and can drive the strategy with the helpers those suites share, in `@gekko/strategies/strategy.mock`. `fakeTools(strategyParams, { pairs })` builds the tools a hook gets, and returns them with what they record: `positions`, a `ScriptedPositions` that stands in for `tools.positions`, `logs`, every line of `tools.log`, and `orders`, an `OrderRecorder` that stands in for `tools.createOrder`; their `indicatorsBySymbol` groups the arguments as Gekko's does. The test says what each pair answers (`positions.set('BTC/USDT', 'LONG')`: `'FLAT'` and `'LONG'`, `'BUYING'` and `'SELLING'` while an order is pending, or `'SKIPPING'`, flat with every BUY skipped, `buy` then returning `undefined`), and reads each call to `buy` and `sell` in `positions.advices`, the order as the strategy gave it, with its `side`. Placing an order changes no answer: the book's own behaviour is Gekko's, tested in Gekko's suites, and a suite checks only that each signal makes the right call. `playInit(strategy, pairs, strategyParams)` plays `init` on such tools, on a first bucket of the pairs given, and returns them with the `addIndicator` calls it made. `playPositionSteps(steps, positions, playCandle)` plays a scenario: a step that names a position for each watched pair, in their order (`'LONG'` on one pair, `'LONG/FLAT'` on two), sets them, and any other step is a candle your `playCandle` plays (`'up BUYING down LONG down'`). For a strategy that creates its orders itself, `relayOrderOutcome` plays the end of an order with the facts its event reports (a fill, an error's `mayBeLive`, the portfolio after it and `portfolioReadAfterOrder`), and `playSteps` plays candles and order outcomes in turn. `flatBucket` builds a flat candle of each pair, and `indicatorArguments` the hooks' indicator arguments, pair by pair.

---

## Configuration File

### TradingAdvisor Plugin Configuration

The key configuration for custom strategies is in the `TradingAdvisor` plugin, here for the [Complete Example](#complete-example) below:

```yaml
plugins:
  - name: TradingAdvisor
    strategyName: EMACrossover    # Must match your exported class name
    strategyPath: /home/user/strategies/emaCrossover.strategy.ts  # Path to your strategy file
    maxConsecutiveErrors: 5       # Optional: order errors in a row that stop Gekko (at least 1, or -1: never)

  - name: Trader                  # Executes the orders the strategy creates
```

| Parameter              | Type    | Required                            | Description                                                                                                                                                                                                                                     |
|------------------------|---------|-------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `strategyName`         | string  | Yes                                 | The exact name of your exported class                                                                                                                                                                                                           |
| `strategyPath`         | string  | For a strategy outside the codebase | Path to your strategy file, absolute, or relative to the directory Gekko is started from (not to the configuration file). Left out, Gekko looks `strategyName` up among its own strategies, those of `packages/strategies/src/custom/` included |
| `maxConsecutiveErrors` | integer | No (`5`)                            | Order errors in a row after which Gekko stops, with exit code 0: the circuit breaker. At least `1`, or `-1` to never stop; `0` is refused                                                                                                       |

With a `strategyPath`, Gekko takes `strategyName` from that file only, never from its own strategies: a built-in name beside a path, such as `strategyName: RSI`, stops Gekko at start-up (`[TRADING ADVISOR] Cannot find external RSI strategy in <path>`) unless the file exports a class of that name (see [Troubleshooting](#cannot-import-the-strategy-file--or-cannot-find-external--strategy)).

A strategy that creates orders needs a `Trader` beside it (on `paper-binance` or `dummy-cex` the orders are only simulated). Without one, no order ever ends: a strategy that waits for its orders, as the position tracking above does, never advises again, and Gekko warns at start-up, at `warn` level (`TradingAdvisor emits strategyCreateOrder, but no configured plugin executes orders…`). A strategy that never creates orders, and only logs, needs none and can ignore that warning. See the [TradingAdvisor](./plugins.md#-tradingadvisor) and the [Trader](./plugins.md#-trader).

### Strategy Parameters

The top-level `strategy:` block holds your parameters, beside a `name` that must equal the TradingAdvisor's `strategyName` and labels the run (the backtest log, the PerformanceReporter rows). With a `schema` (see below), your strategy gets the schema's output as `tools.strategyParams`, without `name`. Without one, it gets the whole block, `name` included, unchecked: a misspelt parameter is simply `undefined`. For the [Complete Example](#complete-example):

```yaml
strategy:
  name: EMACrossover       # Must equal the TradingAdvisor strategyName; labels the run
  src: close               # Accessible via tools.strategyParams.src
  shortPeriod: 12          # Accessible via tools.strategyParams.shortPeriod
  longPeriod: 26           # Accessible via tools.strategyParams.longPeriod
  trailingPercentage: 5    # Optional: accessible via tools.strategyParams.trailingPercentage
```

### Validating Your Parameters

To have the block checked, give your class a static `schema`: a [zod](https://zod.dev) schema of its parameters. Gekko parses the block with it when it creates the strategy, before the first candle, and your strategy then gets the schema's output instead of the block. The [Complete Example](#complete-example) declares this one, with a default for `src`:

```typescript
import { Strategy } from '@gekko/strategies/strategy.types';
import { z } from 'zod';

const emaCrossoverSchema = z.strictObject({
  src: z.enum(['close', 'open', 'high', 'low']).default('close'),
  shortPeriod: z.number().int().positive(),
  longPeriod: z.number().int().positive(),
  trailingPercentage: z.number().gt(0).lt(100).optional(),
});

// What tools.strategyParams holds: src set to close when the block leaves it out, trailingPercentage undefined
type EMACrossoverParams = z.infer<typeof emaCrossoverSchema>;

export class EMACrossover implements Strategy<EMACrossoverParams> {
  static schema = emaCrossoverSchema;

  // The rest of the class: see the Complete Example
}
```

- The schema gets the block without its `name`, which only labels the run and which Gekko checks against `strategyName`: leave `name` out of the schema, and out of what you read from `tools.strategyParams`.
- Use `z.strictObject`, for nested objects too: `z.object` drops an unknown key without a word, so a misspelt parameter that has a default would quietly take it.
- `tools.strategyParams` is the schema's output: its defaults applied, and its transforms if it has any. Deriving the parameters type from the schema with `z.infer`, as above, keeps the two in step.
- Any problem stops Gekko before the first candle, with exit code 1, and the log lists every problem with the path of its parameter. Gekko logs that list twice, each time in one JSON line whose line breaks are written `\n`: as the reason the run closes (`Gekko is closing the application due to an error: …`), then as the run's failure. With `shortPeriod: '12'` (quoted, so a string) and a misspelt `longPeriode`, its message reads:

  ```text
  [TRADING ADVISOR] Invalid parameters for strategy EMACrossover (strategy block):
  ✖ Unrecognized key: "longPeriode"
  ✖ Invalid input: expected number, received string
    → at shortPeriod
  ✖ Invalid input: expected number, received undefined
    → at longPeriod
  ```

Without a `schema`, the whole block, `name` included, reaches the strategy unchecked, and Gekko says so as it starts, in an `info` line.

Your strategy imports `zod` itself, and like any package it is looked up from the strategy file's folder: unless the file sits inside a Gekko checkout, whose `node_modules` has it, install it next to the strategy (`bun add zod` or `npm install zod` in its folder). Otherwise Gekko stops with `[TRADING ADVISOR] Cannot import the strategy file …/emaCrossover.strategy.ts: ResolveMessage: Cannot find package 'zod' imported from …/emaCrossover.strategy.ts`. The same goes for any other package (see [Where Your Strategy Lives](#where-your-strategy-lives) for the packages the compiled executable cannot find).

---

## Running with Executable

### Build the Executable

```bash
bun run build:exec
```

This creates standalone binaries at `dist/gekko` and `dist/fox` that run **without Bun installed**. A strategy loaded through `strategyPath` is not compiled into it: the binary loads its file each time it starts, so a change to the strategy needs no new build (one in `packages/strategies/src/custom/` does).

### Run Your Strategy

```bash
# From the directory a relative strategyPath (and storage.database) is resolved against
GEKKO_CONFIG_FILE_PATH=./config/myStrategy.local.yml ./dist/gekko

# From any directory, when strategyPath and storage.database are absolute (recommended for deployment)
GEKKO_CONFIG_FILE_PATH=/path/to/config.yml /path/to/gekko/dist/gekko
```

> [!TIP]
> When deploying, use absolute paths for `strategyPath` to avoid working directory issues:
> ```yaml
> strategyPath: /home/user/strategies/myStrategy.strategy.ts
> ```

---

## Complete Example

Here's a complete EMA crossover strategy, loaded through `strategyPath`, which validates its parameters, trades every watched pair through `tools.positions`, buys a pair on its golden cross, sells it while its short EMA is below the long one, and can protect each position with a trailing stop:

### Strategy File: `/home/user/strategies/emaCrossover.strategy.ts`

```typescript
import { TradingPair } from '@gekko/shared/models/utility.types';
import { IndicatorResults, InitParams, OnCandleEventParams, Strategy, Tools } from '@gekko/strategies/strategy.types';
import { TrailingStopState } from '@gekko/strategies/trailingStopManager.types';
import { UUID } from 'node:crypto';
import { z } from 'zod';

const emaCrossoverSchema = z.strictObject({
  src: z.enum(['close', 'open', 'high', 'low']).default('close'),
  shortPeriod: z.number().int().positive(),
  longPeriod: z.number().int().positive(),
  // Optional: each BUY gets a stop trailing this far below the highest price since (5 for 5%), which sells at the market when hit
  trailingPercentage: z.number().gt(0).lt(100).optional(),
});

type EMACrossoverParams = z.infer<typeof emaCrossoverSchema>;
// Whether the short EMA of a pair was above its long one on the candle before, and whether it is on this one: null until the two first
// differ. A golden cross is a candle on which the first is false and the second true
type Sides = { wasShortAbove: boolean | null; isShortAbove: boolean | null };

// The sign of a - b, but 0 when they are within a relative tolerance of each other. Two EMAs equal in exact arithmetic, on a market
// that has not moved since the first candle, come out a few ulps apart, either way: compared strictly, that noise is a cross, and an
// order. Gekko's compareWithTolerance, copied: a file loaded through strategyPath cannot import it
const compareWithTolerance = (a: number, b: number, tolerance = 1e-9): number => {
  if (a === b) return 0;
  const difference = a - b;
  if (Number.isFinite(difference) && Math.abs(difference) <= tolerance * Math.max(Math.abs(a), Math.abs(b))) return 0;
  return Math.sign(difference);
};

export class EMACrossover implements Strategy<EMACrossoverParams> {
  static schema = emaCrossoverSchema;

  // The sides of each pair traded, set at init. The position of each pair is not kept here: tools.positions keeps it, from the outcome
  // of each order it placed
  private readonly sides = new Map<TradingPair, Sides>();

  init({ addIndicator, tools }: InitParams<EMACrossoverParams>): void {
    const { src, shortPeriod, longPeriod } = tools.strategyParams;
    // Every watched pair, in the order of watch.assets, each flat with nothing pending: the position book Gekko keeps for the strategy,
    // which a file loaded through strategyPath needs no import for. With several pairs, an info line names them
    tools.positions.track();
    for (const pair of tools.positions.pairs) {
      this.sides.set(pair, { wasShortAbove: null, isShortAbove: null });
      addIndicator('EMA', pair, { period: shortPeriod, src });
      addIndicator('EMA', pair, { period: longPeriod, src });
    }
  }

  // Runs on every candle, the warmup included, before log and onTimeframeCandleAfterWarmup: the side it moves aside is the previous
  // candle's, so the first candle after the warmup is compared with the last warmup candle
  onEachTimeframeCandle({ tools }: OnCandleEventParams<EMACrossoverParams>, ...indicators: IndicatorResults[]): void {
    // The indicator arguments of each pair, in the order init added them: its short EMA, then its long one
    const byPair = tools.indicatorsBySymbol(indicators);
    for (const [pair, side] of this.sides) {
      side.wasShortAbove = side.isShortAbove;
      const [shortEma, longEma] = byPair.get(pair) ?? [];
      // results is unknown, and null until the EMA has seen enough candles
      if (typeof shortEma?.results !== 'number' || typeof longEma?.results !== 'number') continue;
      // Above, below, or within the tolerance of each other: equal, which keeps the side they were on and crosses neither way
      const shortToLong = compareWithTolerance(shortEma.results, longEma.results);
      if (shortToLong !== 0) side.isShortAbove = shortToLong > 0;
    }
  }

  onTimeframeCandleAfterWarmup({ candle, tools }: OnCandleEventParams<EMACrossoverParams>): void {
    const { log, positions, strategyParams } = tools;
    for (const [pair, { wasShortAbove, isShortAbove }] of this.sides) {
      const close = candle.get(pair)?.close;
      if (close === undefined) continue;
      // Golden cross, flat on the pair and nothing pending there. On the cross alone, not on every candle the short EMA stays above:
      // after a trailing stop has sold, or a BUY was refused, the pair waits for its next cross
      if (wasShortAbove === false && isShortAbove && positions.canBuy(pair)) {
        const { trailingPercentage } = strategyParams;
        const trailing = trailingPercentage ? { percentage: trailingPercentage } : undefined;
        // The pair's share of the currency, all of it on one pair. On several, undefined when the market would refuse that share as too
        // small: nothing is sent, and the book says why
        const id = positions.buy({ type: 'STICKY', symbol: pair, trailing });
        if (id) log('info', `[${pair}] Golden cross at ${close}: BUY ${id}`);
      }
      // Short EMA below the long one, long on the pair and nothing pending: the death cross, or a later candle when the SELL sent then
      // did not sell the position (canceled, errored, or capped)
      else if (isShortAbove === false && positions.canSell(pair)) {
        // All of the pair's asset free
        const id = positions.sell({ type: 'STICKY', symbol: pair });
        log('info', `[${pair}] Short EMA below the long one at ${close}: SELL ${id}`);
      }
    }
  }

  log({ tools }: OnCandleEventParams<EMACrossoverParams>, ...indicators: IndicatorResults[]): void {
    for (const [pair, [shortEma, longEma]] of tools.indicatorsBySymbol(indicators)) {
      if (typeof shortEma?.results === 'number' && typeof longEma?.results === 'number') {
        tools.log('debug', `[${pair}] EMA(short): ${shortEma.results.toFixed(2)} | EMA(long): ${longEma.results.toFixed(2)}`);
      }
    }
  }

  // The stop sold at the market: its SELL is the position book's own, its pair pending until the outcome of that SELL settles the
  // position. The hook only logs it
  onTrailingStopTriggered(orderId: UUID, state: TrailingStopState, tools: Tools<EMACrossoverParams>): void {
    tools.log('info', `[${state.symbol}] Trailing stop of BUY ${state.id} hit at ${state.stopPrice}: SELL ${orderId}`);
  }

  // The other hooks are optional, and left out: tools.positions needs no order hook
}
```

The example buys on a golden cross only: `onEachTimeframeCandle`, which runs on every candle, the warmup included, records on which side of the long EMA the short one is, pair by pair, and `onTimeframeCandleAfterWarmup` buys a pair on the candle its short EMA crosses above the long one, the first candle after the warmup being compared with the last warmup candle. After a trailing stop has sold, or a BUY ended without filling, the pair waits for its next golden cross rather than buy again on the next candle its short EMA is still above, and a golden cross that comes while an order is pending on the pair is passed over. It sells a pair on every candle its short EMA is below the long one while it is long there: the death cross, or a later candle when the SELL sent then did not sell the position.

`createOrder` returns before the exchange has seen the order, and so do `tools.positions.buy` and `sell`: `onOrderCompleted`, `onOrderCanceled` or `onOrderErrored` tells later what became of it. Live, an order hook runs as the bucket after the order's end arrives, before that bucket's candle hooks; in a backtest, after the candle hooks of the bucket the order filled in. The example needs none of them: `tools.positions` settles the position of the pair from each outcome before the order hooks would run, as [Tracking Your Position](#tracking-your-position) says: a completed BUY makes it long, and a completed SELL, which may have sold less than the position, and a canceled or errored order, which may have executed first, are read from the portfolio after them. The SELL a trailing stop sends is the book's own, its BUY having been placed through `tools.positions.buy`: its outcome settles the position too. The two EMAs are compared with a copy of Gekko's `compareWithTolerance`, within whose tolerance they are equal and cross neither way (see [Validate Indicator Values](#2-validate-indicator-values)). The file imports Gekko's types only, and `zod`, which has to be installed next to it (see [Validating Your Parameters](#validating-your-parameters)). It trades every pair of `watch.assets`, each BUY taking an equal share of the free currency among the pairs not invested, all of it on one pair: the configuration below watches BTC alone, and so buys all-in. Each asset you add to `watch.assets` needs its `marketData` entry and its candles in the database.

### Configuration File: `config/emaCrossover.local.yml`

```yaml
showLogo: false

watch:
  assets: [BTC]
  currency: USDT
  mode: backtest
  timeframe: 1h
  warmup:
    candleCount: 200
  daterange:
    start: 2024-01-01
    end: 2024-11-30T23:59:00Z # Both bounds included: a day alone, 2024-11-30, would be its first minute only

exchange:
  name: dummy-cex
  marketData:
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
        precision: # Decimals of a price and of an amount, a whole number (8 = steps of 0.00000001), not a step like 0.01
          price: 8
          amount: 8
        fee:
          maker: 0.0004
          taker: 0.0007
  simulationBalance:
    - assetName: BTC
      balance: 0
    - assetName: USDT
      balance: 1000

storage:
  type: sqlite
  database: ./db/binance-BTC_USDT.sql

strategy:
  name: EMACrossover
  src: close
  shortPeriod: 12
  longPeriod: 26
  trailingPercentage: 5

plugins:
  - name: TradingAdvisor
    strategyName: EMACrossover
    strategyPath: /home/user/strategies/emaCrossover.strategy.ts

  - name: Trader

  - name: RoundTripAnalyzer
    enableConsoleTable: true
```

### Run the Backtest

The backtest reads the candles of its range from `./db/binance-BTC_USDT.sql`, the database of the [Quick Start](#3-run-your-strategy): import them first, as it says.

```bash
# Build executable (only needed once)
bun run build:exec

# Run backtest
GEKKO_CONFIG_FILE_PATH=./config/emaCrossover.local.yml ./dist/gekko
```

---

## Best Practices

### 1. Type and Validate Your Parameters

Derive your parameters type from a [schema](#validating-your-parameters): Gekko then checks the block at start-up, and the type cannot drift from what your strategy gets:

```typescript
const myParamsSchema = z.strictObject({
  short: z.number().int().positive(),
  long: z.number().int().positive(),
});

// { short: number; long: number }: the MyParams of the Lifecycle Methods
type MyParams = z.infer<typeof myParamsSchema>;

export class MyStrategy implements Strategy<MyParams> {
  static schema = myParamsSchema;
}
```

### 2. Validate Indicator Values

An indicator's `results` is typed `unknown` and stays `null` until the indicator has seen enough candles, after warmup too if the warmup is shorter than the indicator needs. From then on it is complete on every candle, a number or an object whose fields are all set (but for ROC, and TRIX built on it, `null` again on a candle whose base is 0, which prices never are), so one check on each candle is enough, whatever its shape (see [Reading Results](./indicators.md#reading-results)):

```typescript
const [ema] = indicators;
if (typeof ema.results !== 'number' || !Number.isFinite(ema.results)) return;
```

Compare a price with an average, or two averages, with a relative tolerance rather than strictly: values equal in exact arithmetic come out a few ulps apart on a flat market, and a strict comparison then trades on noise. A strategy under `packages/strategies/src/custom/` can import `compareWithTolerance` from `@gekko/shared/utils/math/math.utils`; a file loaded through `strategyPath` cannot, and carries its own copy, as the class of the [Lifecycle Methods](#lifecycle-methods) and the [Complete Example](#complete-example) do.

### 3. Track the Order, Not the Signal

Decide from your position and your pending order, which only the outcomes of your orders move, not from the last signal you acted on: a strategy that only remembers the trend it ordered on does not know whether that order went through, never sends again a BUY that was refused, and cannot tell when it holds something to sell. Act on the position instead, which `tools.positions` keeps for you (see [Tracking Your Position](#tracking-your-position)), in a strategy whose `init` has it track the pair of its two EMAs (`tools.positions.track()`):

```typescript
onTimeframeCandleAfterWarmup({ tools }: OnCandleEventParams<MyParams>, ...indicators: IndicatorResults[]): void {
  const [shortEma, longEma] = indicators;
  if (typeof shortEma.results !== 'number' || typeof longEma.results !== 'number') return;
  // Above, below, or within the tolerance of each other: equal, which is neither trend (see Validate Indicator Values)
  const shortToLong = compareWithTolerance(shortEma.results, longEma.results);

  // canBuy and canSell read the position the outcomes of the book's orders left, and are false while an order is pending on the pair:
  // a BUY refused is sent again on the next candle of the uptrend
  const { symbol } = shortEma;
  const { canBuy, canSell, buy, sell } = tools.positions;
  if (shortToLong > 0 && canBuy(symbol)) buy({ type: 'STICKY', symbol });
  else if (shortToLong < 0 && canSell(symbol)) sell({ type: 'STICKY', symbol });
}
```

Each order refused counts towards `maxConsecutiveErrors`: a strategy that would rather wait for the next trend keeps, beside its position, whether the current trend has ordered, as the built-in DEMA does, or buys on the cross alone, as the [Complete Example](#complete-example) does.

### 4. Use Appropriate Log Levels

| Level   | Use For                                                            |
|---------|--------------------------------------------------------------------|
| `debug` | Indicator values, calculation details                              |
| `info`  | Trade signals, important state changes                             |
| `warn`  | Recoverable issues, edge cases                                     |
| `error` | Fatal failures only: it throws a `GekkoError`, which stops the bot |

`debug` lines are printed only with `GEKKO_LOG_LEVEL=debug` (or `silly`), and never sent to Telegram: below that level they cost nothing but building the message. `info`, `warn` and `error` lines reach the EventSubscriber's `/sub_strat_info` subscribers whatever `GEKKO_LOG_LEVEL`: log a line you want on Telegram at `info` or above.

### 5. Set Adequate Warmup

With `warmup.candleCount: N`, the warmup takes the first N timeframe candles, and your first `log` and `onTimeframeCandleAfterWarmup` come on candle N + 1: by then your indicators have seen N + 1 candles. An indicator whose first complete value comes at candle K is complete on that first candle when N ≥ K − 1, and K depends on the indicator, not only on its period:

| Indicator (period n)               | First complete value at candle | Smallest `candleCount` |
|------------------------------------|--------------------------------|------------------------|
| SMA, EMA, WMA, CCI, BollingerBands | n                              | n − 1                  |
| RSI, ATR, ROC                      | n + 1                          | n                      |
| DEMA                               | 2n − 1                         | 2n − 2                 |
| ADX                                | 2n                             | 2n − 1                 |
| TEMA                               | 3n − 2                         | 3n − 3                 |
| TRIX                               | 3n − 1                         | 3n − 2                 |
| MACD (12, 26, 9)                   | 34                             | 33                     |

Bollinger Bands follow the kind of their middle: n with the default sma, 2n − 1 with a dema. [Indicators at a Glance](./indicators.md#-indicators-at-a-glance) gives the first complete candle of every indicator. A strategy that compares a value with the one of the candle before needs one candle more.

```yaml fragment
watch:
  warmup:
    candleCount: 40  # DEMA(21) is complete from candle 41: 40 or more gives it a value on the first candle after the warmup
```

In a backtest the warmup takes the first `candleCount` candles of `watch.daterange`, counted from its first timeframe boundary, and Gekko refuses a range that does not hold more whole timeframe candles than that. In realtime, Gekko fetches the warmup candles from the exchange as it starts.

> [!WARNING]
> A warmup shorter than your indicators need only delays their first value: the first candles after it have none, and a strategy that checks its indicators, as it must, trades later than you expect.

---

## Troubleshooting

### "Cannot import the strategy file …" or "Cannot find external … strategy"

Gekko loads the strategy as it starts: it imports the file at `strategyPath` (a relative path is resolved against the directory Gekko is started from, not against the config file), then takes the export named `strategyName` from it. A failure stops Gekko with exit code 1, and the log says which step failed: `[TRADING ADVISOR] Cannot import the strategy file <path>: …`, followed by Bun's reason, or `[TRADING ADVISOR] Cannot find external <strategyName> strategy in <path>`. The reasons below are Bun 1.4's, the version Gekko pins; Bun 1.3, which a run from source may still use, writes `from '…'` where Bun 1.4 writes `imported from …`, and names the module a file imports from a package (`Cannot find module '@gekko/shared/utils/math/math.utils' from '…'`) where Bun 1.4 names the package:

- `[TRADING ADVISOR] Cannot import the strategy file /home/user/strategies/myStrategy.strategy.ts: ResolveMessage: Cannot find module '/home/user/strategies/myStrategy.strategy.ts' imported from …`: there is no file at that path (`strategyPath` once resolved).
  - Verify `strategyPath` points to the correct file
  - For a relative `strategyPath`, check the directory Gekko is started from, or use an absolute path
- `[TRADING ADVISOR] Cannot import the strategy file …/myStrategy.strategy.ts: ResolveMessage: Cannot find package '@gekko/strategies' imported from …/myStrategy.strategy.ts`, or, for a copy of a built-in signal strategy, `ResolveMessage: Cannot find package '@gekko/shared' imported from …/dema.strategy.ts`: the file imports a module of Gekko (Bun names its package, `@gekko/strategies` or `@gekko/shared` here), which a file loaded through `strategyPath` may import for its types only: import only types from Gekko, or move the strategy to `packages/strategies/src/custom/` (see [Where Your Strategy Lives](#where-your-strategy-lives)). A file that imported the PositionTracker or the PositionBook for its position needs neither: it trades through `tools.positions` (see [Tracking Your Position](#tracking-your-position)).
- `[TRADING ADVISOR] Cannot import the strategy file …/myStrategy.strategy.ts: ResolveMessage: Cannot find package 'zod' imported from …/myStrategy.strategy.ts`: install the package next to the strategy. A package of Gekko's own (`@gekko/…`) is not one to install, none being published: that is the case above. The compiled executable never finds a package without an `index.js` at its root, such as `lodash-es` (see [Where Your Strategy Lives](#where-your-strategy-lives)).
- `[TRADING ADVISOR] Cannot import the strategy file /home/user/strategies/myStrategy.strategy.ts: BuildMessage: Expected ")" but found ";" at /home/user/strategies/myStrategy.strategy.ts:12:21`: a syntax error at that line and column of the file named, the strategy file or a file it imports. Two or more are listed one after the other, after Bun's count, and one mistake can make several: `[TRADING ADVISOR] Cannot import the strategy file /home/user/strategies/myStrategy.strategy.ts: 2 errors building "/home/user/strategies/myStrategy.strategy.ts": BuildMessage: Expected ")" but found ";" at …:12:21; BuildMessage: Expected "]" but found ";" at …:13:20`.
- `[TRADING ADVISOR] Cannot find external MyStrategy strategy in /home/user/strategies/myStrategy.strategy.ts`: the file was loaded, but exports nothing under the name `strategyName`.
  - Ensure `strategyName` matches your exported class name exactly (case-sensitive)
  - Check that your class is exported with `export class` (an `export default` class is not found)
  - A built-in name beside a `strategyPath` (`strategyName: RSI`) is looked up in that file only: leave `strategyPath` out to run a built-in strategy
- `[TRADING ADVISOR] Cannot find internal MyStrategy strategy`: `strategyPath` is missing, so Gekko looked for a built-in strategy of that name (or one exported from `packages/strategies/src/custom/index.ts`).

### "Cannot find package '@helpers/…'" or "'@strategies/…'" from your checkout's custom strategies

A strategy of your checkout written for an older version of Gekko imports Gekko's modules from where that version kept them. Gekko's checkout is now a set of packages (see the [README](../README.md)): its code moved out of `src/`, into packages imported by their name, `@gekko/<package>/<path>`, and the aliases of `src/` (`@constants/…`, `@errors/…`, `@models/…`, `@utils/…`, `@helpers/…`, `@indicators/…`, `@strategies/…`, `@plugins/…`, `@services/…`) are gone, with nothing left at the old paths. The private strategies moved too, from `src/strategies/custom/` to `packages/strategies/src/custom/`, which is the one directory Gekko reads them from: move your files there, and your exports into its placeholder `index.ts`. The pull that brings the packages moves the placeholder, and stops as any update of it does: set your exports aside, run `git update-index --no-skip-worktree src/strategies/custom/index.ts` and `git checkout -- src/strategies/custom/index.ts`, pull, then move your files and write your exports into `packages/strategies/src/custom/index.ts`, which `bun install` marks skip-worktree (see [Where Your Strategy Lives](#where-your-strategy-lives)). Git still ignores the files left in `src/strategies/custom/`, so that neither `git status` lists them nor `git add -A` stages them, but `bun run lint:check` reads them, and refuses their old imports, until you move them. Gekko loads the strategies of `packages/strategies/src/custom/index.ts` with its own as it starts, so an old path stops every run, whatever its mode and whatever strategy the configuration runs, before any plugin starts: the line, `ResolveMessage: Cannot find package '@helpers/strategy' imported from …/packages/strategies/src/custom/myStrategy.strategy.ts`, has no `[TRADING ADVISOR]` prefix, `bun run type:check` reports the import (`TS2307: Cannot find module '@helpers/strategy/positionTracker/positionTracker' or its corresponding type declarations`), and `bun run build:exec` refuses to build (`Could not resolve: "@helpers/strategy/positionTracker/positionTracker"`). Import from the new paths, where the classes and the functions kept their names, but for those of the position, no longer a strategy's to import (see [the next entry](#cannot-find-package-gekkostrategies-or-cannot-find-module-helpers-from-a-strategy-that-imported-the-positiontracker-or-the-positionbook)); one type of Gekko 2.0.0 did not, `IndicatorParamaters`, now spelt `IndicatorParameters` (`TS2724` otherwise):

- Gekko's types: `@strategies/strategy.types` and `@strategies/trailingStopManager.types` are `@gekko/strategies/strategy.types` and `@gekko/strategies/trailingStopManager.types`, and `@models/<name>.types` is `@gekko/shared/models/<name>.types` (`@gekko/shared/models/order.types`, `@gekko/shared/models/utility.types`); `@services/exchange/exchange.types` (`MarketData`, `OpenOrder`, `Ticker`) and Gekko 2.0.0's `@models/ticker.types` are `@gekko/shared/models/exchange.types`, and `@models/configuration.types` (`Watch`) is `@gekko/schemas/configuration/configuration.types`.
- The position: the PositionTracker (`@helpers/strategy/positionTracker/positionTracker`) and its helpers (`pickTradedPair`, `isSellable`), the PositionBook (`@helpers/strategy/positionBook/positionBook`) and `indicatorsBySymbol` (`@helpers/strategy/strategy.helper`) are no longer a strategy's to import: `tools.positions` and `tools.indicatorsBySymbol` take their place (see [the next entry](#cannot-find-package-gekkostrategies-or-cannot-find-module-helpers-from-a-strategy-that-imported-the-positiontracker-or-the-positionbook)). The helpers of their suites (`OrderRecorder`, `relayOrderOutcome`, `playSteps`), of `@helpers/strategy/positionTracker/positionTracker.mock`, are in `@gekko/strategies/strategy.mock`.
- The utilities and helpers: `@utils/<dir>/<name>.utils` is `@gekko/shared/utils/<dir>/<name>.utils` (`@gekko/shared/utils/math/math.utils`), every other `@helpers/<dir>/<name>` is `@gekko/shared/helpers/<dir>/<name>` (`@gekko/shared/helpers/market/market.helper`), and `@constants/…` and `@errors/…` are `@gekko/shared/constants/…` and `@gekko/shared/errors/…`.
- The indicators: `@indicators/<path>` is `@gekko/indicators/<path>` (`@gekko/indicators/movingAverages/ema/ema.indicator`).
- A built-in strategy's schema: `@strategies/<name>/<name>.schema` is `@gekko/schemas/strategies/<name>.schema` (`@gekko/schemas/strategies/dema.schema`).
- From a version older still, which kept the PositionTracker and the helpers elsewhere: `@strategies/positionTracker` (`PositionTracker`, `pickTradedPair`, `isSellable`) is no longer a strategy's to import either, and `@strategies/positionTracker.mock` is `@gekko/strategies/strategy.mock`; `@utils/<dir>/<name>.utils` for candle, event, finance/stats, market, market/precision, portfolio and stream is `@gekko/shared/helpers/<dir>/<name>.helper` (`@utils/market/market.utils` is `@gekko/shared/helpers/market/market.helper`), `@utils/async/asyncMutex` and `@utils/collection/ringBuffer` are `@gekko/shared/helpers/async/asyncMutex` and `@gekko/shared/helpers/collection/ringBuffer`, and `getBuyBudget` and `getAllInBuyAmount`, of `@plugins/trader/trader.utils`, are in `@gekko/shared/helpers/order/sizing.helper`; any other `<name>.utils` outside `utils/` is `<name>.helper` (`@gekko/indicators/indicator.helper`, `@gekko/shared/errors/error.helper`; GridBot's, now `gridBot.helper`, is no other strategy's to import).
- The logger (`@services/logger`) and the rest of `@services/…` (but its exchange types, above), now `@gekko/core/…`, and the plugins (`@plugins/…`, now `@gekko/plugins/…`) are no longer a strategy's to import: `bun run lint:check` refuses them. Log through `tools.log`.

A file loaded through `strategyPath` whose old imports bring types only still runs, Bun dropping them, but its editor finds them no more: import them from the new paths, which an editor finds outside the checkout through the `tsconfig.json` of [Where Your Strategy Lives](#where-your-strategy-lives). The examples of this guide import from the new paths (see the [Complete Example](#complete-example)).

### "Cannot find package '@gekko/strategies'" or "Cannot find module '../helpers/…'" from a strategy that imported the PositionTracker or the PositionBook

`packages/strategies/src/helpers/` is gone, and with it the PositionTracker, the PositionBook, `pickTradedPair` and `indicatorsBySymbol` that a strategy imported from there: the position book is Gekko's, which the TradingAdvisor keeps for every strategy as `tools.positions` (see [Tracking Your Position](#tracking-your-position)), and a strategy imports no code of another. A strategy of `packages/strategies/src/custom/` that still imports one of them stops every run as Gekko starts, whatever its mode and whatever strategy the configuration runs, as an old path does ([above](#cannot-find-package-helpers-or-strategies-from-your-checkouts-custom-strategies)): `ResolveMessage: Cannot find package '@gekko/strategies' imported from …/packages/strategies/src/custom/myStrategy.strategy.ts` for an import of `@gekko/strategies/helpers/…`, Bun naming the package although the package is there, or `ResolveMessage: Cannot find module '../helpers/positionBook/positionBook' imported from …/packages/strategies/src/custom/dema.strategy.ts` for a copy of a built-in strategy. `bun run type:check` reports the import (`TS2307: Cannot find module '@gekko/strategies/helpers/positionTracker/positionTracker' or its corresponding type declarations`), and `bun run build:exec` refuses to build (`Could not resolve: "@gekko/strategies/helpers/positionTracker/positionTracker"`). A file loaded through `strategyPath` could import none of them, and is not concerned. Rewrite the strategy for `tools.positions`:

- No `PositionBook` or `PositionTracker` field: call `tools.positions.track()` in `init` for every watched pair, or `tools.positions.track([pair])` for the pair a tracker followed, and loop over `tools.positions.pairs` where you looped over `book.pairs`.
- `book.canBuy(pair)`, `book.canSell(pair)`, `book.isLong(pair)` and `book.isPendingOrder(pair)` are `tools.positions.canBuy(pair)` and so on; a tracker's `canBuy()`, `canSell()`, `isLong` and `isPendingOrder` take the pair there.
- `book.buy(order, params)` and `book.sell(order, params)` are `tools.positions.buy(order)` and `tools.positions.sell(order)`, the order alone: Gekko gives the book the portfolio, the closes, the market data and the log. A tracker's `buy(tools.createOrder, order)` and `sell(tools.createOrder, order)` are those too, unless the order is sized by an `amount`, a `cost` or an `allocation`, which the book refuses: create such an order with `tools.createOrder`, and keep the position yourself (see [Tracking Your Position](#tracking-your-position)).
- The order hooks that only handed their params to the book or the tracker go: Gekko settles the position before your order hooks run. So does the `adoptSell` of `onTrailingStopTriggered`: the book takes over the SELL of a stop whose BUY it placed.
- `indicatorsBySymbol(indicators)` is `tools.indicatorsBySymbol(indicators)`.
- `pickTradedPair(candle, tools)` is GridBot's own: take the first pair of `candle.keys()` in `init`, as the class of the [Lifecycle Methods](#lifecycle-methods) does, and warn of the others yourself if you want.
- `isSellable` is the book's, in the plugins: a strategy that keeps its position itself works out whether a holding is enough to sell with `getMarketOrderLimits` and `getSentCost` of `@gekko/shared/helpers/market/market.helper`, as the book does, or as the `holdsSellable` of the Lifecycle Methods does.
- The helpers of its suite are in `@gekko/strategies/strategy.mock`, which also scripts `tools.positions` (see Testing your strategy, under [Tracking Your Position](#tracking-your-position)).

### "Impossible to add the … indicator on [object Object]" from a strategy written for Gekko 2.0.0

Besides its import paths, a strategy written for Gekko 2.0.0 calls an interface that has changed since, and Bun loads it without type-checking it: Gekko 2.0.0's `addIndicator('DEMA', { period: 12 })` stops Gekko at start-up with `[STRATEGY] Impossible to add the DEMA indicator on [object Object]: symbol must be one of the watched pairs (BTC/USDT), got { period: 12 }`, and once that call is fixed, the strategy may run without ever trading, or throw a TypeError. The rest of an upgrade from Gekko 2.0.0, its configuration and its executables included, is in [Upgrading](./upgrading.md). Rewrite the strategy for the [Strategy Interface](#strategy-interface):

- `addIndicator(name, symbol, params)` takes the pair second.
- `candle` is a Map holding the candle of every watched pair: `candle.get(pair)?.close`, where `candle.close` is `undefined`.
- Each indicator argument is `{ results, symbol }`: compare `sma.results`, not `sma`. Typed `unknown[]`, as Gekko 2.0.0's strategies typed them, the arguments compile, and a check such as `isNumber(sma)` fails on every candle: the strategy never trades.
- `portfolio`, and the `exchange.portfolio` of an order hook, is a Map of `{ free, used, total }` by asset: `portfolio.get('USDT')?.free`, where `portfolio.currency.free` throws a TypeError. The `exchange.balance` of an order hook is gone.
- `tools.marketData` is a Map by pair: `tools.marketData.get(pair)`.
- `createOrder` needs the `symbol` of a watched pair.
- Every hook is optional, and `end` gets the `interruption` message.
- `init` runs on the first one-minute candle of every watched pair, before any timeframe candle, where Gekko 2.0.0 ran it on the first timeframe candle (see [`init`](#init--strategy-initialization)).
- `createOrder` throws a `GekkoError`, which stops Gekko, until the warmup is over, and so always from `init` (see ["Orders are not available until the warmup is over"](#orders-are-not-available-until-the-warmup-is-over)), where Gekko 2.0.0 placed the order.

In a strategy of `packages/strategies/src/custom/`, `bun run type:check` reports the calls and the reads that no longer type-check (`addIndicator`, `candle`, `portfolio`, `exchange.balance`, `tools.marketData`, a `createOrder` without `symbol`), but not the indicator arguments, nor when `init` runs and when `createOrder` may be called; so does your editor for a file outside the checkout, with the `tsconfig.json` of [Where Your Strategy Lives](#where-your-strategy-lives).

### "Invalid parameters for strategy … (strategy block)"

Your class's `schema` refused the `strategy:` block, before the first candle: each `✖` line is a problem, and the `→ at` line under it names its parameter (see [Validating Your Parameters](#validating-your-parameters)).

### "Orders are not available until the warmup is over"

Your strategy called `createOrder`, or `tools.positions.buy` or `sell`, before the warmup was over: from `init`, or from `onEachTimeframeCandle` on a warmup candle or on the candle that completes the warmup, which it runs on before the warmup ends. Create orders from `onTimeframeCandleAfterWarmup`, `log` or an order hook.

### "Impossible to create the … order on …"

`createOrder`, or `tools.positions.buy` or `sell`, refused the order, and sent nothing: the end of the line names the field and what it accepts (see [Order Parameters](#order-parameters)).

- `order keys must be one of 'symbol', 'side', 'type', 'amount', 'cost', 'allocation', 'price', 'trailing', got '…'`: the order holds a key `StrategyOrder` does not declare, misspelt (`prise`, `limitPrice`, `amout`, `allocaton`, `trailingStop`) or of your own (`quantity`, `comment`). Mind the spelling, and build the order from its fields rather than passing an event's order or a parameter object as it is.
- `symbol must be one of the watched pairs (…)`: Gekko only has candles, prices and balances of the assets of `watch.assets` against `watch.currency`. Take the pair from `candle.keys()`, or add its asset to `watch.assets`; mind the case (`BTC/USDT`, not `btc/usdt`) and the slash (not the exchange's id `BTCUSDT`).
- `side` and `type` must be spelt in upper case, as typed.
- `amount`, `cost` and `price` must be numbers above 0, or left out, and `allocation` a number above 0 and at most 100 (`25` for 25 %): check a computed value, which may be 0 or `NaN` when a balance or a price is, or a share that came out above 100.
- `amount, cost and allocation size an order three ways: give at most one, got amount and cost`: the order gives two or three of them (`null` or `undefined` counts as left out), and the Trader would not know which to follow. Keep the one you mean.
- `trailing` goes on a BUY only, and takes `percentage` and `trigger` only: mind the spelling.
- `tools.positions.buy takes no key but 'symbol', 'type', 'price', 'trailing', got '…'`, or `tools.positions.sell takes no key but 'symbol', 'type', 'price', got '…'`: an order of `tools.positions` holds another key, whatever its value: misspelt (`prise`), a `side`, which the method sets (the line names the method's side, `Impossible to create the BUY MARKET order …, got 'side'` for a `side: 'SELL'` given to `buy`), or a `trailing` given to `sell`. The book decides what its orders take, and the line says so after the keys when it names an `amount`, a `cost` or an `allocation`: `…: the position book sizes the order (tools.createOrder takes an amount, a cost or an allocation)` from `buy`, `…: it sells all of the asset free (tools.createOrder takes an amount, a cost or an allocation)` from `sell`. Create such an order with `tools.createOrder`, and keep its position yourself (see [Tracking Your Position](#tracking-your-position)).

### "Impossible to track positions …" or "… the position book does not track it …"

`tools.positions` refused a call, and Gekko stopped (see [Tracking Your Position](#tracking-your-position)). `track` checks its call in this order:

- `Impossible to track positions: tools.positions.track is available in init only`: `track` was called once `init` had returned, from a later hook, kept from `init`. Call it in `init`: the pairs it tracks are those of the whole run.
- `Impossible to track positions: pairs must be an array of at least one watched pair, or left out to track every watched pair, got …`: `track` was given something else than a list of pairs (`got 'BTC/USDT'`, a pair alone: write `['BTC/USDT']`), or an empty list (`got []`). Leave `pairs` out to track every watched pair.
- `Impossible to track positions on XRP/USDT: symbol must be one of the watched pairs (…)`: `track` was given a pair that is not watched, every pair given being checked before the next refusal: mind the case and the slash, as for an order (above).
- `Impossible to track positions: pairs must name each watched pair once, got 'BTC/USDT' twice`: `track` was given a pair twice.
- `The position book tracks its pairs already: track is called once, from init`: `track` was called a second time.

`Impossible to place the BUY STICKY order on ETH/USDT: the position book does not track it (it tracks BTC/USDT)` comes from `buy` or `sell`, once the order has passed the checks of `createOrder`: the pair is watched, but `track` was not given it. `(it tracks no pair until init calls track)`: `init` never called `track`. Track the pair, or create its orders with `tools.createOrder` and keep their position yourself.

### "All-in BUY … sized from 0 USDT: 0 BTC sent …"

Followed by `Order 'amount' with value 0 is invalid`, the exchange refusing the order. The end of the warning says why nothing was left to spend:

- `(1000 USDT free at the last synchronization, less 1000 USDT for the BUYs placed since, …)`: your strategy sent an all-in BUY after other BUYs (two entry conditions on one candle, two pairs of one currency) before the Trader read the balance again, and the first took all the currency (see [Order Parameters](#order-parameters)). Send one BUY per candle, the second entry as an `else if`, or, for several pairs, give each BUY a share of the currency with `allocation`, as [`tools.positions`](#tracking-your-position) does.
- `which the market refuses (0 USDT free at the last synchronization)`: the account holds none of the currency. In a backtest or paper trading, `simulationBalance` gives it none.
- `which the market refuses (no balance read from the exchange yet)`: every synchronization of the Trader failed so far.

An all-in SELL sized from nothing says so the same way, `All-in SELL … sized from 0 BTC: 0 BTC sent, which the market refuses (…)`: your strategy sold all-in while holding nothing free (a position already sold, by hand or by a trailing stop), or a SELL sent just before took it all.

A BUY your strategy gave a `cost` or an `allocation` is warned of the same way when nothing is left for it to spend, with the same causes, its line naming the cost or the share it asked for: `[<id>] BUY MARKET order of 100 USDT: 0 BTC sent, which the market refuses (0 USDT free at the last synchronization)`. So is a SELL given an `allocation` of an asset the Trader read none of: `[<id>] SELL MARKET order of 0 BTC (50 % of 0 BTC): 0 BTC sent, which the market refuses (0 BTC free at the last synchronization)`.

### "… below the minimum cost of … on …" or "… below the minimum amount of … of a … order on …"

An order your strategy gave a `cost` or an `allocation`, or sent all-in to BUY, came out too small for the market: its amount, truncated to the amount step of the market as the exchange takes it, is below the minimum amount of the market (`amount.min` in `tools.marketData`, that of a market order for a `MARKET` one), or costs less at its price than its minimum cost (`cost.min`); the line names that amount and the step when the step cut it (`truncated to 0.00008 BTC on the amount step 0.00001 of the market`). The Trader sends it all the same, and the exchange refuses it (`Order 'amount' with value …` or `Order 'cost' with value …`, the figure the warning quotes): an `onOrderErrored` that counts towards `maxConsecutiveErrors`. The cost is valued at the price the line names, and a live exchange checks a market order at its ticker, which can put an order a hair from the minimum on its other side. Give a larger `cost` or `allocation`, or fund the account for an all-in BUY, minding the 5 % a BUY keeps back for the fee (a `cost` of 10 USDT places 9.5 USDT worth) and the step, which can take up to a step's worth off (0.6 USDT on BTC/USDT at 60000: a `cost` of 5.5 USDT places 4.8 USDT worth), or check the balance the share is taken from: a BUY capped at what the BUYs before it left comes out smaller (see [Order Parameters](#order-parameters)).

### "[…] BUY skipped: … is below the minimum cost of … of the market" or "… below the minimum amount …"

The position book of a strategy that trades several pairs through [`tools.positions`](#tracking-your-position) sent no BUY: the pair's share of the currency (all of it for the last pair not invested), less the 5 % kept back for the fee, is under the minimum cost of the market, or buys an amount that, truncated to the amount step of the market, is under its minimum amount or cost, and the market would refuse it ([Pairs and Capital](./built-in-strategies.md#pairs-and-capital) gives the share and the check). Nothing was sent, so nothing counts towards `maxConsecutiveErrors`, and the next skips of the pair are logged at the `debug` level until a BUY of it is placed. When the pair is flat with nothing pending and the portfolio holds enough of its asset free to sell, the book takes that holding for the position instead, said at `info` (`…, but 0.002 BTC is free in the portfolio, enough to sell: the strategy is long`), and the strategy sells it at its next SELL signal. Watch fewer pairs, for a larger share each, or fund the account. The share counts the pairs the book tracks: for a strategy that gives `tools.positions.track` a list of its own, fewer pairs means a shorter list.

### "Impossible to add the … indicator on …", "… indicator not found." or "Indicator …: …"

- `symbol must be one of the watched pairs (…)`: as for an order, above. `… on [object Object]: …, got { period: 12 }` means the call passes its parameters where the pair goes, as a strategy written for Gekko 2.0.0 does (see [above](#impossible-to-add-the--indicator-on-object-object-from-a-strategy-written-for-gekko-200)).
- `addIndicator is available in init only`: register every indicator in `init`. One added later would only be fed from then on, and would add an argument to every hook.
- `parameters must be a plain object of the indicator's parameters by name, {} to take its defaults, got 7`: the third argument, which only a JavaScript strategy can get wrong, must be an object such as `{ period: 7 }`, `{}` for the defaults (see [Using Indicators](#using-indicators)).
- `SMAA indicator not found.`: the name is not one of the [indicators](./indicators.md); it is case-sensitive.
- `[STRATEGY] Indicator ATR: period must be a whole number, at least 1, got undefined`, a parameter the indicator refuses, or requires and did not get: see [Parameter Checks](./indicators.md#parameter-checks).

### "Cannot open the database …" or "Missing candles in database"

A backtest reads the one-minute candles of `watch.daterange` from `storage.database` (a relative path is resolved against the directory Gekko is started from), and checks that every minute is there before it starts. Import the candles first (see [Run Your Strategy](#3-run-your-strategy)):

- `[STORAGE] Cannot open the database /…/db/binance-BTC_USDT.sql (unable to open database file). A backtest reads an existing database: check storage.database, or import the candles first.`: there is no database at that path.
- `[STORAGE] /…/db/binance-BTC_USDT.sql holds no candles of BTC/USDT: import them first.`: the database holds none of that pair.
- `[STREAM] Missing candles in database: BTC/USDT 2024-01-01T00:00:00.000Z -> 2024-11-30T23:59:00.000Z, Available date ranges: [2024-01-01T00:00:00.000Z - 2024-06-30T23:59:00.000Z]`: the database lacks minutes of the range, and lists those it holds. Import the missing ones, or backtest a range within those.

### "watch.daterange must hold more whole … candles than warmup.candleCount"

A backtest spends its first `warmup.candleCount` timeframe candles on the warmup and trades from the next one, counted from the first timeframe boundary of `watch.daterange` (in UTC: a `1w` candle starts on a Monday, a `1M` candle on the 1st). Lengthen the range or shorten the warmup. A run stopped before its warmup was over ends with `Strategy ended before its warmup was over, so it never traded: …`.

### "Max consecutive order errors reached (5)"

The circuit breaker: `maxConsecutiveErrors` order errors in a row stopped Gekko, with exit code 0. The log holds the reason of each error. A strategy that sends the same refused order on every candle trips it within a few candles: see [Tracking Your Position](#tracking-your-position).

### Trailing stop lines

Gekko logs what happens to your stops, each line of this table under the `strategy` tag but the second `over` line, which comes under the `trailing stop` tag:

| Line                                                                       | Level | Meaning                                                                                                                                                                                                                                                   |
|----------------------------------------------------------------------------|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `Trailing stop of BUY <id> held back: …`                                   | info  | A price reached its stop price while a SELL of yours is pending on the pair: the stop sends no SELL until that one ends                                                                                                                                   |
| `Trailing stop of BUY <id> resumes: …`                                     | info  | Your SELL was canceled or errored, and no other is pending on the pair: the stop may trigger again                                                                                                                                                        |
| `Trailing stop of BUY <id> canceled: the strategy sold on <pair> …`        | info  | Your SELL completed: it closed the position the stop protected                                                                                                                                                                                            |
| `Trailing stop of BUY <id> active again: its SELL <id> …`                  | warn  | The stop's SELL completed, errored or was canceled for less than the stop's amount: it sells what is left once a price reaches its stop price again. With `the Trader could not read the balances after it`, nothing checked that this rest is still held |
| `Trailing stop of BUY <id> over: …`                                        | info  | The stop's SELL left too little to sell at the minimums of the market, or completed with too little of the asset free in the balances read after it: nothing is left to protect                                                                           |
| `Trailing stop of BUY <id> over: its SELL <id> sold 0.5, all of its 0.5`   | info  | Under the `trailing stop` tag: the stop's SELL errored or was canceled after a reported fill of all of its amount: nothing is left to protect                                                                                                             |
| `Trailing stop of BUY <id> kept: its SELL <id> …`                          | warn  | The stop's SELL errored and may still have gone through on the exchange: the stop stays armed. Check that SELL there                                                                                                                                      |
| `Trailing stop of BUY <id> removed: …`                                     | warn  | The stop's SELL errored or was canceled, and the balances read after it show too little of the asset free to sell: nothing is left to protect                                                                                                             |
| `BUY <id> errored after it filled …`                                       | warn  | The BUY errored after a reported fill: its stop is armed for that part. When the BUY may still be live, the rest of it may fill without a stop                                                                                                            |
| `Trailing stop of BUY <id> not armed: …`                                   | warn  | The BUY errored with no fill reported: nothing filled when the exchange refused it; when it may still be live, what it bought has no stop                                                                                                                 |
| `Strategy ended with N active trailing stops that never triggered.`        | warn  | At the end of the run: stops still armed                                                                                                                                                                                                                  |
| `Strategy ended with N triggered trailing stops whose SELL had not ended.` | warn  | At the end of the run: stops whose SELL had no outcome yet                                                                                                                                                                                                |

### "Unknown log level … in tools.log"

Your strategy called `tools.log` with a level other than `debug`, `info`, `warn` or `error` (such as `'warning'`, which only an untyped strategy can pass): its lines are logged and relayed at `info`, after this one warning per level.

### Indicators returning null

- Ensure adequate warmup period: `warmup.candleCount` must be at least the indicator's first complete candle minus one (see [Indicators at a Glance](./indicators.md#-indicators-at-a-glance))
- Validate indicator values before using them

### Your hooks stay silent

- `GEKKO_LOG_LEVEL` defaults to `error`, which hides your `info` and `warn` lines: set `info`, or `debug` for your `debug` lines, such as those of the examples' `log` hook (see [Use Appropriate Log Levels](#4-use-appropriate-log-levels)). At `info`, each order also brings some five lines of the Trader and of the order, tagged `TRADER` and `ORDER`: your own lines come under `"_tag":"STRATEGY"`.
- `log` and `onTimeframeCandleAfterWarmup` start on the candle that completes the warmup, candle `warmup.candleCount` + 1, and `onEachTimeframeCandle` on the first timeframe candle (see [Set Adequate Warmup](#5-set-adequate-warmup), and, for a backtest, the [warmup entry](#watchdaterange-must-hold-more-whole--candles-than-warmupcandlecount) above).
- The candle hooks run once per timeframe candle, at its close on the UTC calendar: on `1d` once a day, at 00:00 UTC; a `1w` candle closes on a Monday, a `1M` candle on the 1st of a month. In realtime, Gekko replays the warmup candles as it starts, and the candle that completes the warmup is the one in progress: the first `log` and `onTimeframeCandleAfterWarmup` come at its close, on `1d` at the next 00:00 UTC.
