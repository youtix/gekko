# Custom Strategies

This guide explains how to create your own custom trading strategies and run them with Gekko 2. Custom strategies live **outside** the Gekko 2 codebase, enabling you to develop and iterate on your trading logic independently; a private strategy can also live inside your checkout, in `src/strategies/custom/` (see [Where Your Strategy Lives](#where-your-strategy-lives)).

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

- **Develop independently** — Keep your proprietary trading logic separate from the Gekko 2 core
- **Iterate quickly** — Modify and test strategies without rebuilding Gekko 2
- **Use any indicators** — Access all 31 built-in technical indicators
- **Handle order events** — React to order completions, cancellations, and errors
- **Protect a position** — Attach a trailing stop to a BUY: Gekko trails it and sells for you when it is hit

---

## Quick Start

### 1. Create Your Strategy File

Create a new TypeScript file anywhere on your system (e.g., `./strategies/myStrategy.strategy.ts`):

```typescript
import {
  IndicatorResults,
  InitParams,
  OnCandleEventParams,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Strategy,
} from '@strategies/strategy.types';

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

The file imports nothing from Gekko 2 but types, which Bun drops as it loads the file: this is what lets it live anywhere (see [Where Your Strategy Lives](#where-your-strategy-lives)).

### 2. Create Your Configuration File

Create a YAML configuration file (e.g., `config.yaml`):

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
    end: 2024-12-31T23:59:00Z

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
    strategyPath: ./strategies/myStrategy.strategy.ts

  - name: Trader

  - name: RoundTripAnalyzer
    enableConsoleTable: true
```

A `daterange` bound is a day, read as its midnight UTC (`2024-01-01`), or a day and a time with `Z` or an offset (`2024-12-31T23:59:00Z`, `2024-01-01T02:00:00+02:00`), quoted or not. Both bounds are included, so the range above ends with the last minute of 2024: `end: 2024-12-31` would read only the first minute of December 31st. A day that does not exist (`2023-02-29`), or a time without `Z` or an offset, is refused at start-up.

The simulator receives each order as the live exchange does: its amount truncated to the amount step (`precision.amount`), its price rounded half up to the price tick (`precision.price`). An amount truncated to 0, or whose cost falls under `cost.min`, is refused, and an order fills for the amount truncated. The cost is worked out in decimal, as the exchange works it out: an order costing exactly `cost.min` passes. For Hyperliquid, whose tick depends on the price, add `priceSignificantDigits: 5` under `precision`.

### 3. Run Your Strategy

```bash
# Using the compiled executable (bun run build:exec builds it, see Running with Executable)
GEKKO_CONFIG_FILE_PATH=./config.yaml ./dist/gekko2
```

---

## Where Your Strategy Lives

A strategy lives in one of two places, which decide how Gekko finds it and what it can import:

|                      | Outside the codebase (this guide)                                     | In your checkout, in `src/strategies/custom/`                                                                 |
|----------------------|-----------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| Selected by          | `strategyName` and `strategyPath`, the path of its file               | `strategyName` alone, once your class is exported from `src/strategies/custom/index.ts`                       |
| Loaded               | From its file, each time Gekko starts: no build needed after a change | Compiled into `dist/gekko2` by `bun run build:exec`, like the built-in strategies                             |
| Imports from Gekko 2 | Types only                                                            | Anything: types, the [PositionTracker](#tracking-your-position), the utilities                                |
| Packages (`zod`, …)  | Installed next to its file (see below)                                | Those of the checkout                                                                                         |
| Type-checked         | No: Bun loads TypeScript without checking it                          | By `bun run type:check`; its tests run with `bun run test`, never in CI                                       |
| Git                  | Yours                                                                 | Gitignored, but for a placeholder `index.ts` that `bun install` marks unchanged: your exports stay out of git |

A file loaded through `strategyPath` can import Gekko 2's types (`@strategies/strategy.types`, `@models/…`), because Bun drops an import that is only used as a type, but nothing else of Gekko 2: the compiled executable resolves none of the `@strategies/…` or `@utils/…` paths of a file it loads as it starts, and Gekko run from source (`bun run dev`) resolves them only for a file inside the checkout. Such an import stops Gekko at start-up with `Cannot find module '@strategies/positionTracker' from '…/myStrategy.strategy.ts'`. So model an external strategy on the [Complete Example](#complete-example), not on a built-in strategy: those import Gekko 2 modules, and a copy of `dema.strategy.ts` placed outside the codebase stops with that very line.

A package your strategy imports is looked up from the folder of its file: install it there (`bun add zod` in that folder), unless the file sits inside a Gekko 2 checkout, whose `node_modules` has it. The compiled executable, though, only finds a package by the `index.js` at its root, whatever its `package.json` names as its entry: `zod` has one, but `lodash-es`, which Gekko 2 itself uses, has none, and is not found even installed next to the strategy (`Cannot find package 'lodash-es' from '…'`). Import such a package by its files (`import isNil from 'lodash-es/isNil.js'`), or run Gekko from source (`bun run dev`), which follows the `package.json`.

To build on a built-in strategy, or to use the PositionTracker, keep your strategy in `src/strategies/custom/` and export it from the placeholder, which holds `export {};` until then:

```typescript
// src/strategies/custom/index.ts
export * from './myStrategy.strategy';
```

```yaml
plugins:
  - name: TradingAdvisor
    strategyName: MyStrategy # No strategyPath: Gekko looks the name up among its own strategies, those of src/strategies/custom/ included
```

---

## Strategy Interface

Every custom strategy must implement the `Strategy<T>` interface, where `T` is your parameters type:

```typescript
// Every hook is optional. candle is a Map holding the candle of every watched pair, and each indicator arrives as an
// IndicatorResults, { results: unknown; symbol: TradingPair }, in the order of the addIndicator calls.
// Tools is the type of the tools object (see Tools Available), TrailingStopState comes from
// '@strategies/trailingStopManager.types', UUID from 'node:crypto'.
interface Strategy<T> {
  init?(params: InitParams<T>): void;
  onEachTimeframeCandle?(params: OnCandleEventParams<T>, ...indicators: IndicatorResults[]): void;
  onTimeframeCandleAfterWarmup?(params: OnCandleEventParams<T>, ...indicators: IndicatorResults[]): void;
  log?(params: OnCandleEventParams<T>, ...indicators: IndicatorResults[]): void;
  onOrderCompleted?(params: OnOrderCompletedEventParams<T>, ...indicators: IndicatorResults[]): void;
  onOrderCanceled?(params: OnOrderCanceledEventParams<T>, ...indicators: IndicatorResults[]): void;
  onOrderErrored?(params: OnOrderErroredEventParams<T>, ...indicators: IndicatorResults[]): void;
  // A trailing stop became active: the price reached its trigger, or, for a stop without one, its BUY completed (see Trailing Stops)
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

The snippets of this section are methods of one class, which follows two EMAs of the first watched pair and tracks its position (see [Tracking Your Position](#tracking-your-position)): the `init` snippet shows the class with its fields.

### `init` — Strategy Initialization

Called **once**, at start-up, on the first one-minute candle, before any timeframe candle: in realtime the first minute of the warmup history (with no history to replay, the first live minute, once it closes), in a backtest the first minute of `watch.daterange`. Its `candle` holds that minute's candle of every watched pair, in the order of `watch.assets`: take your pairs from its keys, not a price (a price to trade from comes with the first candle after the warmup). In a backtest, these one-minute candles also carry an `id`, their row in the candle database; a candle read live from the exchange, one Gekko made up for a missing minute, and every timeframe candle have none: do not rely on it.

Register your indicators here: `addIndicator(name, symbol, params)` is only available in `init`. Kept and called later, it throws `[STRATEGY] Impossible to add the SMA indicator on BTC/USDT: addIndicator is available in init only`, which stops Gekko. These stop Gekko at start-up, with an error naming the problem:

- an indicator name that does not exist (`[STRATEGY] SMAA indicator not found.`), or parameters the indicator refuses;
- a `symbol` that is not a watched pair, a key of `candle` and of `tools.marketData` (`[STRATEGY] Impossible to add the SMA indicator on ETH/USDT: symbol must be one of the watched pairs (BTC/USDT), got 'ETH/USDT'`): an indicator on another pair would never get a candle;
- any error your `init` throws, `tools.log('error', …)` included.

No orders here: the warmup is not over (see [Creating Orders](#creating-orders)).

```typescript
type MyParams = { short: number; long: number }; // From the strategy: block of the configuration, e.g. short: 12 and long: 26

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

Its `portfolio` is the latest the Trader relayed: the balance at start-up, then the one a portfolio change or the end of one of your orders carries, from the candle after its order hook ran. It does not show what a pending order reserves until that order ends.

```typescript
onTimeframeCandleAfterWarmup({ tools }: OnCandleEventParams<MyParams>, ...indicators: IndicatorResults[]): void {
  const { createOrder, log } = tools;
  const [shortEma, longEma] = indicators;
  // results is unknown, and null until the indicator has seen enough candles
  if (!this.pair || typeof shortEma.results !== 'number' || typeof longEma.results !== 'number') return;

  // Flat and nothing pending: the strategy only becomes long once the BUY has completed (see onOrderCompleted)
  if (shortEma.results > longEma.results && !this.isLong && !this.pendingOrderId) {
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

Called when an order of yours is filled by the exchange: `order.amount` is the amount it filled (on a market with an amount step, the amount asked for truncated to that step, in backtest and paper trading as live: an all-in BUY of 0.0310282298100942 BTC fills for 0.03102 on Binance's BTC/USDT), `order.price` the price it executed at (the mean of its trades' prices weighted by their amounts, worked out in decimal: a price all its trades share is that price, a mean that does not end is given to 15 significant digits), `order.effectivePrice` that price with the fee in (above it for a BUY, below it for a SELL), `order.fee` the fee in the currency, `exchange.price` the price of the pair the Trader read once the order ended (in realtime the event arrives with the next minute, and the market may have moved since), and `exchange.portfolio` the portfolio after the fill. When the exchange gives no usable trades, the summary is estimated and an error line says from what: a LIMIT or STICKY order from the prices the exchange reported for its own fills, otherwise its limit price or the last market price.

```typescript
onOrderCompleted({ order, tools }: OnOrderCompletedEventParams<MyParams>): void {
  tools.log('info', `Order ${order.id} completed: ${order.side} ${order.amount} @ ${order.price}`);
  if (order.id !== this.pendingOrderId) return;
  this.pendingOrderId = undefined;
  this.isLong = order.side === 'BUY';
}
```

---

### `onOrderCanceled` — Order Canceled

Called when an order of yours is canceled: by your strategy (`tools.cancelOrder`), or by the exchange (expired, canceled from its interface). It may have filled part of its amount before: `order.filled` is the largest fill any answer of the exchange reported for it, a poll before the cancelation included, and `order.remaining` what was left of its amount. A number, `0` included, is a fact: `0` filled means that nothing executed. Both are `undefined` when no answer reported a fill: unknown, not 0 filled. `exchange.portfolio`, the portfolio after the cancelation, then tells what you hold (see [Tracking Your Position](#tracking-your-position)).

```typescript
onOrderCanceled({ order, tools }: OnOrderCanceledEventParams<MyParams>): void {
  // undefined when the exchange reported no fill: unknown, not 0
  const fill = order.filled === undefined ? 'no fill reported' : `${order.filled} filled, ${order.remaining} left`;
  tools.log('warn', `Order ${order.id} was canceled (${fill})`);
}
```

---

### `onOrderErrored` — Order Failed

Called when an order of yours fails or is refused by the exchange, `order.reason` saying why. An amount the market's step truncates to 0, or whose cost then falls under `cost.min`, is refused so, in backtest and paper trading as live (`Order 'cost' with value 4.8987648 is out of range. Expected a value between 5 and 9000000.`). An amount or a price the step rounds to nothing is reported as the order asked for it, with the step: 0.0000099 BTC on Binance's BTC/USDT reads `Order 'amount' with value 0.0000099 rounds to 0 on the amount step 0.00001 of the market. Expected a value between 0.00001 and 9000.` It may have executed part of its amount first: `order.filled` is what the exchange reported it filled, 0 when it reported nothing.

`order.mayBeLive` is `true` when the order may still be live on the exchange, where Gekko follows it no more: its creation's answer was lost on the network, the order was created but its state could not be read back, the exchange failed the creation without refusing it (an internal error, such as Binance's "execution status unknown"), or a poll or a cancelation failed for good while it was open. It may then have executed more than `order.filled`, or execute later, and no event will tell: placed again, it may be doubled, so check it on the exchange first. `false` when the exchange refused it, or nothing of it was left open: what it executed is `order.filled`. When the order is the SELL of a trailing stop, the stop is active again either way for what that SELL did not sell, unless nothing it can sell is left for it to protect (see [Trailing Stops](#trailing-stops)).

`maxConsecutiveErrors` order errors in a row (a [TradingAdvisor option](#tradingadvisor-plugin-configuration), 5 by default, `-1` to disable it) stop Gekko with `[STRATEGY] Max consecutive order errors reached (5)` and exit code 0: the circuit breaker. A completed or canceled order resets the count. Your `onOrderErrored` still runs for the error that trips it, before the stop, but an order it creates then is never sent.

```typescript
onOrderErrored({ order, tools }: OnOrderErroredEventParams<MyParams>): void {
  // Not 'error': tools.log('error', …) throws, and stops the bot
  tools.log('warn', `Order ${order.id} failed: ${order.reason}`);
  if (order.mayBeLive) tools.log('warn', `Order ${order.id} may still be live on the exchange: check it there before placing it again`);
  // It may have executed before its error: read the position from the portfolio before sending it again (see Tracking Your Position)
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

Register indicators in `init` with `addIndicator(name, symbol, params)` and receive their values in candle handlers:

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
  // has seen enough candles, then complete on every candle (macd.results is then { macd, signal, hist }, all three set)
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

`STICKY` and `MARKET` orders ignore `price`, which then only sizes an all-in BUY. In a backtest, the simulated exchange fills a `MARKET` order at the close of the minute and a `LIMIT` order in full once a candle reaches its price, with no partial fill and no slippage (see the Trader's [Order Types](./plugins.md#order-types)).

### Order Parameters

```typescript
// tools.createOrder(order: StrategyOrder): UUID returns the order id at once. The outcome arrives later, in
// onOrderCompleted, onOrderCanceled or onOrderErrored, whose order.id is that id.
// These six keys and no other: createOrder refuses any other key, whatever its value.
type StrategyOrder = {
  symbol: TradingPair;                  // A watched pair (a key of tools.marketData), e.g. 'BTC/USDT'
  type: 'STICKY' | 'MARKET' | 'LIMIT';  // In upper case, as written here: ccxt's 'market' is refused
  side: 'BUY' | 'SELL';                 // In upper case, as written here: ccxt's 'buy' is refused
  amount?: number;                      // A number above 0; left out, the order is all-in (see below)
  price?: number;                       // A number above 0; left out, the last price of the pair (see below)
  // Optional, BUY orders only: a trailing stop armed when the BUY completes, which then sells the amount bought with a
  // MARKET order (see Trailing Stops). No key but these two
  trailing?: {
    percentage: number;                 // Distance of the stop below the highest price since activation, above 0 and below 100 (2.5 for 2.5%)
    trigger?: number;                   // Price above 0 that activates it (active at once when omitted)
  };
};
```

- **`amount` left out**: the order is all-in. A BUY spends the free currency less what the BUYs sent before it may spend, sized at `price` with 5 % kept back for the fee, in decimal (600 USDT at 100 buy 5.7 BTC); a SELL sells the free asset less what the SELLs sent before it take, until the Trader reads the balance again.
- **`price` left out**: the last price of the pair, the close of the last one-minute candle or the bid read at the Trader's last synchronization, whichever came last. It is the limit of a `LIMIT` order, and what an all-in BUY is sized at.
- **A SELL is capped to the free balance** of its asset, as the Trader read it at its last synchronization, less what the SELLs it placed since take from it, with a warning (`[<id>] SELL MARKET order of 0.3 BTC above the free balance: 0.2992 BTC sent, all that can be sold (…)`). An all-in SELL is sized from that remainder.
- **An all-in BUY is sized from what the BUYs before it leave** of the free currency as the Trader read it at its last synchronization: each BUY placed since counts for its cost at its price plus the 5 % kept back for its fee, an all-in BUY for all it was sized from. The Trader warns (`[<id>] All-in BUY MARKET order sized from 500 USDT: 4.75 BTC sent (1000 USDT free at the last synchronization, less 500 USDT for the BUYs placed since, the 5 % kept back for their fee included)`). So the second of two all-in BUYs sent on one candle is sized to 0 and refused: an `onOrderErrored` that counts towards `maxConsecutiveErrors`. Send one. A BUY with an `amount` is placed as asked.
- **A SELL, and an all-in BUY, is capped at the most the market takes in one order** of its type: the maximum of its amount range, narrowed for a `MARKET` order by that of a market order (Binance's MARKET_LOT_SIZE, tens of BTC on BTC/USDT), with a warning (`[<id>] SELL MARKET order of 100 BTC above the maximum amount of a MARKET order on BTC/USDT: 86.27382215 BTC sent, the rest stays held`). The SELL of a trailing stop is capped so too. `onOrderCompleted` gets the amount executed, and the rest stays held, or unspent, for a later order. A BUY with an `amount` above the maximum is refused by the exchange.

`createOrder` checks the order before it sends anything. The order takes no key but the six of `StrategyOrder` above: any other, a misspelt `prise` or a `quantity` for instance, is refused whatever its value, as the Trader would ignore it (a LIMIT would go at the last price of the pair, an order all-in). `symbol` must be a watched pair. `side` must be `'BUY'` or `'SELL'` and `type` `'MARKET'`, `'STICKY'` or `'LIMIT'`, in upper case. `amount` and `price` must be numbers above 0, or left out: `0`, a negative number, `NaN`, `Infinity` and a quoted number such as `'0.5'` are refused. `trailing` goes on a BUY only, with no key but `percentage`, above 0 and below 100, and `trigger`, above 0 or left out. Anything else throws a `GekkoError` naming the field and what it accepts, for example `[STRATEGY] Impossible to create the buy MARKET order on BTC/USDT: side must be one of 'BUY', 'SELL', got 'buy'`. The order is not sent and Gekko stops (exit code 1), even for an amount your strategy computed as 0. A TypeScript strategy cannot pass a lower-case side or type, or a quoted number, without a cast; a JavaScript one, which Bun loads without type-checking, can. TypeScript refuses an unknown key in an object literal only, not in a variable or a spread, such as the order of an event: the keys check catches what the compiler lets through.

### Examples

```typescript
// Full position market buy
createOrder({ symbol: 'BTC/USDT', type: 'MARKET', side: 'BUY' });

// Specific amount sticky sell
createOrder({ symbol: 'BTC/USDT', type: 'STICKY', side: 'SELL', amount: 0.5 });

// Limit order at specific price
createOrder({ symbol: 'BTC/USDT', type: 'LIMIT', side: 'BUY', price: 42000, amount: 0.1 });

// Full position market buy, then a stop trailing 2.5% below the highest price once the price reaches 45000.
// Keep the id: tools.cancelTrailingOrder(orderId) drops the stop, as does a SELL of yours on the pair once it completes.
const orderId = createOrder({ symbol: 'BTC/USDT', type: 'MARKET', side: 'BUY', trailing: { percentage: 2.5, trigger: 45000 } });
```

### Trailing Stops

A `trailing` on a BUY asks Gekko to protect what the BUY buys: a stop follows the price up, and sells at the market once the price falls `percentage` below its highest point. Gekko trails it on every one-minute candle, whatever the timeframe, and tells your strategy through two hooks, which get `tools` as their last argument.

- **Armed when the BUY completes**, for the amount it filled, from a copy of `trailing` taken by `createOrder`: changing your object afterwards changes nothing. A BUY canceled loses its stop, even after a partial fill. A BUY that errors after a reported fill (`order.filled`) gets its stop for that part; one that errors with no fill reported loses it. A warning says which, and whether the BUY may still be live on the exchange.
- **Activated**: a stop without `trigger` is active as soon as it is armed, and `onTrailingStopActivated(state, tools)` is called then, right after `onOrderCompleted`, its peak and its stop price still 0. It takes its first peak from the open of the next one-minute candle, not from the price the BUY filled at: the price can fall more than `percentage` below that price before the stop triggers. A stop with a `trigger` waits until the high of a one-minute candle reaches it. Its peak is then that candle's open when the open reached the trigger, else its high, and `onTrailingStopActivated` is called before the rest of that candle is trailed.
- **Trailed**: each one-minute candle is met as open, low, high, close, each price tested against the stop price, `peak × (1 − percentage / 100)`, before it raises the peak. So a candle that rises more than `percentage` from its open does not trigger the stop on its own low. The candle that activates a stop with a trigger is met from its open when the open reached the trigger; otherwise only its close is tested, after its high.
- **Triggered**: a price at or below the stop price makes Gekko create a MARKET SELL of the stop's amount, then call `onTrailingStopTriggered(orderId, state, tools)`, `state` holding the peak and the stop price of that moment. That SELL is an order of your strategy's from then on: its outcome comes through `onOrderCompleted`, `onOrderCanceled` or `onOrderErrored`, under `orderId`. A strategy that tracks its position adopts it as its pending SELL (see [Tracking Your Position](#tracking-your-position)); otherwise it stays long once the stop has sold everything, and its next SELL is refused, nothing being left to sell.
- **Selling**: the stop (`state.status` `'selling'`, `state.sellOrderId` its SELL) sells until that SELL ends. Completed for all of the stop's amount, the stop is over. Completed for less (the Trader caps a SELL to the free balance and to the most the market takes in one order, and the exchange truncates its amount to the market's step), errored or canceled, it is active again for what that SELL did not sell, from the peak and the stop price it triggered at, with a warning (`Trailing stop of BUY <id> active again: its SELL <id> completed after selling 0.3 of its 0.5 BTC …`): the next price at or below that stop price triggers it again, and `onTrailingStopTriggered` announces its new SELL under a new id, to adopt as the first one. The stop is over instead when nothing it can sell is left to protect: when that rest is too little to sell at the minimums of the market, whatever else your account holds (`Trailing stop of BUY <id> over: …, and the rest, 0.0001 BTC, is too little to sell at the minimums of the market`, at info level), or when the portfolio after that SELL shows too little of the asset free to sell, while no SELL of yours is pending on the pair (at info level after a SELL that completed, such as one whose BUY's fee the exchange took from the asset bought; with a warning, `… removed: …`, after one that errored or was canceled). A SELL that errored while it may still be live on the exchange (`order.mayBeLive` in `onOrderErrored`: its answer lost, the exchange busy or overloaded) makes the stop active again all the same for a rest it can sell, with a warning to check that SELL on the exchange (`Trailing stop of BUY <id> kept: its SELL <id> errored, …, and may still have gone through on the exchange, …`). A MARKET SELL rests on no book: it may only have executed. If it did, the portfolio after it shows the asset gone and the stop is removed, or the stop's next SELL is refused for lack of anything to sell and that refusal removes it; unless your account holds other coins of the asset free, which that next SELL sells, up to the stop's amount. If it did not, the stop still protects your position. A SELL refused every time with the asset still free (an API key refused, a cost above the maximum of the market) is sent again on each such minute, each refusal counting towards `maxConsecutiveErrors`.
- **Your own SELLs**: while a SELL your strategy created is pending on a pair, the stops of that pair keep trailing but do not trigger (`[STRATEGY] Trailing stop of BUY <id> held back: …`, once per stop, at info level): the exchange reserves the asset for your SELL, and the stop's SELL would be refused. Completed, your SELL cancels every stop armed on the pair, whatever the amount sold, with an info line: a strategy that scales out loses its stops at its first SELL. Canceled or errored, with no other SELL of yours pending there, it releases them (`… resumes: …`), and the next price at or below a stop price triggers that stop. So a take-profit LIMIT SELL left pending leaves the position without a working stop for as long as it pends, the part it does not reserve included. The SELL a stop sends cancels no other stop, and a stop whose BUY has not completed yet is kept.
- **Canceled by you**: `tools.cancelTrailingOrder(state.id)`, `state.id` being the BUY's id, at any time. From `onTrailingStopActivated`, the stop is gone before the rest of its activation candle is trailed. To take over from a stop that is selling, cancel the stop, not its SELL: a canceled SELL makes the stop active again.

`state` is a `TrailingStopState` (`@strategies/trailingStopManager.types`): `id` (its BUY's), `symbol`, `amount` (what its SELL sells), `config` (the `trailing`), `status` (`'dormant'` until its trigger is reached, `'active'`, `'selling'`), `highestPeak`, `stopPrice`, `activationPrice` (the trigger), `createdAt` and, while it sells, `sellOrderId`.

---

## Tracking Your Position

`createOrder` returns before the exchange has seen the order, and Gekko relays every order you create: a strategy that advises a BUY on every candle of an uptrend sends an all-in BUY on each, each sized from what the ones before left, until they are refused for want of currency and the circuit breaker stops the bot. So a strategy that trades all-in keeps its position and its pending order, and moves them only on the outcome of its orders:

- it buys only when flat and sells only when long, never while an order of its own is pending;
- a completed BUY makes it long, a completed SELL flat, unless it sold less than it asked for (an all-in SELL asks for all of the asset free, and the Trader caps a SELL at the most the market takes in one order): the portfolio after it then tells, long when what is left free is enough to sell;
- an order canceled or errored may have executed before it ended, in part or in full: the position is read from what its event reports, rather than left as it was. The portfolio after the order (`exchange.portfolio`) tells what is left of the asset, a position when it is enough to sell at the minimums of the market (`tools.marketData`);
- the SELL a trailing stop sends is the strategy's own from `onTrailingStopTriggered` on: it adopts that id as a pending SELL;
- it starts flat: a holding present at start-up is sold only by its first SELL, which follows a BUY that completed, or one that ended without completing while the account held the asset.

**The PositionTracker, the recommended way.** The built-in signal strategies keep this bookkeeping in a `PositionTracker` (`src/strategies/positionTracker.ts`), which a strategy of your checkout's `src/strategies/custom/` can use as they do:

```typescript
import { pickTradedPair, PositionTracker } from '@strategies/positionTracker';

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
    // canBuy: flat and nothing pending; canSell: long and nothing pending. buy and sell keep the order pending until its outcome
    if (shortEma.results > longEma.results && this.position.canBuy())
      this.position.buy(tools.createOrder, { type: 'STICKY', symbol: this.pair, trailing: { percentage: 5 } });
    else if (shortEma.results < longEma.results && this.position.canSell())
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

For an order canceled or errored, the tracker reads the fill a cancelation reports, else the free balance of the asset in the portfolio after the order, truncated to the lot step of the market and checked against its minimum amount and cost, the cost worked out in decimal, as the exchange checks a SELL; a position it reads that way and that differs from the one it held is logged at info level, through `tools.log`. It reads a completed SELL from that free balance too when the SELL sold less than it asked for, as it reads every all-in SELL and every adopted one, which ask for all of the asset free or for an amount it does not know: long when enough is left to sell, logged then. So an account that holds the asset but too little currency to buy has its first all-in BUY refused; the tracker then takes the asset's free balance, in the portfolio after that refusal, as the position, and the strategy sells it at its next SELL signal. The tests of such a strategy can drive it as the built-in suites do, with the `OrderRecorder`, `relayOrderOutcome` and `playSteps` helpers of `src/strategies/positionTracker.mock.ts`.

A strategy loaded through `strategyPath` cannot import the PositionTracker (see [Where Your Strategy Lives](#where-your-strategy-lives)): the [Complete Example](#complete-example) keeps the same bookkeeping by hand.

---

## Configuration File

### TradingAdvisor Plugin Configuration

The key configuration for custom strategies is in the `TradingAdvisor` plugin, here for the [Complete Example](#complete-example) below:

```yaml
plugins:
  - name: TradingAdvisor
    strategyName: EMACrossover    # Must match your exported class name
    strategyPath: ./strategies/emaCrossover.strategy.ts  # Path to your strategy file
    maxConsecutiveErrors: 5       # Optional: order errors in a row that stop Gekko (at least 1, or -1: never)

  - name: Trader                  # Executes the orders the strategy creates
```

| Parameter              | Type    | Required                            | Description                                                                                                                                                                                                                            |
|------------------------|---------|-------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `strategyName`         | string  | Yes                                 | The exact name of your exported class                                                                                                                                                                                                  |
| `strategyPath`         | string  | For a strategy outside the codebase | Path to your strategy file, absolute, or relative to the directory Gekko is started from (not to the configuration file). Left out, Gekko looks `strategyName` up among its own strategies, those of `src/strategies/custom/` included |
| `maxConsecutiveErrors` | integer | No (`5`)                            | Order errors in a row after which Gekko stops, with exit code 0: the circuit breaker. At least `1`, or `-1` to never stop; `0` is refused                                                                                              |

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
import { Strategy } from '@strategies/strategy.types';
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

Your strategy imports `zod` itself, and like any package it is looked up from the strategy file's folder: unless the file sits inside a Gekko 2 checkout, whose `node_modules` has it, install it next to the strategy (`bun add zod` or `npm install zod` in its folder). Otherwise Gekko stops with `Cannot find package 'zod' from '…/emaCrossover.strategy.ts'`. The same goes for any other package (see [Where Your Strategy Lives](#where-your-strategy-lives) for the packages the compiled executable cannot find).

---

## Running with Executable

### Build the Executable

```bash
bun run build:exec
```

This creates a standalone binary at `dist/gekko2` that can run **without Bun installed**. A strategy loaded through `strategyPath` is not compiled into it: the binary loads its file each time it starts, so a change to the strategy needs no new build (one in `src/strategies/custom/` does).

### Run Your Strategy

```bash
# From the directory a relative strategyPath (and storage.database) is resolved against
GEKKO_CONFIG_FILE_PATH=./config.yml ./dist/gekko2

# From any directory, when strategyPath and storage.database are absolute (recommended for deployment)
GEKKO_CONFIG_FILE_PATH=/path/to/config.yml /path/to/gekko2/dist/gekko2
```

> [!TIP]
> When deploying, use absolute paths for `strategyPath` to avoid working directory issues:
> ```yaml
> strategyPath: /home/user/strategies/myStrategy.strategy.ts
> ```

---

## Complete Example

Here's a complete EMA crossover strategy, which validates its parameters, tracks its position through the outcome of its orders, and can protect each position with a trailing stop:

### Strategy File: `./strategies/emaCrossover.strategy.ts`

```typescript
import { OrderSide } from '@models/order.types';
import { TradingPair } from '@models/utility.types';
import {
  IndicatorResults,
  InitParams,
  OnCandleEventParams,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Strategy,
  Tools,
} from '@strategies/strategy.types';
import { TrailingStopState } from '@strategies/trailingStopManager.types';
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

export class EMACrossover implements Strategy<EMACrossoverParams> {
  static schema = emaCrossoverSchema;

  private pair?: TradingPair;
  // createOrder only returns the order's id: its outcome arrives later, through the order hooks, so the position is only known
  // then. Until then the order is pending, and no other one is sent.
  private isLong = false;
  private readonly pendingOrders = new Map<UUID, OrderSide>();

  init({ candle, addIndicator, tools }: InitParams<EMACrossoverParams>): void {
    const { src, shortPeriod, longPeriod } = tools.strategyParams;
    // candle holds one candle per watched pair, in the order of watch.assets: this strategy trades the first one
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

    // Golden cross: short EMA above long EMA, and nothing is held
    if (shortEma.results > longEma.results && !this.isLong) {
      log('info', `Golden cross at ${current.close} — BUY signal`);
      const { trailingPercentage } = strategyParams;
      const trailing = trailingPercentage ? { percentage: trailingPercentage } : undefined;
      this.pendingOrders.set(createOrder({ type: 'STICKY', side: 'BUY', symbol: this.pair, trailing }), 'BUY');
    }
    // Death cross: short EMA below long EMA, and the BUY has completed
    else if (shortEma.results < longEma.results && this.isLong) {
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

`createOrder` returns before the exchange has seen the order: `onOrderCompleted`, `onOrderCanceled` or `onOrderErrored` tells later what became of it, with the id `createOrder` returned. This is why the example keeps that id, and only moves `isLong` once the order has ended: a completed BUY makes it long; a completed SELL, which may have sold less than the position, and a canceled or errored order, which may have executed first, are read from the portfolio after them. The SELL a trailing stop sends is adopted in `onTrailingStopTriggered`, so that its outcome settles the position too. The file imports Gekko 2's types only, and `zod`, which has to be installed next to it (see [Validating Your Parameters](#validating-your-parameters)).

### Configuration File: `ema-crossover-config.yaml`

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
    end: 2024-12-31T23:59:00Z # Both bounds included: a day alone, 2024-12-31, would be its first minute only

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
    strategyPath: ./strategies/emaCrossover.strategy.ts

  - name: Trader

  - name: RoundTripAnalyzer
    enableConsoleTable: true
```

The simulator receives each order as the live exchange does: its amount truncated to the amount step (`precision.amount`), its price rounded half up to the price tick (`precision.price`). An amount truncated to 0, or whose cost falls under `cost.min`, is refused, and an order fills for the amount truncated. The cost is worked out in decimal, as the exchange works it out: an order costing exactly `cost.min` passes. For Hyperliquid, whose tick depends on the price, add `priceSignificantDigits: 5` under `precision`.

### Run the Backtest

```bash
# Build executable (only needed once)
bun run build:exec

# Run backtest
GEKKO_CONFIG_FILE_PATH=ema-crossover-config.yaml ./dist/gekko2
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

An indicator's `results` is typed `unknown` and stays `null` until the indicator has seen enough candles, after warmup too if the warmup is shorter than the indicator needs. From then on it is complete on every candle, a number or an object whose fields are all set, so one check is enough, whatever its shape (see [Reading Results](./indicators.md#reading-results)):

```typescript
const [ema] = indicators;
if (typeof ema.results !== 'number' || !Number.isFinite(ema.results)) return;
```

Compare a price with an average, or two averages, with a relative tolerance rather than strictly: values equal in exact arithmetic come out a few ulps apart on a flat market, and a strict comparison then trades on noise. A strategy under `src/strategies/custom/` can use `compareWithTolerance` from `@utils/math/math.utils`; a file loaded through `strategyPath` cannot import it and carries its own.

### 3. Track the Order, Not the Signal

Decide from your position and your pending order, which only the order hooks move (see [Tracking Your Position](#tracking-your-position)), not from the last signal you acted on: a strategy that only remembers the trend it ordered on does not know whether that order went through, never sends again a BUY that was refused, and cannot tell when it holds something to sell. Act on the position instead:

```typescript
onTimeframeCandleAfterWarmup({ tools }: OnCandleEventParams<MyParams>, ...indicators: IndicatorResults[]): void {
  const [shortEma, longEma] = indicators;
  if (typeof shortEma.results !== 'number' || typeof longEma.results !== 'number') return;
  const isUptrend = shortEma.results > longEma.results;

  // The order hooks set isLong and clear pendingOrderId: a BUY refused is sent again on the next candle of the uptrend
  if (this.pendingOrderId) return;
  if (isUptrend && !this.isLong) this.pendingOrderId = tools.createOrder({ type: 'STICKY', side: 'BUY', symbol: shortEma.symbol });
  else if (!isUptrend && this.isLong) this.pendingOrderId = tools.createOrder({ type: 'STICKY', side: 'SELL', symbol: shortEma.symbol });
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

```yaml
watch:
  warmup:
    candleCount: 40  # DEMA(21) is complete from candle 41: 40 or more gives it a value on the first candle after the warmup
```

In a backtest the warmup takes the first `candleCount` candles of `watch.daterange`, counted from its first timeframe boundary, and Gekko refuses a range that does not hold more whole timeframe candles than that. In realtime, Gekko fetches the warmup candles from the exchange as it starts.

> [!WARNING]
> A warmup shorter than your indicators need only delays their first value: the first candles after it have none, and a strategy that checks its indicators, as it must, trades later than you expect.

---

## Troubleshooting

### "Cannot find module" or "Cannot find external … strategy"

Gekko loads the strategy as it starts: it imports the file at `strategyPath` (a relative path is resolved against the directory Gekko is started from, not against the config file), then takes the export named `strategyName` from it. A failure stops Gekko with exit code 1, and the log says which step failed:

- `Cannot find module '/home/user/strategies/myStrategy.strategy.ts' from '…'`: there is no file at that path (`strategyPath` once resolved).
  - Verify `strategyPath` points to the correct file
  - For a relative `strategyPath`, check the directory Gekko is started from, or use an absolute path
- `Cannot find module '@strategies/positionTracker' from '…/myStrategy.strategy.ts'`: the file imports a Gekko 2 module, which a file loaded through `strategyPath` cannot: import only types from Gekko 2, or move the strategy to `src/strategies/custom/` (see [Where Your Strategy Lives](#where-your-strategy-lives)).
- `Cannot find package 'zod' from '…/myStrategy.strategy.ts'`: install the package next to the strategy. The compiled executable never finds a package without an `index.js` at its root, such as `lodash-es` (see [Where Your Strategy Lives](#where-your-strategy-lives)).
- `[TRADING ADVISOR] Cannot find external MyStrategy strategy in /home/user/strategies/myStrategy.strategy.ts`: the file was loaded, but exports nothing under the name `strategyName`.
  - Ensure `strategyName` matches your exported class name exactly (case-sensitive)
  - Check that your class is exported with `export class` (an `export default` class is not found)
- `[TRADING ADVISOR] Cannot find internal MyStrategy strategy`: `strategyPath` is missing, so Gekko looked for a built-in strategy of that name (or one exported from `src/strategies/custom/index.ts`).
- A parse error that names no file, such as `BuildMessage: Expected ")" but found end of file`: the strategy file has a syntax error.

### "Invalid parameters for strategy … (strategy block)"

Your class's `schema` refused the `strategy:` block, before the first candle: each `✖` line is a problem, and the `→ at` line under it names its parameter (see [Validating Your Parameters](#validating-your-parameters)).

### "Orders are not available until the warmup is over"

Your strategy called `createOrder` before the warmup was over: from `init`, or from `onEachTimeframeCandle` on a warmup candle or on the candle that completes the warmup, which it runs on before the warmup ends. Create orders from `onTimeframeCandleAfterWarmup`, `log` or an order hook.

### "Impossible to create the … order on …"

`createOrder` refused the order, and sent nothing: the end of the line names the field and what it accepts (see [Order Parameters](#order-parameters)).

- `order keys must be one of 'symbol', 'side', 'type', 'amount', 'price', 'trailing', got '…'`: the order holds a key `StrategyOrder` does not declare, misspelt (`prise`, `limitPrice`, `amout`, `trailingStop`) or of your own (`quantity`, `comment`). Mind the spelling, and build the order from its fields rather than passing an event's order or a parameter object as it is.
- `symbol must be one of the watched pairs (…)`: Gekko only has candles, prices and balances of the assets of `watch.assets` against `watch.currency`. Take the pair from `candle.keys()`, or add its asset to `watch.assets`; mind the case (`BTC/USDT`, not `btc/usdt`) and the slash (not the exchange's id `BTCUSDT`).
- `side` and `type` must be spelt in upper case, as typed.
- `amount` and `price` must be numbers above 0, or left out: check a computed amount, which may be 0 or `NaN` when a balance or a price is.
- `trailing` goes on a BUY only, and takes `percentage` and `trigger` only: mind the spelling.

### "All-in BUY … sized from 0 USDT: 0 BTC sent …"

Followed by `Order 'amount' with value 0 is invalid`, the exchange refusing the order. The end of the warning says why nothing was left to spend:

- `(1000 USDT free at the last synchronization, less 1000 USDT for the BUYs placed since, …)`: your strategy sent an all-in BUY after other BUYs (two entry conditions on one candle, two pairs of one currency) before the Trader read the balance again, and the first took all the currency (see [Order Parameters](#order-parameters)). Send one BUY per candle, the second entry as an `else if`.
- `which the market refuses (0 USDT free at the last synchronization)`: the account holds none of the currency. In a backtest or paper trading, `simulationBalance` gives it none.
- `which the market refuses (no balance read from the exchange yet)`: every synchronization of the Trader failed so far.

An all-in SELL sized from nothing says so the same way, `All-in SELL … sized from 0 BTC: 0 BTC sent, which the market refuses (…)`: your strategy sold all-in while holding nothing free (a position already sold, by hand or by a trailing stop), or a SELL sent just before took it all.

### "Impossible to add the … indicator on …" or "… indicator not found."

- `symbol must be one of the watched pairs (…)`: as for an order, above.
- `addIndicator is available in init only`: register every indicator in `init`. One added later would only be fed from then on, and would add an argument to every hook.
- `SMAA indicator not found.`: the name is not one of the [indicators](./indicators.md); it is case-sensitive.

### "watch.daterange must hold more whole … candles than warmup.candleCount"

A backtest spends its first `warmup.candleCount` timeframe candles on the warmup and trades from the next one, counted from the first timeframe boundary of `watch.daterange` (in UTC: a `1w` candle starts on a Monday, a `1M` candle on the 1st). Lengthen the range or shorten the warmup. A run stopped before its warmup was over ends with `Strategy ended before its warmup was over, so it never traded: …`.

### "Max consecutive order errors reached (5)"

The circuit breaker: `maxConsecutiveErrors` order errors in a row stopped Gekko, with exit code 0. The log holds the reason of each error. A strategy that sends the same refused order on every candle trips it within a few candles: see [Tracking Your Position](#tracking-your-position).

### Trailing stop lines

Gekko logs what happens to your stops, under the `strategy` tag:

| Line                                                                       | Level | Meaning                                                                                                                                             |
|----------------------------------------------------------------------------|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| `Trailing stop of BUY <id> held back: …`                                   | info  | A price reached its stop price while a SELL of yours is pending on the pair: the stop sends no SELL until that one ends                             |
| `Trailing stop of BUY <id> resumes: …`                                     | info  | Your SELL was canceled or errored, and no other is pending on the pair: the stop may trigger again                                                  |
| `Trailing stop of BUY <id> canceled: the strategy sold on <pair> …`        | info  | Your SELL completed: it closed the position the stop protected                                                                                      |
| `Trailing stop of BUY <id> active again: its SELL <id> …`                  | warn  | The stop's SELL completed for less than the stop's amount, errored or was canceled: it sells what is left once a price reaches its stop price again |
| `Trailing stop of BUY <id> over: …`                                        | info  | The stop's SELL left too little to sell at the minimums of the market, or completed with too little of the asset free: nothing is left to protect   |
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
