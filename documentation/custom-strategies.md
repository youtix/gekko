# Custom Strategies

This guide explains how to create your own custom trading strategies and run them with Gekko. Custom strategies live **outside** the Gekko codebase, enabling you to develop and iterate on your trading logic independently; a private strategy can also live inside your checkout, in `packages/strategies/src/custom/` (see [Where Your Strategy Lives](#where-your-strategy-lives)).

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Where Your Strategy Lives](#where-your-strategy-lives)
- [Strategy Interface](#strategy-interface)
- [Lifecycle Methods](#lifecycle-methods)
- [Tools Available](#tools-available)
- [Using Indicators](#using-indicators)
- [Creating Orders](#creating-orders)
- [Tracking Your Position](#tracking-your-position)
- [Configuration File](#configuration-file)
- [Running with Executable](#running-with-executable)
- [Complete Example](#complete-example)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Overview

Custom strategies allow you to:

- **Develop independently** — Keep your proprietary trading logic separate from the Gekko core
- **Iterate quickly** — Modify and test strategies without rebuilding Gekko
- **Use any indicators** — Access all 31 built-in technical indicators
- **Handle order events** — React to order completions, cancellations, and errors
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

// Export your strategy class with the exact name you'll reference in config
export class MyStrategy implements Strategy<MyStrategyParams> {
  init(params: InitParams<MyStrategyParams>): void {
    // Initialize indicators here
  }

  onTimeframeCandleAfterWarmup(params: OnCandleEventParams<MyStrategyParams>, ...indicators: IndicatorResults[]): void {
    // Your main trading logic goes here
  }

  // Every hook is optional, the two above included: keep only the ones you use
  onEachTimeframeCandle(params: OnCandleEventParams<MyStrategyParams>, ...indicators: IndicatorResults[]): void {}
  log(params: OnCandleEventParams<MyStrategyParams>, ...indicators: IndicatorResults[]): void {}
  onOrderCompleted(params: OnOrderCompletedEventParams<MyStrategyParams>, ...indicators: IndicatorResults[]): void {}
  onOrderCanceled(params: OnOrderCanceledEventParams<MyStrategyParams>, ...indicators: IndicatorResults[]): void {}
  onOrderErrored(params: OnOrderErroredEventParams<MyStrategyParams>, ...indicators: IndicatorResults[]): void {}
  end(interruption?: string): void {}
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

The simulator receives each order as the live exchange does: its amount truncated to the amount step (`precision.amount`), its price rounded half up to the price tick (`precision.price`). An amount truncated to 0, below `amount.min`, or whose cost falls under `cost.min`, is refused (the Trader warns of one it sized, by `cost`, `allocation` or all-in for a BUY, before it sends it: see the Trader's [Sizing](./plugins.md#sizing)), and an order fills for the amount truncated. The cost is worked out in decimal, as the exchange works it out: an order costing exactly `cost.min` passes. For Hyperliquid, whose tick depends on the price, add `priceSignificantDigits: 5` under `precision`.

### 3. Run Your Strategy

A backtest reads its candles from `storage.database`, and refuses to start while a minute of `watch.daterange` is missing there: import them first. The importer of the [Quick Start guide](./quick-start.md#-2-retrieve-historical-data) does: it writes the candles of BTC/USDT from 2024-01-01 to 2024-12-01 into `./db/binance-BTC_USDT.sql`, a range that holds this one (see [Troubleshooting](#cannot-open-the-database--or-missing-candles-in-database) for the errors otherwise).

```bash
# Using the compiled executable (bun run build:exec builds it, see Running with Executable)
GEKKO_CONFIG_FILE_PATH=./config/myStrategy.local.yml ./dist/gekko
```

---

## Where Your Strategy Lives

A strategy lives in one of two places, which decide how Gekko finds it and what it can import:

|                     | Outside the codebase (this guide)                                     | In your checkout, in `packages/strategies/src/custom/`                                                                                                                      |
|---------------------|-----------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Selected by         | `strategyPath`, its file, and `strategyName`, the class it exports    | `strategyName` alone, once your class is exported from `packages/strategies/src/custom/index.ts`                                                                            |
| Loaded              | From its file, each time Gekko starts: no build needed after a change | Compiled into `dist/gekko` and `dist/fox` by `bun run build:exec`, like the built-in strategies                                                                             |
| Imports from Gekko  | Types only                                                            | What the strategies' package may: types, the [PositionTracker and the PositionBook](#tracking-your-position), the utilities and the indicators; not the core or the plugins |
| Packages (`zod`, …) | Installed next to its file (see below)                                | Those of the checkout                                                                                                                                                       |
| Type-checked        | No: Bun loads TypeScript without checking it                          | By `bun run type:check`, not by the pre-commit hook; its tests run with `bun run test`, never in CI                                                                         |
| Git                 | Yours                                                                 | Gitignored, but for a placeholder `index.ts` that `bun install` marks skip-worktree: your exports stay out of git                                                           |

A file loaded through `strategyPath` can import Gekko's types (`@gekko/strategies/strategy.types`, `@gekko/strategies/trailingStopManager.types`, `@gekko/shared/models/…`), because Bun drops an import that is only used as a type, but nothing else of Gekko: the compiled executable resolves no `@gekko/…` path of a file it loads as it starts, even a file inside the checkout, and Gekko run from source (`bun run dev`) resolves them only for a file inside the checkout. Such an import stops Gekko at start-up with `[TRADING ADVISOR] Cannot import the strategy file …/myStrategy.strategy.ts: ResolveMessage: Cannot find module '@gekko/strategies/helpers/positionTracker/positionTracker' from '…/myStrategy.strategy.ts'`. So model an external strategy on the [Complete Example](#complete-example), not on a built-in strategy: those import Gekko modules, and a copy of `dema.strategy.ts` placed outside the codebase stops on the first of them, `Cannot find module '../helpers/positionBook/positionBook' from '…/dema.strategy.ts'`.

A package your strategy imports is looked up from the folder of its file: install it there (`bun add zod` in that folder), unless the file sits inside a Gekko checkout, whose `node_modules` has it. The compiled executable, though, only finds a package by the `index.js` at its root, whatever its `package.json` names as its entry: `zod` has one, but `lodash-es`, which Gekko itself uses, has none, and is not found even installed next to the strategy (`… ResolveMessage: Cannot find package 'lodash-es' from '…'`). Import such a package by its files (`import isNil from 'lodash-es/isNil.js'`), or run Gekko from source (`bun run dev`), which follows the `package.json`.

To build on a built-in strategy, or to use the PositionTracker or the PositionBook, keep your strategy in `packages/strategies/src/custom/` and export it from the placeholder, which holds `export {};` until then. It belongs to Gekko's strategies package (`@gekko/strategies`), and imports what that package may: Gekko's types, the PositionTracker and the PositionBook (`@gekko/strategies/helpers/…`), the utilities and helpers of `@gekko/shared`, the schemas of `@gekko/schemas` and the indicators of `@gekko/indicators`, as the examples of this guide do. The core, beside the strategies, and the plugins, above them (`@gekko/core/…`, `@gekko/plugins/…`, the logger among them), are out of a strategy's reach, and `bun run lint:check` refuses a strategy's import of them: log through `tools.log`. A copy of a built-in strategy keeps its imports of its own package working there (`../helpers/positionBook/positionBook`, `../strategy.types`), but for those of its own directory, such as `./dema.types`: copy that file beside it, or import it as `../dema/dema.types`.

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

Every custom strategy must implement the `Strategy<T>` interface, where `T` is your parameters type:

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

The snippets of this section are methods of one class, which follows two EMAs of the first watched pair and tracks its position (see [Tracking Your Position](#tracking-your-position)): the `init` snippet shows the class with its fields and the two helpers its methods share, `compareWithTolerance`, which compares the two EMAs (see [Validate Indicator Values](#2-validate-indicator-values)), and `holdsSellable`, which reads the position from the portfolio once an order has ended.

### `init` — Strategy Initialization

Called **once**, at start-up, on the first one-minute candle, before any timeframe candle: in realtime the first minute of the warmup history (with no history to replay, the first live minute, once it closes), in a backtest the first minute of `watch.daterange`. Its `candle` holds that minute's candle of every watched pair, in the order of `watch.assets`: take your pairs from its keys, not a price (a price to trade from comes with the first candle after the warmup). In a backtest, these one-minute candles also carry an `id`, their row in the candle database; a candle read live from the exchange, one Gekko made up for a missing minute, and every timeframe candle have none: do not rely on it.

Register your indicators here: `addIndicator(name, symbol, params)` is only available in `init`. Kept and called later, it throws `[STRATEGY] Impossible to add the SMA indicator on BTC/USDT: addIndicator is available in init only`, which stops Gekko. These stop Gekko at start-up, with an error naming the problem:

- an indicator name that does not exist (`[STRATEGY] SMAA indicator not found.`), or parameters the indicator refuses, a required one left out included (`[STRATEGY] Indicator ATR: period must be a whole number, at least 1, got undefined`, see [Parameter Checks](./indicators.md#parameter-checks));
- a third argument that is not a plain object of the indicator's parameters by name, which only a JavaScript strategy can pass (`[STRATEGY] Impossible to add the RSI indicator on BTC/USDT: parameters must be a plain object of the indicator's parameters by name, {} to take its defaults, got 7`);
- a `symbol` that is not a watched pair, a key of `candle` and of `tools.marketData` (`[STRATEGY] Impossible to add the SMA indicator on ETH/USDT: symbol must be one of the watched pairs (BTC/USDT), got 'ETH/USDT'`): an indicator on another pair would never get a candle;
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
  // amount step; undefined when no balance was read yet. Worked out in decimal, as the Complete Example explains
  private holdsSellable({ order, exchange, tools }: EndedOrderParams): boolean | undefined {
    const [asset] = order.symbol.split('/');
    const free = exchange.portfolio.get(asset)?.free;
    if (free === undefined) return undefined;
    const { amount, cost, precision } = tools.marketData.get(order.symbol) ?? {};
    const step = precision?.amount;
    const decimal = (value: number) => Number(value.toPrecision(15));
    const sellable = step ? decimal(Math.floor(decimal(free / step)) * step) : free;
    const isCostEnough = exchange.price <= 0 || decimal(sellable * exchange.price) >= (cost?.min ?? 0);
    return sellable > 0 && sellable >= (amount?.min ?? 0) && isCostEnough;
  }
}
```

`init` also gets `portfolio`, the balance read at start-up, and `openOrders`: the orders open on each watched pair when the run started, a `Map<TradingPair, OpenOrder[]>` whose entries are `{ id, side, type, price?, amount, filled, remaining, timestamp }`. They are read once from the exchange, and there are none in a backtest or a paper-trading session. Your strategy does not follow these orders: the Trader follows only the orders your strategy creates in this run. A strategy that keeps its orders in memory can refuse to start beside them with `tools.log('error', …)`, as GridBot does.

> [!IMPORTANT]
> Indicators are passed to other methods in the **same order** you register them in `init`, each as a `{ results, symbol }` object.

---

### `onEachTimeframeCandle` — Every Candle (Including Warmup)

Called on **every** timeframe candle from the very beginning, including during warmup, before `log` and `onTimeframeCandleAfterWarmup`. It can create orders from the candle after the one that completes the warmup. It is the place to record what you compare with the previous candle: it runs on the warmup candles too, so the first candle after the warmup is compared with the last warmup candle.

```typescript
onEachTimeframeCandle({ candle }: OnCandleEventParams<MyParams>, ...indicators: IndicatorResults[]): void {
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
    log('info', 'EMA crossover detected — going LONG');
    this.pendingOrderId = createOrder({ type: 'STICKY', side: 'BUY', symbol: this.pair });
  }
}
```

---

### `log` — Logging Hook

Called on each timeframe candle after warmup, just before `onTimeframeCandleAfterWarmup`, to log indicator values and debug info (at `debug`, a line is printed with `GEKKO_LOG_LEVEL=debug` and never sent to Telegram).

```typescript
log({ candle, tools }: OnCandleEventParams<MyParams>, ...indicators: IndicatorResults[]): void {
  const [shortEma, longEma] = indicators;
  if (typeof shortEma.results !== 'number' || typeof longEma.results !== 'number') return;
  tools.log('debug', `EMA Short: ${shortEma.results.toFixed(2)} | Long: ${longEma.results.toFixed(2)}`);
}
```

---

### `onOrderCompleted` — Order Filled

Called when an order of yours is filled by the exchange: `order.amount` is the amount it filled (on a market with an amount step, the amount asked for truncated to that step, in backtest and paper trading as live: an all-in BUY of 0.0310282298100942 BTC fills for 0.03102 on Binance's BTC/USDT), `order.price` the price it executed at (the mean of its trades' prices weighted by their amounts, worked out in decimal: a price all its trades share is that price, a mean that does not end is given to 15 significant digits), `order.effectivePrice` that price with the fee in (above it for a BUY, below it for a SELL), `order.fee` the fee in the currency (the fees of its trades added up, one taken in the asset at the price of its trade, one taken in BNB 0), `order.feeAsset` the asset the exchange took the fee in, as the trades of the order name it (`'BTC'` for a BUY on BTC/USDT at Binance unless the fees are paid in BNB, `'USDT'` for its SELL and for every order of a backtest or of `paper-binance`, `'BNB'` with the discount, a fee the Trader leaves at 0 with its rate unknown; `undefined` when the trades name none or several, as those of a BUY whose BNB ran out partway, or when the summary is estimated), `order.feeTakenInAsset` what the fees took of the asset bought, its `amount` in the asset and its `value` in the currency, its part of `order.fee` (`{ amount: 0.001, value: 0.1 }` for 1 BTC bought at 100 at Binance without BNB, the account holding `order.amount` less that amount; `undefined` when no trade took its fee in the asset, or when the summary is estimated), `exchange.price` the price of the pair the Trader read once the order ended (in realtime the event arrives with the next minute, and the market may have moved since), `exchange.portfolio` the portfolio after the fill, and `exchange.portfolioReadAt` when the Trader read that portfolio, in epoch milliseconds (the wall clock once the exchange answered, in a backtest too; `undefined` before its first read, the portfolio then empty). When the exchange gives no usable trades, the summary is estimated and an error line says from what: a LIMIT or STICKY order from the prices the exchange reported for its own fills, otherwise its limit price or the last market price.

```typescript
onOrderCompleted(params: OnOrderCompletedEventParams<MyParams>): void {
  const { order, tools } = params;
  tools.log('info', `Order ${order.id} completed: ${order.side} ${order.amount} @ ${order.price}`);
  if (order.id !== this.pendingOrderId) return;
  this.pendingOrderId = undefined;
  // A BUY makes it long. A SELL may have sold less than the position (the Trader caps a SELL at the most the market takes in one
  // order): the strategy is still long when the portfolio after it holds enough to sell
  this.isLong = order.side === 'BUY' || this.holdsSellable(params) === true;
}
```

---

### `onOrderCanceled` — Order Canceled

Called when an order of yours is canceled: by your strategy (`tools.cancelOrder`), or by the exchange (expired, canceled from its interface). It may have filled part of its amount before: `order.filled` is the largest fill any answer of the exchange reported for it, a poll before the cancelation included, `order.remaining` what was left of its amount (of the order's amount, not of what you hold, unless the order was for all of it), and, for a `LIMIT` or `STICKY` order, `order.fillPrice` the mean price of those fills (a `STICKY` order trades at the market, not at `order.price`), left out for a `MARKET` order, whose reported price can be the bound of its slippage, and when no fill had a price reported. A number, `0` included, is a fact: `0` filled means that nothing executed. `order.filled` and `order.remaining` are `undefined` when no answer reported a fill: unknown, not 0 filled. `exchange.portfolio`, the portfolio after the cancelation, then tells what you hold (see [Tracking Your Position](#tracking-your-position)).

```typescript
onOrderCanceled(params: OnOrderCanceledEventParams<MyParams>): void {
  const { order, tools } = params;
  // undefined when the exchange reported no fill: unknown, not 0
  const fill = order.filled === undefined ? 'no fill reported' : `${order.filled} filled, ${order.remaining} left`;
  tools.log('warn', `Order ${order.id} was canceled (${fill})`);
  if (order.id !== this.pendingOrderId) return;
  // No longer pending: the next candle that calls for it sends the order again
  this.pendingOrderId = undefined;
  // It may have filled part of its amount first: the portfolio after it tells, once a balance was read
  this.isLong = this.holdsSellable(params) ?? this.isLong;
}
```

---

### `onOrderErrored` — Order Failed

Called when an order of yours fails or is refused by the exchange, `order.reason` saying why. An amount the market's step truncates to 0, or whose cost then falls under `cost.min`, is refused so, in backtest and paper trading as live (`Order 'cost' with value 4.8987648 is out of range. Expected a value between 5 and 9000000.`). An amount or a price the step rounds to nothing is reported as the order asked for it, with the step: 0.0000099 BTC on Binance's BTC/USDT reads `Order 'amount' with value 0.0000099 rounds to 0 on the amount step 0.00001 of the market. Expected a value between 0.00001 and 9000.` It may have executed part of its amount first: `order.filled` is what the exchange reported it filled, 0 when it reported nothing. For a `LIMIT` or `STICKY` order, `order.fillPrice` is the mean price of those fills, as an order canceled carries it, left out for a `MARKET` order and when no fill had a price reported.

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
  // It may have executed before its error: the portfolio after it tells (see Tracking Your Position)
  this.isLong = this.holdsSellable(params) ?? this.isLong;
}
```

---

### `end` — Strategy Cleanup

Called once, when the run ends: the backtest completes, or an error stops the bot before its end (a crash, missing candles, the circuit breaker). `interruption` is then the message of that error, as the analyzers give it in their reports, and undefined after a normal end. A signal (Ctrl-C, SIGTERM) or an uncaught exception ends Gekko without calling it.

```typescript
end(interruption?: string): void {
  // Cleanup resources, log final statistics, etc.
}
```

---

## Tools Available

Every lifecycle method but `end` receives a `tools` object, the same object in each (the trailing-stop hooks get it as their last argument, after the state):

| Tool                  | Type                           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|-----------------------|--------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `strategyParams`      | `T` (your params type)         | Your strategy parameters: the output of your class's `schema` (see [Validating Your Parameters](#validating-your-parameters)), or, without one, the whole `strategy:` block, `name` included. Your own copy: writing to it changes neither the configuration nor what the other plugins read there                                                                                                                                                                         |
| `marketData`          | `Map<TradingPair, MarketData>` | Order limits, precision (as steps: 0.01) and fees of each watched pair, plus the narrower `market` limits of MARKET orders if any. Its keys are the pairs `createOrder` and `addIndicator` accept. Your own copy: writing to it changes neither the exchange nor the limits it checks                                                                                                                                                                                      |
| `log`                 | `(level, msg) => void`         | Log messages (`debug`, `info`, `warn`, `error`), printed if `GEKKO_LOG_LEVEL` lets the level through. `info`, `warn` and `error` lines also go to Telegram (the EventSubscriber's `/sub_strat_info`), whatever `GEKKO_LOG_LEVEL`; `debug` lines never do. `error` also throws a `GekkoError`, which stops the bot: its line is sent at once, so it reaches Telegram even then (caught by your strategy, it arrives ahead of the lines logged before it in the same minute) |
| `createOrder`         | `(order) => UUID`              | Create a new order: returns its id at once, the outcome arrives later in `onOrderCompleted`, `onOrderCanceled` or `onOrderErrored`. Before the warmup is over, or for an order it cannot accept, it sends nothing and throws a `GekkoError`, which stops the bot (see [Creating Orders](#creating-orders))                                                                                                                                                                 |
| `cancelOrder`         | `(orderId) => void`            | Cancel an order of yours: its outcome still arrives through the order hooks, canceled, completed if it filled first, or errored if the cancelation failed                                                                                                                                                                                                                                                                                                                  |
| `cancelTrailingOrder` | `(orderId) => void`            | Drop the trailing stop of a BUY order (given the BUY's id), before or after the BUY completes, and while the stop sells. You need not call it to exit: while your SELL is pending the stops of the pair do not trigger, once it completes they are canceled, and if it fails they protect the position again                                                                                                                                                               |

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
  // has seen enough candles, then complete on every candle (macd.results is then { macd, signal, hist }, all three set). Only ROC,
  // and TRIX built on it, give null again, on a candle whose base is 0
  const [sma, rsi, macd] = indicators;
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

Use `tools.createOrder()` to place trades. It is available once the warmup is over: from `log` and `onTimeframeCandleAfterWarmup` on the candle that completes it (the first candle with `warmup.candleCount: 0`), then from every hook (`onEachTimeframeCandle` from the next candle on). Called earlier, and so always from `init`, it throws `[STRATEGY] Orders are not available until the warmup is over: …`, which stops Gekko: in realtime the warmup candles are history, replayed with the Trader active, and an order created on one of them would reach the exchange at once.

An order is dated (`orderCreationDate`) with the end of the minute being processed, as the fills and the errors of that minute are.

### Order Types

| Type     | Description                                                                                                                                                                                                   |
|----------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `STICKY` | Limit order `price.min` inside the best bid/ask, re-placed once the market moves past it (checked every `orderSynchInterval` in realtime, every minute in backtest); no timeout, never becomes a market order |
| `MARKET` | Immediate market order                                                                                                                                                                                        |
| `LIMIT`  | Standard limit order at specified price                                                                                                                                                                       |

`STICKY` and `MARKET` orders ignore `price`, which then only sizes a BUY without an `amount` (all-in, or by `cost` or `allocation`) and a SELL by `cost`. In a backtest, the simulated exchange fills a `MARKET` order at the close of the minute and a `LIMIT` order in full once a candle reaches its price, with no partial fill and no slippage (see the Trader's [Order Types](./plugins.md#order-types)).

### Order Parameters

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

- **`amount`, `cost` and `allocation` left out**: the order is all-in. A BUY spends the free currency less what the BUYs sent before it may spend, sized at `price` with 5 % kept back for the fee, in decimal (600 USDT at 100 buy 5.7 BTC); a SELL sells the free asset less what the SELLs sent before it take, until the Trader reads the balance again.
- **`cost`**: a sum in the currency of the pair, the USDT of BTC/USDT. A BUY may spend it, the 5 % kept back for the fee included, and is sized at `price` as an all-in BUY is: a `cost` of 600 USDT at 100 buys 5.7 BTC, as an all-in BUY of 600 free USDT does. A SELL sells that worth of the asset at `price`, its fee coming out of the proceeds: a `cost` of 600 USDT at 100 sells 6 BTC.
- **`allocation`**: a share, in percent, above 0 and at most 100 (`25` for 25 %), of the free balance the Trader read at its last synchronization: a BUY spends that share of the currency, sized as a BUY by `cost` is, and `allocation: 100` makes it all-in; a SELL sells that share of the asset. The share is of the balance read, not of what the orders sent since leave: with 1000 USDT read, two BUYs of `allocation: 50` sent on one candle, on BTC/USDT and ETH/USDT, spend 500 USDT each (4.75 BTC at 100), where an all-in BUY on the first pair would leave the second nothing. A BUY's share is of the currency read plus what the BUYs Gekko placed and still open at that read hold of it (a `STICKY` or `LIMIT` BUY resting across the synchronization): each its amount at the price it was created with, what it filled included (only its fill for one you canceled before the read). The exchange has moved that currency to `used`, or spent it on the fills, and a share of the free currency alone came out smaller than the same share on the candle before the read. A SELL's share is of the asset read free, what an open SELL holds being that SELL's to sell. Like an all-in order, it is sized from the balance as of that synchronization, which comes every `exchangeSynchInterval` in realtime (an `exchange` option, 10 minutes by default), every `watch.timeframe` in a backtest (10 minutes at least), and after the end of each order: a deposit, or a trade made by hand or by another bot, counts from the next one. The built-in signal strategies share the currency so among the pairs they trade, through the [PositionBook](#tracking-your-position) (see [Pairs and Capital](./built-in-strategies.md#pairs-and-capital) for the share each BUY takes).
- **`price` left out**: the last price of the pair, the close of the last one-minute candle or the bid read at the Trader's last synchronization, whichever came last. It is the limit of a `LIMIT` order, and what a BUY without an `amount`, or a SELL by `cost`, is sized at.
- **A SELL is capped to the free balance** of its asset, as the Trader read it at its last synchronization, less what the SELLs it placed since take from it, with a warning (`[<id>] SELL MARKET order of 0.3 BTC above the free balance: 0.2992 BTC sent, all that can be sold (…)`). An all-in SELL is sized from that remainder; a SELL by `cost` or `allocation` is capped at it, its warning naming the cost or the share it asked for. Once the SELLs placed since take that balance whole, a SELL of an `amount`, a `cost` or an `allocation` is sent as asked, with a warning that they took it, and the exchange refuses it unless one of them was refused or canceled first.
- **An all-in BUY is sized from what the BUYs before it leave** of the free currency as the Trader read it at its last synchronization: each BUY placed since counts for its cost at its price plus the 5 % kept back for its fee, an all-in BUY for all it was sized from, a BUY by `cost` or `allocation` for its budget once capped at what was left, and a BUY capped at the most the market takes in one order for what that maximum costs at its price plus the 5 %; an order your strategy cancels after a partial fill, as far as the Trader's polls reported it, still counts for what that fill took (a BUY for what the amount filled may spend at the order's price, the 5 % included; a SELL for the amount it sold), until the Trader reads the balance again. The Trader warns (`[<id>] All-in BUY MARKET order sized from 500 USDT: 4.75 BTC sent (1000 USDT free at the last synchronization, less 500 USDT for the BUYs placed since, the 5 % kept back for their fee included)`). So the second of two all-in BUYs sent on one candle is sized to 0 and refused: an `onOrderErrored` that counts towards `maxConsecutiveErrors`. Send one, or share the currency with `allocation`. A BUY with an `amount` is placed as asked.
- **A BUY by `cost` or `allocation` is capped at what the BUYs before it leave** in the same way: its budget, the cost or the share of the currency read, is cut to the currency left, with one warning (`[<id>] BUY MARKET order of 500 USDT (50 % of 1000 USDT) above the free balance, sized from 300 USDT: 2.85 BTC sent (1000 USDT free at the last synchronization, less 700 USDT for the BUYs placed since, the 5 % kept back for their fee included)`), the market maximum's when that caps it too (see the next bullet). Once nothing is left, it is sized to 0, warned of with the cause, and refused by the exchange.
- **A SELL, and a BUY without an `amount`, is capped at the most the market takes in one order** of its type: the maximum of its amount range, narrowed for a `MARKET` order by that of a market order (Binance's MARKET_LOT_SIZE, tens of BTC on BTC/USDT), with a warning (`[<id>] SELL MARKET order of 100 BTC above the maximum amount of a MARKET order on BTC/USDT: 86.27382215 BTC sent, the rest stays held`). The SELL of a trailing stop is capped so too. `onOrderCompleted` gets the amount executed, and the rest stays held, or unspent, for a later order. A BUY with an `amount` above the maximum is refused by the exchange.
- **An order by `cost` or `allocation`, or an all-in BUY, below a minimum of the market**, its minimum amount (`amount.min` in `tools.marketData`, that of a market order for a `MARKET` one) or its minimum cost (`cost.min`), its amount truncated to the amount step of the market as the exchange takes it, is warned of before it is sent, then refused by the exchange: an `onOrderErrored` that counts towards `maxConsecutiveErrors`. The amount is checked first, as the exchange checks it (`[<id>] BUY MARKET order of 6 USDT: 0.00057 BTC at 10000 sent, below the minimum amount of 0.001 BTC of a MARKET order on BTC/USDT, which the market refuses`). The cost line compares the cost of the order at its price with the minimum, not its budget: a BUY keeps 5 % of its budget back for the fee, so a `cost` of 10 USDT places 9.5 USDT worth, under a minimum of 10 (`[<id>] BUY MARKET order of 5 USDT (5 % of 100 USDT): 0.0475 BTC at 100 sent, a cost of 4.75 USDT once 5 % is kept back for the fee, below the minimum cost of 10 USDT on BTC/USDT, which the market refuses at that price`). It values the order at its price, the last close for a `MARKET` order, while a live exchange checks a market order at its ticker: near the minimum, the two can disagree. The step can take up to one step's worth off: on BTC/USDT at 60000, whose step is 0.00001 BTC, a `cost` of 5.5 USDT buys 0.0000870833333333333 BTC, 5.225 USDT, sent as 0.00008 BTC, 4.8 USDT, under a minimum of 5, and the warning says so (`[<id>] BUY MARKET order of 5.5 USDT: 0.0000870833333333333 BTC at 60000 sent, truncated to 0.00008 BTC on the amount step 0.00001 of the market, a cost of 4.8 USDT once 5 % is kept back for the fee, below the minimum cost of 5 USDT on BTC/USDT, which the market refuses at that price`). An order sized to 0 is warned of with its cause instead, and one the step cuts to 0 is refused for its amount, the refusal naming the step. An all-in BUY is warned of in the same way, as a BUY of `allocation: 100` of the same amount is, its line naming the currency it was sized from (`[<id>] All-in BUY MARKET order sized from 5 USDT: 0.0475 BTC at 100 sent, a cost of 4.75 USDT once 5 % is kept back for the fee, below the minimum cost of 10 USDT on BTC/USDT, which the market refuses at that price`); an order with an `amount`, and an all-in SELL, are not.
- **The order events** carry `cost` and `allocation` as your strategy gave them, beside `amount`, the amount the Trader sized (in `onOrderCompleted`, the amount executed). The Trader logs how it sized each order by `cost` or `allocation` at `debug` level (`[<id>] BUY MARKET order of 600 USDT sized to 5.7 BTC at 100`).

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
```

### Trailing Stops

A `trailing` on a BUY asks Gekko to protect what the BUY buys: a stop follows the price up, and sells at the market once the price falls `percentage` below its highest point. Gekko trails it on every one-minute candle, whatever the timeframe, and tells your strategy through two hooks, which get `tools` as their last argument.

- **Armed when the BUY completes**, for the amount it filled, from a copy of `trailing` taken by `createOrder`: changing your object afterwards changes nothing. A BUY canceled loses its stop, even after a partial fill. A BUY that errors after a reported fill (`order.filled`) gets its stop for that part; one that errors with no fill reported loses it. A warning says which, and whether the BUY may still be live on the exchange.
- **Activated**: a stop without `trigger` is active as soon as it is armed, and `onTrailingStopActivated(state, tools)` is called then, right after `onOrderCompleted`, or right after `onOrderErrored` for a BUY that errored after a reported fill (its stop armed for that fill), its peak and its stop price still 0. It takes its first peak from the open of the next one-minute candle, not from the price the BUY filled at: the price can fall more than `percentage` below that price before the stop triggers. A stop with a `trigger` waits until the high of a one-minute candle reaches it. Its peak is then that candle's open when the open reached the trigger, else its high, and `onTrailingStopActivated` is called before the rest of that candle is trailed.
- **Trailed**: each one-minute candle is met as open, low, high, close, each price tested against the stop price, `peak × (1 − percentage / 100)`, before it raises the peak. So a candle that rises more than `percentage` from its open does not trigger the stop on its own low. The candle that activates a stop with a trigger is met from its open when the open reached the trigger; otherwise only its close is tested, after its high.
- **Triggered**: a price at or below the stop price makes Gekko create a MARKET SELL of the stop's amount, then call `onTrailingStopTriggered(orderId, state, tools)`, `state` holding the peak and the stop price of that moment. That SELL is an order of your strategy's from then on: its outcome comes through `onOrderCompleted`, `onOrderCanceled` or `onOrderErrored`, under `orderId`. A strategy that tracks its position adopts it as its pending SELL (see [Tracking Your Position](#tracking-your-position)); otherwise it stays long once the stop has sold everything, and its next SELL is refused, nothing being left to sell.
- **Selling**: the stop (`state.status` `'selling'`, `state.sellOrderId` its SELL) sells until that SELL ends. Completed for all of the stop's amount, the stop is over. So it is when that SELL errors or is canceled after a reported fill (`order.filled`) of all of it (`[TRAILING STOP] Trailing stop of BUY <id> over: its SELL <id> sold 0.5, all of its 0.5`, at info level). Completed for less (the Trader caps a SELL to the free balance and to the most the market takes in one order, and the exchange truncates its amount to the market's step), errored or canceled for less, it is active again for what that SELL did not sell, from the peak and the stop price it triggered at, with a warning (`Trailing stop of BUY <id> active again: its SELL <id> completed after selling 0.3 of its 0.5 BTC …`): the next price at or below that stop price triggers it again, and `onTrailingStopTriggered` announces its new SELL under a new id, to adopt as the first one. The stop is over instead when nothing it can sell is left to protect: when that rest is too little to sell at the minimums of the market, whatever else your account holds (`Trailing stop of BUY <id> over: …, and the rest, 0.0001 BTC, is too little to sell at the minimums of the market`, at info level), or when the portfolio after that SELL shows too little of the asset free to sell, while no SELL of yours is pending on the pair (at info level after a SELL that completed, such as one whose BUY's fee the exchange took from the asset bought; with a warning, `… removed: …`, after one that errored or was canceled). A SELL that errored while it may still be live on the exchange (`order.mayBeLive` in `onOrderErrored`: its answer lost, the exchange busy or overloaded) makes the stop active again all the same for a rest it can sell, with a warning to check that SELL on the exchange (`Trailing stop of BUY <id> kept: its SELL <id> errored, …, and may still have gone through on the exchange, …`). A MARKET SELL rests on no book: it may only have executed. If it did, the portfolio after it shows the asset gone and the stop is removed, or the stop's next SELL is refused for lack of anything to sell and that refusal removes it; unless your account holds other coins of the asset free, which that next SELL sells, up to the stop's amount. If it did not, the stop still protects your position. A SELL refused every time with the asset still free (an API key refused, a cost above the maximum of the market) is sent again on each such minute, each refusal counting towards `maxConsecutiveErrors`.
- **Your own SELLs**: while a SELL your strategy created is pending on a pair, the stops of that pair keep trailing but do not trigger (`[STRATEGY] Trailing stop of BUY <id> held back: …`, once per stop, at info level): the exchange reserves the asset for your SELL, and the stop's SELL would be refused. Completed, your SELL cancels every stop armed on the pair, whatever the amount sold, with an info line: a strategy that scales out loses its stops at its first SELL. Canceled or errored, with no other SELL of yours pending there, it releases them (`… resumes: …`), and the next price at or below a stop price triggers that stop. So a take-profit LIMIT SELL left pending leaves the position without a working stop for as long as it pends, the part it does not reserve included. The SELL a stop sends cancels no other stop, and a stop whose BUY has not completed yet is kept.
- **Canceled by you**: `tools.cancelTrailingOrder(state.id)`, `state.id` being the BUY's id, at any time. From `onTrailingStopActivated`, the stop is gone before the rest of its activation candle is trailed. To take over from a stop that is selling, cancel the stop, not its SELL: a canceled SELL makes the stop active again.

`state` is a `TrailingStopState` (`@gekko/strategies/trailingStopManager.types`): `id` (its BUY's), `symbol`, `amount` (what its SELL sells), `config` (the `trailing`), `status` (`'dormant'` until its trigger is reached, `'active'`, `'selling'`), `highestPeak`, `stopPrice`, `activationPrice` (the trigger), `createdAt` and, while it sells, `sellOrderId`.

---

## Tracking Your Position

`createOrder` returns before the exchange has seen the order, and Gekko relays every order you create: a strategy that advises a BUY on every candle of an uptrend sends an all-in BUY on each, each sized from what the ones before left, until they are refused for want of currency and the circuit breaker stops the bot. So a strategy that trades all-in keeps its position and its pending order, and moves them only on the outcome of its orders:

- it buys only when flat and sells only when long, never while an order of its own is pending;
- a completed BUY makes it long, a completed SELL flat, unless it sold less than it asked for (an all-in SELL asks for all of the asset free, and the Trader caps a SELL at the most the market takes in one order): the portfolio after it then tells, long when what is left free is enough to sell;
- an order canceled or errored may have executed before it ended, in part or in full: the position is read from what its event reports, rather than left as it was. The portfolio after the order (`exchange.portfolio`) tells what is left of the asset, a position when it is enough to sell at the minimums of the market (`tools.marketData`);
- the SELL a trailing stop sends is the strategy's own from `onTrailingStopTriggered` on: it adopts that id as a pending SELL;
- it starts flat: a holding present at start-up is sold only by its first SELL, which follows a BUY that completed, or one that ended without completing while the account held the asset, or, on several pairs, a BUY the PositionBook skipped while the portfolio showed the asset free, enough to sell.

A strategy that trades several pairs of one currency keeps this bookkeeping pair by pair, and gives each BUY a share of the currency with `allocation` rather than all of it: all-in, the first BUY of a candle leaves the others nothing to spend, and each of their refusals counts towards the circuit breaker (see [Order Parameters](#order-parameters)). The PositionBook below does both, as the built-in signal strategies do.

**The PositionTracker, for one pair.** A `PositionTracker` (`packages/strategies/src/helpers/positionTracker/positionTracker.ts`) keeps this bookkeeping for one pair, and a strategy of your checkout's `packages/strategies/src/custom/` can use it, here on the first pair watched, taken with `pickTradedPair` (`packages/strategies/src/helpers/positionTracker/positionTracker.helper.ts`) as GridBot takes its own:

```typescript
import { PositionTracker } from '@gekko/strategies/helpers/positionTracker/positionTracker';
import { pickTradedPair } from '@gekko/strategies/helpers/positionTracker/positionTracker.helper';
import { compareWithTolerance } from '@gekko/shared/utils/math/math.utils';

export class MyTrackedStrategy implements Strategy<MyParams> {
  private readonly position = new PositionTracker();
  private pair?: TradingPair;

  init({ candle, tools, addIndicator }: InitParams<MyParams>): void {
    // The first pair of watch.assets, with a warning naming the others when several are watched
    this.pair = pickTradedPair(candle, tools);
    addIndicator('EMA', this.pair, { period: tools.strategyParams.short });
    addIndicator('EMA', this.pair, { period: tools.strategyParams.long });
  }

  onTimeframeCandleAfterWarmup({ tools }: OnCandleEventParams<MyParams>, ...indicators: IndicatorResults[]): void {
    const [shortEma, longEma] = indicators;
    if (!this.pair || typeof shortEma.results !== 'number' || typeof longEma.results !== 'number') return;
    // Above, below, or within a relative 1e-9 of each other: equal, which is no signal (see Validate Indicator Values)
    const shortToLong = compareWithTolerance(shortEma.results, longEma.results);
    // canBuy: flat and nothing pending; canSell: long and nothing pending. buy and sell keep the order pending until its outcome
    if (shortToLong > 0 && this.position.canBuy())
      this.position.buy(tools.createOrder, { type: 'STICKY', symbol: this.pair, trailing: { percentage: 5 } });
    else if (shortToLong < 0 && this.position.canSell())
      this.position.sell(tools.createOrder, { type: 'STICKY', symbol: this.pair });
  }

  // Handed over whole: the tracker reads the order, the portfolio after it, the market data and the log
  onOrderCompleted(params: OnOrderCompletedEventParams<MyParams>): void {
    this.position.onOrderCompleted(params);
  }

  onOrderCanceled(params: OnOrderCanceledEventParams<MyParams>): void {
    this.position.onOrderCanceled(params);
  }

  onOrderErrored(params: OnOrderErroredEventParams<MyParams>): void {
    this.position.onOrderErrored(params);
  }

  // The SELL of a trailing stop: adopted, its outcome settles the position as a SELL of the strategy's would
  onTrailingStopTriggered(orderId: UUID): void {
    this.position.adoptSell(orderId);
  }
}
```

For an order canceled or errored, the tracker reads what a canceled BUY filled, what a canceled SELL of an `amount` sent for all of it left unsold (that amount is the position, as when such a SELL completes), and otherwise the free balance of the asset in the portfolio after the order, a SELL canceled after a fill included, whose fill tells what is left of the order, not of the holding, though never less than what it left unsold, which the cancelation released (a portfolio read before it, or never, leaves that out), truncated to the lot step of the market and checked against its minimum amount and cost, the cost worked out in decimal, as the exchange checks a SELL; a position it reads that way and that differs from the one it held is logged at info level, through `tools.log`. It reads a completed SELL from that free balance too when the SELL sold less than it asked for, as it reads every SELL without an `amount`, all-in or by `cost` or `allocation`, and every adopted one, which ask for all of the asset free or for an amount it does not know: long when enough is left to sell, logged then. So an account that holds the asset but too little currency to buy has its first all-in BUY refused; the tracker then takes the asset's free balance, in the portfolio after that refusal, as the position, and the strategy sells it at its next SELL signal. `adoptHolding(held, price, type, marketData)` takes a holding that no order of the tracker's own brought for the position: long when the tracker is flat with nothing pending and `held` is enough to sell at `price`, returning whether it went long; the PositionBook calls it for a BUY it skips, which a refusal would have taught the position. The tests of such a strategy can drive it as the built-in suites do, with the `OrderRecorder`, `relayOrderOutcome` and `playSteps` helpers of `packages/strategies/src/helpers/positionTracker/positionTracker.mock.ts`.

**The PositionBook, for several pairs.** The built-in signal strategies trade every watched pair through a `PositionBook` (`packages/strategies/src/helpers/positionBook/positionBook.ts`), which keeps one `PositionTracker` per pair and gives each BUY its pair's share of the currency (see [Pairs and Capital](./built-in-strategies.md#pairs-and-capital) for the share, and for the BUYs it skips). A strategy of your checkout's `packages/strategies/src/custom/` can trade through it as they do:

```typescript
import { PositionBook } from '@gekko/strategies/helpers/positionBook/positionBook';
import { indicatorsBySymbol } from '@gekko/strategies/helpers/strategy.helper';
import { compareWithTolerance } from '@gekko/shared/utils/math/math.utils';

export class MyMultiPairStrategy implements Strategy<MyParams> {
  private readonly book = new PositionBook();

  init(params: InitParams<MyParams>): void {
    const { tools, addIndicator } = params;
    // Every pair of watch.assets, in its order, each flat with nothing pending; with several, an info line names them
    this.book.track(params);
    for (const pair of this.book.pairs) {
      addIndicator('EMA', pair, { period: tools.strategyParams.short });
      addIndicator('EMA', pair, { period: tools.strategyParams.long });
    }
  }

  onTimeframeCandleAfterWarmup(params: OnCandleEventParams<MyParams>, ...indicators: IndicatorResults[]): void {
    // The indicator arguments of each pair, in the order init added them
    const byPair = indicatorsBySymbol(indicators);
    for (const pair of this.book.pairs) {
      const [shortEma, longEma] = byPair.get(pair) ?? [];
      if (typeof shortEma?.results !== 'number' || typeof longEma?.results !== 'number') continue;
      const shortToLong = compareWithTolerance(shortEma.results, longEma.results);
      // canBuy and canSell read the pair's own position: an order pending on another pair holds nothing back here
      if (shortToLong > 0 && this.book.canBuy(pair)) {
        // Sent with the pair's share of the currency, and kept pending; on several pairs, undefined when the market would refuse it as
        // too small: the book then sends nothing, and says so
        const id = this.book.buy({ type: 'STICKY', symbol: pair, trailing: { percentage: 5 } }, params);
        if (id) params.tools.log('info', `[${pair}] EMA crossover: BUY ${id}`);
      } else if (shortToLong < 0 && this.book.canSell(pair)) {
        this.book.sell({ type: 'STICKY', symbol: pair }, params);
      }
    }
  }

  // Handed over whole: the book hands each event to the tracker of the order's pair
  onOrderCompleted(params: OnOrderCompletedEventParams<MyParams>): void {
    this.book.onOrderCompleted(params);
  }

  onOrderCanceled(params: OnOrderCanceledEventParams<MyParams>): void {
    this.book.onOrderCanceled(params);
  }

  onOrderErrored(params: OnOrderErroredEventParams<MyParams>): void {
    this.book.onOrderErrored(params);
  }

  // The SELL of a trailing stop, adopted by the tracker of the stop's pair
  onTrailingStopTriggered(orderId: UUID, state: TrailingStopState): void {
    this.book.adoptSell(orderId, state.symbol);
  }
}
```

`track`, called once, from `init`, tracks every pair of `candle`, in the order of `watch.assets`, and `pairs` lists them; with several, it logs one `info` line naming them and how they share the currency. `indicatorsBySymbol` (`packages/strategies/src/helpers/strategy.helper.ts`) groups the hooks' indicator arguments by pair, each pair's in the order `init` added them. `canBuy(pair)` and `canSell(pair)`, like `isLong(pair)` and `isPendingOrder(pair)`, read the tracker of the pair, and are false for a pair the book does not track. `buy(order, params)` takes the order without its side and its size, and the hook's params whole, for the portfolio, the candle (the price it values the BUY at) and the tools: it sends the BUY with its pair's share of the currency, keeps it pending and returns its id, or, on several pairs, skips it and returns `undefined` (see [Pairs and Capital](./built-in-strategies.md#pairs-and-capital)). A skipped BUY is not refused either; the book reads the holding a refusal would have shown: when the hook's portfolio holds enough of the pair's asset free to sell at the close, the tracker of the pair goes long, said at the `info` level (`[BTC/USDT] BUY skipped: 50 % of the 8 USDT free, 3.8 USDT once 5 % is kept back for the fee, is below the minimum cost of 5 USDT of the market, but 0.002 BTC is free in the portfolio, enough to sell: the strategy is long`), and the strategy sells that holding at its next SELL signal. A book that tracks one pair never skips: its all-in BUY is sent, and refused when the currency is too little, as a tracker's always was (see [Position and Orders](./built-in-strategies.md#position-and-orders)). `sell(order, params)` sends an all-in SELL of the pair. The three order hooks hand each event to the tracker of the order's pair, and return whether the order was one of its own; `adoptSell(orderId, symbol)` adopts the SELL of a trailing stop on the stop's pair, `state.symbol`. A symbol the book does not track, given to `buy`, `sell` or `adoptSell`, throws a `GekkoError`, which stops Gekko (`[STRATEGY] Impossible to place the BUY STICKY order on XRP/USDT: the position book does not track it (it tracks BTC/USDT and ETH/USDT)`), and so does a second call of `track`. Name the pair in the lines you log about it, as the built-in strategies do (`[BTC/USDT] …`): on several pairs, a line that does not say which is hard to follow. The tests of such a strategy can drive it with the helpers of `packages/strategies/src/helpers/positionBook/positionBook.mock.ts`, beside those of `positionTracker.mock.ts`.

A strategy loaded through `strategyPath` can import neither the PositionTracker nor the PositionBook (see [Where Your Strategy Lives](#where-your-strategy-lives)): the class of the [Lifecycle Methods](#lifecycle-methods) and the [Complete Example](#complete-example) keep the same bookkeeping by hand, on one pair.

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
- Any problem stops Gekko before the first candle, with exit code 1, and the log lists every problem with the path of its parameter. With `shortPeriod: '12'` (quoted, so a string) and a misspelt `longPeriode`:

  ```text
  [TRADING ADVISOR] Invalid parameters for strategy EMACrossover (strategy block):
  ✖ Unrecognized key: "longPeriode"
  ✖ Invalid input: expected number, received string
    → at shortPeriod
  ✖ Invalid input: expected number, received undefined
    → at longPeriod
  ```

Without a `schema`, the whole block, `name` included, reaches the strategy unchecked, and Gekko says so as it starts, in an `info` line.

Your strategy imports `zod` itself, and like any package it is looked up from the strategy file's folder: unless the file sits inside a Gekko checkout, whose `node_modules` has it, install it next to the strategy (`bun add zod` or `npm install zod` in its folder). Otherwise Gekko stops with `[TRADING ADVISOR] Cannot import the strategy file …/emaCrossover.strategy.ts: ResolveMessage: Cannot find package 'zod' from '…/emaCrossover.strategy.ts'`. The same goes for any other package (see [Where Your Strategy Lives](#where-your-strategy-lives) for the packages the compiled executable cannot find).

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

Here's a complete EMA crossover strategy, which validates its parameters, tracks its position through the outcome of its orders, and can protect each position with a trailing stop:

### Strategy File: `/home/user/strategies/emaCrossover.strategy.ts`

```typescript
import { OrderSide } from '@gekko/shared/models/order.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import {
  IndicatorResults,
  InitParams,
  OnCandleEventParams,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Strategy,
  Tools,
} from '@gekko/strategies/strategy.types';
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
type UnfinishedOrderParams = OnOrderCanceledEventParams<EMACrossoverParams> | OnOrderErroredEventParams<EMACrossoverParams>;
type EndedOrderParams = OnOrderCompletedEventParams<EMACrossoverParams> | UnfinishedOrderParams;

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

  private pair?: TradingPair;
  // createOrder only returns the order's id: its outcome arrives later, through the order hooks, so the position is only known
  // then. Until then the order is pending, and no other one is sent.
  private isLong = false;
  private readonly pendingOrders = new Map<UUID, OrderSide>();

  init({ candle, addIndicator, tools }: InitParams<EMACrossoverParams>): void {
    const { src, shortPeriod, longPeriod } = tools.strategyParams;
    // candle holds one candle per watched pair, in the order of watch.assets: this strategy trades the first one alone. A file loaded
    // through strategyPath cannot import the PositionBook, which trades every pair as the built-in signal strategies do
    const [pair, ...ignored] = candle.keys();
    if (ignored.length) tools.log('warn', `EMACrossover trades ${pair} only, and ignores ${ignored.join(', ')}`);
    this.pair = pair;
    addIndicator('EMA', pair, { period: shortPeriod, src });
    addIndicator('EMA', pair, { period: longPeriod, src });
  }

  onTimeframeCandleAfterWarmup(
    { candle, tools }: OnCandleEventParams<EMACrossoverParams>,
    ...indicators: IndicatorResults[]
  ): void {
    const { log, createOrder, strategyParams } = tools;
    const [shortEma, longEma] = indicators;

    if (!this.pair || this.pendingOrders.size) return;
    const current = candle.get(this.pair);
    // results is unknown, and null until the EMA has seen enough candles
    if (!current || typeof shortEma.results !== 'number' || typeof longEma.results !== 'number') return;

    // Above, below, or within the tolerance of each other: equal, which is no cross
    const shortToLong = compareWithTolerance(shortEma.results, longEma.results);
    // Golden cross: short EMA above long EMA, and nothing is held
    if (shortToLong > 0 && !this.isLong) {
      log('info', `Golden cross at ${current.close} — BUY signal`);
      const { trailingPercentage } = strategyParams;
      const trailing = trailingPercentage ? { percentage: trailingPercentage } : undefined;
      this.pendingOrders.set(createOrder({ type: 'STICKY', side: 'BUY', symbol: this.pair, trailing }), 'BUY');
    }
    // Death cross: short EMA below long EMA, and the BUY has completed
    else if (shortToLong < 0 && this.isLong) {
      log('info', `Death cross at ${current.close} — SELL signal`);
      this.pendingOrders.set(createOrder({ type: 'STICKY', side: 'SELL', symbol: this.pair }), 'SELL');
    }
  }

  log({ tools }: OnCandleEventParams<EMACrossoverParams>, ...indicators: IndicatorResults[]): void {
    const [shortEma, longEma] = indicators;
    if (typeof shortEma.results === 'number' && typeof longEma.results === 'number') {
      tools.log('debug', `EMA(short): ${shortEma.results.toFixed(2)} | EMA(long): ${longEma.results.toFixed(2)}`);
    }
  }

  onOrderCompleted(params: OnOrderCompletedEventParams<EMACrossoverParams>): void {
    const side = this.pendingOrders.get(params.order.id);
    if (!side) return;
    this.pendingOrders.delete(params.order.id);
    // A SELL, all-in here, may have sold less than the position: the Trader caps a SELL at the most the market takes in one order. The
    // strategy is still long when the portfolio after it holds enough of the asset to sell
    this.isLong = side === 'BUY' || this.holdsSellable(params) === true;
  }

  onOrderCanceled(params: OnOrderCanceledEventParams<EMACrossoverParams>): void {
    this.settleUnfinished(params);
  }

  onOrderErrored(params: OnOrderErroredEventParams<EMACrossoverParams>): void {
    this.settleUnfinished(params);
  }

  // The stop sold at the market: its SELL is the strategy's own from now on, adopted so that its outcome settles the position
  onTrailingStopTriggered(orderId: UUID, state: TrailingStopState, tools: Tools<EMACrossoverParams>): void {
    tools.log('info', `Trailing stop of BUY ${state.id} hit at ${state.stopPrice}: SELL ${orderId}`);
    this.pendingOrders.set(orderId, 'SELL');
  }

  // Canceled or errored, an order may have executed first, in part or in full: the position is read from the portfolio after it
  private settleUnfinished(params: UnfinishedOrderParams): void {
    if (!this.pendingOrders.delete(params.order.id)) return;
    // undefined without a balance read yet: nothing tells, the position stays as it was
    this.isLong = this.holdsSellable(params) ?? this.isLong;
  }

  // Whether the free balance of the asset in the portfolio after an order, cut to the amount step of the market, passes its minimum
  // amount and minimum cost; undefined when no balance was read yet. Worked out in decimal, as the exchange works it out: rounded to
  // 15 significant digits, a quotient or a product loses the noise of binary arithmetic (0.29 / 0.01 is 28.999999999999996, which
  // would cut 0.29 to 0.28, and 0.00007 × 100000 is 6.999999999999999, under a minimum cost of 7)
  private holdsSellable({ order, exchange, tools }: EndedOrderParams): boolean | undefined {
    const [asset] = order.symbol.split('/');
    const free = exchange.portfolio.get(asset)?.free;
    if (free === undefined) return undefined;
    const { amount, cost, precision } = tools.marketData.get(order.symbol) ?? {};
    const step = precision?.amount;
    const decimal = (value: number) => Number(value.toPrecision(15));
    const sellable = step ? decimal(Math.floor(decimal(free / step)) * step) : free;
    const isCostEnough = exchange.price <= 0 || decimal(sellable * exchange.price) >= (cost?.min ?? 0);
    return sellable > 0 && sellable >= (amount?.min ?? 0) && isCostEnough;
  }

  // The other hooks are optional, and left out
}
```

`createOrder` returns before the exchange has seen the order: `onOrderCompleted`, `onOrderCanceled` or `onOrderErrored` tells later what became of it, with the id `createOrder` returned. Live, an order hook runs as the bucket after the order's end arrives, before that bucket's candle hooks; in a backtest, after the candle hooks of the bucket the order filled in. This is why the example keeps that id, and only moves `isLong` once the order has ended: a completed BUY makes it long; a completed SELL, which may have sold less than the position, and a canceled or errored order, which may have executed first, are read from the portfolio after them. The SELL a trailing stop sends is adopted in `onTrailingStopTriggered`, so that its outcome settles the position too. The two EMAs are compared with a copy of Gekko's `compareWithTolerance`, within whose tolerance they are equal and cross neither way (see [Validate Indicator Values](#2-validate-indicator-values)). The file imports Gekko's types only, and `zod`, which has to be installed next to it (see [Validating Your Parameters](#validating-your-parameters)). So it trades the first watched pair alone, warning of the others: a strategy that trades every pair lives in `packages/strategies/src/custom/`, where it can trade through the [PositionBook](#tracking-your-position).

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

The simulator receives each order as the live exchange does: its amount truncated to the amount step (`precision.amount`), its price rounded half up to the price tick (`precision.price`). An amount truncated to 0, below `amount.min`, or whose cost falls under `cost.min`, is refused (the Trader warns of one it sized, by `cost`, `allocation` or all-in for a BUY, before it sends it: see the Trader's [Sizing](./plugins.md#sizing)), and an order fills for the amount truncated. The cost is worked out in decimal, as the exchange works it out: an order costing exactly `cost.min` passes. For Hyperliquid, whose tick depends on the price, add `priceSignificantDigits: 5` under `precision`.

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

Compare a price with an average, or two averages, with a relative tolerance rather than strictly: values equal in exact arithmetic come out a few ulps apart on a flat market, and a strict comparison then trades on noise. A strategy under `packages/strategies/src/custom/` can use `compareWithTolerance` from `@gekko/shared/utils/math/math.utils`, as the [PositionTracker example](#tracking-your-position) does; a file loaded through `strategyPath` cannot import it and carries its own copy, as the [Complete Example](#complete-example) does.

### 3. Track the Order, Not the Signal

Decide from your position and your pending order, which only the order hooks move (see [Tracking Your Position](#tracking-your-position)), not from the last signal you acted on: a strategy that only remembers the trend it ordered on does not know whether that order went through, never sends again a BUY that was refused, and cannot tell when it holds something to sell. Act on the position instead, here in the class of the [Lifecycle Methods](#lifecycle-methods):

```typescript
onTimeframeCandleAfterWarmup({ tools }: OnCandleEventParams<MyParams>, ...indicators: IndicatorResults[]): void {
  const [shortEma, longEma] = indicators;
  if (typeof shortEma.results !== 'number' || typeof longEma.results !== 'number') return;
  // Above, below, or within the tolerance of each other: equal, which is neither trend (see Validate Indicator Values)
  const shortToLong = compareWithTolerance(shortEma.results, longEma.results);

  // The order hooks clear pendingOrderId and read isLong from the outcome: a BUY refused is sent again on the next candle of the uptrend
  if (this.pendingOrderId) return;
  const { symbol } = shortEma;
  if (shortToLong > 0 && !this.isLong) this.pendingOrderId = tools.createOrder({ type: 'STICKY', side: 'BUY', symbol });
  else if (shortToLong < 0 && this.isLong) this.pendingOrderId = tools.createOrder({ type: 'STICKY', side: 'SELL', symbol });
}
```

Each order refused counts towards `maxConsecutiveErrors`: a strategy that would rather wait for the next trend keeps, beside its position, whether the current trend has ordered, as the built-in DEMA does.

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

Gekko loads the strategy as it starts: it imports the file at `strategyPath` (a relative path is resolved against the directory Gekko is started from, not against the config file), then takes the export named `strategyName` from it. A failure stops Gekko with exit code 1, and the log says which step failed: `[TRADING ADVISOR] Cannot import the strategy file <path>: …`, followed by Bun's reason, or `[TRADING ADVISOR] Cannot find external <strategyName> strategy in <path>`:

- `[TRADING ADVISOR] Cannot import the strategy file /home/user/strategies/myStrategy.strategy.ts: ResolveMessage: Cannot find module '/home/user/strategies/myStrategy.strategy.ts' from '…'`: there is no file at that path (`strategyPath` once resolved).
  - Verify `strategyPath` points to the correct file
  - For a relative `strategyPath`, check the directory Gekko is started from, or use an absolute path
- `[TRADING ADVISOR] Cannot import the strategy file …/myStrategy.strategy.ts: ResolveMessage: Cannot find module '@gekko/strategies/helpers/positionTracker/positionTracker' from '…/myStrategy.strategy.ts'`, or another Gekko module (`'../helpers/positionBook/positionBook'` for a copy of a built-in signal strategy): the file imports a Gekko module, which a file loaded through `strategyPath` cannot: import only types from Gekko, or move the strategy to `packages/strategies/src/custom/` (see [Where Your Strategy Lives](#where-your-strategy-lives)).
- `[TRADING ADVISOR] Cannot import the strategy file …/myStrategy.strategy.ts: ResolveMessage: Cannot find package 'zod' from '…/myStrategy.strategy.ts'`: install the package next to the strategy. The compiled executable never finds a package without an `index.js` at its root, such as `lodash-es` (see [Where Your Strategy Lives](#where-your-strategy-lives)).
- `[TRADING ADVISOR] Cannot import the strategy file /home/user/strategies/myStrategy.strategy.ts: BuildMessage: Expected ")" but found ";" at /home/user/strategies/myStrategy.strategy.ts:12:21`: a syntax error at that line and column of the file named, the strategy file or a file it imports. Two or more are listed one after the other, after Bun's count, and one mistake can make several: `[TRADING ADVISOR] Cannot import the strategy file /home/user/strategies/myStrategy.strategy.ts: 2 errors building "/home/user/strategies/myStrategy.strategy.ts": BuildMessage: Expected ")" but found ";" at …:12:21; BuildMessage: Expected "]" but found ";" at …:13:20`.
- `[TRADING ADVISOR] Cannot find external MyStrategy strategy in /home/user/strategies/myStrategy.strategy.ts`: the file was loaded, but exports nothing under the name `strategyName`.
  - Ensure `strategyName` matches your exported class name exactly (case-sensitive)
  - Check that your class is exported with `export class` (an `export default` class is not found)
  - A built-in name beside a `strategyPath` (`strategyName: RSI`) is looked up in that file only: leave `strategyPath` out to run a built-in strategy
- `[TRADING ADVISOR] Cannot find internal MyStrategy strategy`: `strategyPath` is missing, so Gekko looked for a built-in strategy of that name (or one exported from `packages/strategies/src/custom/index.ts`).

### "Cannot find module '@helpers/…'" or "'@strategies/…'" from your checkout's custom strategies

A strategy of your checkout written for an older version of Gekko imports Gekko's modules from where that version kept them. Gekko's checkout is now a set of packages (see the [README](../README.md)): its code moved out of `src/`, into packages imported by their name, `@gekko/<package>/<path>`, and the aliases of `src/` (`@constants/…`, `@errors/…`, `@models/…`, `@utils/…`, `@helpers/…`, `@indicators/…`, `@strategies/…`, `@plugins/…`, `@services/…`) are gone, with nothing left at the old paths. The private strategies moved too, from `src/strategies/custom/` to `packages/strategies/src/custom/`, which is the one directory Gekko reads them from: move your files there, and your exports into its placeholder `index.ts`. The pull that brings the packages moves the placeholder, and stops as any update of it does: set your exports aside, run `git update-index --no-skip-worktree src/strategies/custom/index.ts` and `git checkout -- src/strategies/custom/index.ts`, pull, then move your files and write your exports into `packages/strategies/src/custom/index.ts`, which `bun install` marks skip-worktree (see [Where Your Strategy Lives](#where-your-strategy-lives)). Git still ignores the files left in `src/strategies/custom/`, so that neither `git status` lists them nor `git add -A` stages them, but `bun run lint:check` reads them, and refuses their old imports, until you move them. Gekko loads the strategies of `packages/strategies/src/custom/index.ts` with its own as it starts, so an old path stops every run, whatever its mode and whatever strategy the configuration runs, before any plugin starts: the line, `ResolveMessage: Cannot find module '@helpers/strategy/positionTracker/positionTracker' from '…/packages/strategies/src/custom/myStrategy.strategy.ts'`, has no `[TRADING ADVISOR]` prefix, `bun run type:check` reports the import (`TS2307: Cannot find module '@helpers/strategy/positionTracker/positionTracker' or its corresponding type declarations`), and `bun run build:exec` refuses to build (`Could not resolve: "@helpers/strategy/positionTracker/positionTracker"`). Import from the new paths, where the classes and the functions kept their names:

- Gekko's types: `@strategies/strategy.types` and `@strategies/trailingStopManager.types` are `@gekko/strategies/strategy.types` and `@gekko/strategies/trailingStopManager.types`, and `@models/<name>.types` is `@gekko/shared/models/<name>.types` (`@gekko/shared/models/order.types`, `@gekko/shared/models/utility.types`).
- The position: `@helpers/strategy/positionTracker/positionTracker` is `@gekko/strategies/helpers/positionTracker/positionTracker`, and so for its `.helper` (`pickTradedPair`, `isSellable`) and its `.mock` (`OrderRecorder`, `relayOrderOutcome`, `playSteps`), `@helpers/strategy/positionBook/positionBook` is `@gekko/strategies/helpers/positionBook/positionBook`, and `@helpers/strategy/strategy.helper` (`indicatorsBySymbol`) is `@gekko/strategies/helpers/strategy.helper`.
- The utilities and helpers: `@utils/<dir>/<name>.utils` is `@gekko/shared/utils/<dir>/<name>.utils` (`@gekko/shared/utils/math/math.utils`), every other `@helpers/<dir>/<name>` is `@gekko/shared/helpers/<dir>/<name>` (`@gekko/shared/helpers/market/market.helper`), and `@constants/…` and `@errors/…` are `@gekko/shared/constants/…` and `@gekko/shared/errors/…`.
- The indicators: `@indicators/<path>` is `@gekko/indicators/<path>` (`@gekko/indicators/movingAverages/ema/ema.indicator`).
- A built-in strategy's schema: `@strategies/<name>/<name>.schema` is `@gekko/schemas/strategies/<name>.schema` (`@gekko/schemas/strategies/dema.schema`).
- From a version older still, which kept the PositionTracker and the helpers elsewhere: `@strategies/positionTracker` is `@gekko/strategies/helpers/positionTracker/positionTracker` (`PositionTracker`) and `…/positionTracker.helper` (`pickTradedPair`, `isSellable`), `@strategies/positionTracker.mock` is `…/positionTracker.mock`; `@utils/<dir>/<name>.utils` for candle, event, finance/stats, market, market/precision, portfolio and stream is `@gekko/shared/helpers/<dir>/<name>.helper` (`@utils/market/market.utils` is `@gekko/shared/helpers/market/market.helper`), `@utils/async/asyncMutex` and `@utils/collection/ringBuffer` are `@gekko/shared/helpers/async/asyncMutex` and `@gekko/shared/helpers/collection/ringBuffer`, and `getBuyBudget` and `getAllInBuyAmount`, of `@plugins/trader/trader.utils`, are in `@gekko/shared/helpers/order/sizing.helper`; any other `<name>.utils` outside `utils/` is `<name>.helper` (`@gekko/indicators/indicator.helper`, `@gekko/shared/errors/error.helper`, `@gekko/strategies/gridBot/gridBot.helper`).
- The logger (`@services/logger`) and the rest of `@services/…`, now `@gekko/core/…`, and the plugins (`@plugins/…`, now `@gekko/plugins/…`) are no longer a strategy's to import: `bun run lint:check` refuses them. Log through `tools.log`.

A file loaded through `strategyPath` whose old imports bring types only still runs, Bun dropping them, but its editor no longer finds them: import them from the new paths too. The examples of this guide import from the new paths (see [Tracking Your Position](#tracking-your-position)).

### "Invalid parameters for strategy … (strategy block)"

Your class's `schema` refused the `strategy:` block, before the first candle: each `✖` line is a problem, and the `→ at` line under it names its parameter (see [Validating Your Parameters](#validating-your-parameters)).

### "Orders are not available until the warmup is over"

Your strategy called `createOrder` before the warmup was over: from `init`, or from `onEachTimeframeCandle` on a warmup candle or on the candle that completes the warmup, which it runs on before the warmup ends. Create orders from `onTimeframeCandleAfterWarmup`, `log` or an order hook.

### "Impossible to create the … order on …"

`createOrder` refused the order, and sent nothing: the end of the line names the field and what it accepts (see [Order Parameters](#order-parameters)).

- `order keys must be one of 'symbol', 'side', 'type', 'amount', 'cost', 'allocation', 'price', 'trailing', got '…'`: the order holds a key `StrategyOrder` does not declare, misspelt (`prise`, `limitPrice`, `amout`, `allocaton`, `trailingStop`) or of your own (`quantity`, `comment`). Mind the spelling, and build the order from its fields rather than passing an event's order or a parameter object as it is.
- `symbol must be one of the watched pairs (…)`: Gekko only has candles, prices and balances of the assets of `watch.assets` against `watch.currency`. Take the pair from `candle.keys()`, or add its asset to `watch.assets`; mind the case (`BTC/USDT`, not `btc/usdt`) and the slash (not the exchange's id `BTCUSDT`).
- `side` and `type` must be spelt in upper case, as typed.
- `amount`, `cost` and `price` must be numbers above 0, or left out, and `allocation` a number above 0 and at most 100 (`25` for 25 %): check a computed value, which may be 0 or `NaN` when a balance or a price is, or a share that came out above 100.
- `amount, cost and allocation size an order three ways: give at most one, got amount and cost`: the order gives two or three of them (`null` or `undefined` counts as left out), and the Trader would not know which to follow. Keep the one you mean.
- `trailing` goes on a BUY only, and takes `percentage` and `trigger` only: mind the spelling.

### "All-in BUY … sized from 0 USDT: 0 BTC sent …"

Followed by `Order 'amount' with value 0 is invalid`, the exchange refusing the order. The end of the warning says why nothing was left to spend:

- `(1000 USDT free at the last synchronization, less 1000 USDT for the BUYs placed since, …)`: your strategy sent an all-in BUY after other BUYs (two entry conditions on one candle, two pairs of one currency) before the Trader read the balance again, and the first took all the currency (see [Order Parameters](#order-parameters)). Send one BUY per candle, the second entry as an `else if`, or, for several pairs, give each BUY a share of the currency with `allocation`, as the [PositionBook](#tracking-your-position) does.
- `which the market refuses (0 USDT free at the last synchronization)`: the account holds none of the currency. In a backtest or paper trading, `simulationBalance` gives it none.
- `which the market refuses (no balance read from the exchange yet)`: every synchronization of the Trader failed so far.

An all-in SELL sized from nothing says so the same way, `All-in SELL … sized from 0 BTC: 0 BTC sent, which the market refuses (…)`: your strategy sold all-in while holding nothing free (a position already sold, by hand or by a trailing stop), or a SELL sent just before took it all.

A BUY your strategy gave a `cost` or an `allocation` is warned of the same way when nothing is left for it to spend, with the same causes, its line naming the cost or the share it asked for: `[<id>] BUY MARKET order of 100 USDT: 0 BTC sent, which the market refuses (0 USDT free at the last synchronization)`. So is a SELL given an `allocation` of an asset the Trader read none of: `[<id>] SELL MARKET order of 0 BTC (50 % of 0 BTC): 0 BTC sent, which the market refuses (0 BTC free at the last synchronization)`.

### "… below the minimum cost of … on …" or "… below the minimum amount of … of a … order on …"

An order your strategy gave a `cost` or an `allocation`, or sent all-in to BUY, came out too small for the market: its amount, truncated to the amount step of the market as the exchange takes it, is below the minimum amount of the market (`amount.min` in `tools.marketData`, that of a market order for a `MARKET` one), or costs less at its price than its minimum cost (`cost.min`); the line names that amount and the step when the step cut it (`truncated to 0.00008 BTC on the amount step 0.00001 of the market`). The Trader sends it all the same, and the exchange refuses it (`Order 'amount' with value …` or `Order 'cost' with value …`, the figure the warning quotes): an `onOrderErrored` that counts towards `maxConsecutiveErrors`. The cost is valued at the price the line names, and a live exchange checks a market order at its ticker, which can put an order a hair from the minimum on its other side. Give a larger `cost` or `allocation`, or fund the account for an all-in BUY, minding the 5 % a BUY keeps back for the fee (a `cost` of 10 USDT places 9.5 USDT worth) and the step, which can take up to a step's worth off (0.6 USDT on BTC/USDT at 60000: a `cost` of 5.5 USDT places 4.8 USDT worth), or check the balance the share is taken from: a BUY capped at what the BUYs before it left comes out smaller (see [Order Parameters](#order-parameters)).

### "[…] BUY skipped: … is below the minimum cost of … of the market" or "… below the minimum amount …"

The [PositionBook](#tracking-your-position) of a strategy that trades several pairs sent no BUY: the share of the currency the pair takes (of the currency free, plus, while a BUY of another pair rests across a synchronization, what that BUY holds as the Trader sizes it), all of the free currency for the last pair not invested, less the 5 % kept back for the fee, costs less than the minimum cost of the market, or the amount it buys at the close (at the BUY's own price when it gives one), truncated to the amount step of the market, is below the minimum amount of the market or costs less than its minimum cost, and the market would refuse it (see [Pairs and Capital](./built-in-strategies.md#pairs-and-capital)). When the portfolio holds enough of the pair's asset free to sell, the book says so at `info` instead (`…, but 0.002 BTC is free in the portfolio, enough to sell: the strategy is long`) and the strategy sells that holding at its next SELL signal. Nothing was sent, so nothing counts towards `maxConsecutiveErrors`, and the next skips of the pair are logged at the `debug` level until a BUY of it is placed. Watch fewer pairs, for a larger share each, or fund the account.

### "Impossible to add the … indicator on …", "… indicator not found." or "Indicator …: …"

- `symbol must be one of the watched pairs (…)`: as for an order, above.
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

| Line                                                                       | Level | Meaning                                                                                                                                             |
|----------------------------------------------------------------------------|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| `Trailing stop of BUY <id> held back: …`                                   | info  | A price reached its stop price while a SELL of yours is pending on the pair: the stop sends no SELL until that one ends                             |
| `Trailing stop of BUY <id> resumes: …`                                     | info  | Your SELL was canceled or errored, and no other is pending on the pair: the stop may trigger again                                                  |
| `Trailing stop of BUY <id> canceled: the strategy sold on <pair> …`        | info  | Your SELL completed: it closed the position the stop protected                                                                                      |
| `Trailing stop of BUY <id> active again: its SELL <id> …`                  | warn  | The stop's SELL completed, errored or was canceled for less than the stop's amount: it sells what is left once a price reaches its stop price again |
| `Trailing stop of BUY <id> over: …`                                        | info  | The stop's SELL left too little to sell at the minimums of the market, or completed with too little of the asset free: nothing is left to protect   |
| `Trailing stop of BUY <id> over: its SELL <id> sold 0.5, all of its 0.5`   | info  | Under the `trailing stop` tag: the stop's SELL errored or was canceled after a reported fill of all of its amount: nothing is left to protect       |
| `Trailing stop of BUY <id> kept: its SELL <id> …`                          | warn  | The stop's SELL errored and may still have gone through on the exchange: the stop stays armed. Check that SELL there                                |
| `Trailing stop of BUY <id> removed: …`                                     | warn  | The stop's SELL errored or was canceled, and the portfolio shows too little of the asset free to sell: nothing is left to protect                   |
| `BUY <id> errored after it filled …`                                       | warn  | The BUY errored after a reported fill: its stop is armed for that part. When the BUY may still be live, the rest of it may fill without a stop      |
| `Trailing stop of BUY <id> not armed: …`                                   | warn  | The BUY errored with no fill reported: nothing filled when the exchange refused it; when it may still be live, what it bought has no stop           |
| `Strategy ended with N active trailing stops that never triggered.`        | warn  | At the end of the run: stops still armed                                                                                                            |
| `Strategy ended with N triggered trailing stops whose SELL had not ended.` | warn  | At the end of the run: stops whose SELL had no outcome yet                                                                                          |

### "Unknown log level … in tools.log"

Your strategy called `tools.log` with a level other than `debug`, `info`, `warn` or `error` (such as `'warning'`, which only an untyped strategy can pass): its lines are logged and relayed at `info`, after this one warning per level.

### Indicators returning null

- Ensure adequate warmup period: `warmup.candleCount` must be at least the indicator's first complete candle minus one (see [Indicators at a Glance](./indicators.md#-indicators-at-a-glance))
- Validate indicator values before using them

### Strategy not receiving candles

- Check that `mode` is set correctly (`backtest`, `realtime`, etc.)
- Verify exchange configuration is correct
