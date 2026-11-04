# Built-in Strategies

Gekko comes with a variety of pre-built trading strategies that you can use right out of the box. Each strategy is designed with different market conditions and trading styles in mind.

You pick a strategy with the TradingAdvisor's `strategyName` and give its parameters directly under the top-level `strategy:` block, whose `name` must equal `strategyName` (see the [TradingAdvisor](./plugins.md#-tradingadvisor)). The seven signal strategies wait for each of their orders to end before they advise again on its pair, and GridBot re-arms a level only once that level's order has ended: run them with a [Trader](./plugins.md#-trader), for alerts only too. On `paper-binance` (realtime) and `dummy-cex` (backtest), the Trader only simulates the orders.

---

## Table of Contents

- [Strategy Overview](#strategy-overview)
- [Common Rules](#common-rules)
  - [Parameters Are Checked at Start-up](#parameters-are-checked-at-start-up)
  - [Pairs and Capital](#pairs-and-capital)
  - [Position and Orders](#position-and-orders)
  - [Warmup](#warmup)
- [Trend Following Strategies](#trend-following-strategies)
  - [TMA — Triple Moving Average](#tma--triple-moving-average)
  - [SMACrossover — Simple Moving Average Crossover](#smacrossover--simple-moving-average-crossover)
  - [EMARibbon — Exponential Moving Average Ribbon](#emaribbon--exponential-moving-average-ribbon)
- [Momentum & Mean Reversion Strategies](#momentum--mean-reversion-strategies)
  - [DEMA — Double Exponential Moving Average](#dema--double-exponential-moving-average)
  - [MACD — Moving Average Convergence Divergence](#macd--moving-average-convergence-divergence)
  - [RSI — Relative Strength Index](#rsi--relative-strength-index)
  - [CCI — Commodity Channel Index](#cci--commodity-channel-index)
- [Range Trading Strategies](#range-trading-strategies)
  - [GridBot — Grid Trading Strategy](#gridbot--grid-trading-strategy)
    - [How It Works](#how-it-works-7)
    - [Parameters](#parameters-7)
    - [Example Configuration](#example-configuration-7)
    - [When to Use](#when-to-use-7)
    - [Spacing Types Explained](#spacing-types-explained)
    - [When the Grid Starts](#when-the-grid-starts)
    - [Prices and Checks](#prices-and-checks)
    - [Markets Whose Tick Depends on the Price](#markets-whose-tick-depends-on-the-price)
    - [Rebalancing](#rebalancing)
    - [Grid Building](#grid-building)
    - [Order Management](#order-management)
    - [Range Monitoring](#range-monitoring)
    - [Grid Reset](#grid-reset)
    - [Restarting](#restarting)
    - [GridBot Messages](#gridbot-messages)
- [Strategy Selection Guide](#strategy-selection-guide)
- [Debug Strategies](#debug-strategies)

---

## Strategy Overview

| Strategy                                                       | Category          | Order Type | Best For            |
|----------------------------------------------------------------|-------------------|------------|---------------------|
| [DEMA](#dema--double-exponential-moving-average)               | Mean Reversion    | STICKY     | Trend reversals     |
| [MACD](#macd--moving-average-convergence-divergence)           | Momentum          | STICKY     | Trend reversals     |
| [RSI](#rsi--relative-strength-index)                           | Mean Reversion    | STICKY     | Overbought/Oversold |
| [CCI](#cci--commodity-channel-index)                           | Mean Reversion    | STICKY     | Cyclical markets    |
| [TMA](#tma--triple-moving-average)                             | Trend Following   | STICKY     | Strong trends       |
| [SMACrossover](#smacrossover--simple-moving-average-crossover) | Trend Following   | MARKET     | Quick entries       |
| [EMARibbon](#emaribbon--exponential-moving-average-ribbon)     | Trend Following   | STICKY     | Trend confirmation  |
| [GridBot](#gridbot--grid-trading-strategy)                     | Range Trading     | LIMIT      | Sideways markets    |

The rules these eight strategies share come first, under [Common Rules](#common-rules). The [Debug Strategies](#debug-strategies), at the end, are test fixtures, one of which two shipped configurations use.

---

## Common Rules

### Parameters Are Checked at Start-up

Each strategy declares its parameters in a schema, which checks the `strategy:` block, `name` aside, when the TradingAdvisor creates the strategy at start-up, before the first candle. The parameter tables below give the type, the bounds and the default of each parameter; a parameter without a default is required. Gekko stops, with exit code 1, on a key the strategy does not take (a misspelling, or a parameter of another strategy, such as `src` on CCI, DEMA or MACD), on a missing parameter, on a number written in quotes or that is not finite, and on a value out of bounds. The error lists every issue with its path (one JSON line in the log, its line breaks written `\n`; Gekko logs it twice, as the reason the run closes and then as the run's failure):

```
[TRADING ADVISOR] Invalid parameters for strategy RSI (strategy block):
✖ Unrecognized key: "hight"
  → at thresholds
✖ Invalid input: expected number, received undefined
  → at thresholds.high
```

The schemas check each parameter on its own, the order of the periods of MACD and TMA, a MACD `signal` of at least 2 with `macdSrc: hist`, and that GridBot has at least one level. Other combinations that cannot trade well, such as thresholds set the wrong way round, are accepted: each section says which. A `src` parameter is the price the indicators read from each candle, a price source: `open`, `high`, `low`, `close`, `hl2` (the mean of high and low), `hlc3` (of high, low and close) or `ohlc4` (of all four), `close` when left out.

To compare several values of a strategy's parameters, [Fox](./fox.md) backtests every combination of the values you list, side by side, and the PerformanceReporter of its template writes each one's figures as a row of one CSV file.

### Pairs and Capital

The seven signal strategies trade every pair of `watch.assets`, each against `watch.currency`: one set of indicators and one position per pair, the signals of each pair as the strategy's section describes them, whatever the other pairs do. No parameter selects the pairs: `watch.assets` does, so watch one asset to trade one pair (a configuration written for an earlier development build that watches several assets to trade the first now trades them all, see [Upgrading](./upgrading.md#6-check-what-trades-differently)). With several pairs watched, a line at the `info` level names them at start-up, with the way they share the currency:

```
Trading BTC/USDT, ETH/USDT and SOL/USDT: each BUY takes an equal share of the free currency among the pairs not invested, each SELL sells all of its asset
```

**Each BUY takes a share of the currency.** A BUY takes an equal share of the free currency among the pairs not invested, which it carries as an `allocation`, the percentage of the currency the Trader sizes it from (see the Trader's [Sizing](./plugins.md#sizing)): with n pairs not long, the pair buying among them, the share is 100 / n %, rounded down to 6 decimals, so 50 % with two pairs, 33.333333 % with three and 25 % with four. The last pair not invested, or a pair watched alone, buys all-in, without an `allocation`. A pair whose BUY is pending counts as not invested, so that two BUYs of one candle, sized from the same balance read, each take their share; a pair whose SELL is pending is still invested. A SELL sells all of its pair's asset, and the currency it brings in is shared by the next BUYs.

For instance, with 1000 USDT and four pairs flat, two BUY signals on one candle send two BUYs of 25 %, each sized from 250 USDT, 5 % of it kept back for the fee; once both have filled, a third pair's BUY takes 50 % of the currency left, and the fourth, the last not invested, buys all-in with what remains.

**On several pairs, a share too small for the market is not sent.** Before it sends a BUY, the strategy estimates what the market would take: the pair's share of the currency in its portfolio, less the 5 % kept back for the fee, and the amount of the asset this buys at the close, truncated to the market's amount step. When the market would refuse that BUY for its minimum cost (`cost.min`) or its minimum amount (`amount.min`), the BUY is skipped: nothing is sent, so nothing is refused and nothing counts towards `maxConsecutiveErrors`. The first skip of a pair is a warning, which names the share, its cost, the minimum and the remedy:

```
[ETH/USDT] BUY skipped: 50 % of the 18 USDT free, 8.55 USDT once 5 % is kept back for the fee, is below the minimum cost of 10 USDT of the market: watch fewer pairs or fund the account; the next skips of this pair are logged at debug level until a BUY of it is placed
```

When the cost passes but the amount, truncated to the step, does not, the line names that amount, its price and the step; for the last pair's all-in BUY, it advises only to `fund the account`. The next skips of the pair are logged at the `debug` level, until a BUY of it is placed. A skipped BUY counts as a refused one, without the refusal: each strategy's section says when it asks again. When the portfolio shows enough of the pair's asset free to sell at the close, a skipped BUY makes the strategy long on the pair instead, said at the `info` level, and the strategy sells that holding at its next SELL signal. A market without a minimum cost or amount skips nothing.

A skipped BUY leaves no advice line: DEMA, SMACrossover and TMA log their advice (`[BTC/USDT] Executing long advice due to detected uptrend: 10/5/2`, at the `info` level, which the EventSubscriber relays to its `strat_info` subscribers) only once the BUY is placed, and the four others log none. MACD, RSI and CCI also log, at the `info` level and so to `strat_info`, each trend a pair enters (`[BTC/USDT] MACD: up trend detected`, `[BTC/USDT] RSI: low trend detected`, `[BTC/USDT] CCI: oversold trend detected`, and the opposite trends), whether an order follows or not: on a trend's first candle, that line can stand beside the skip warning.

A strategy watching one pair skips nothing: its all-in BUY is sent, the Trader warning first when it is below a minimum of the market (see the Trader's [Sizing](./plugins.md#sizing)), and refused when the currency is too little (see [Position and Orders](#position-and-orders)).

**Lines named by their pair.** Every line a signal strategy logs about a pair starts with that pair in brackets: `[BTC/USDT] SMA crossed DOWN price (9950.00000 < 10000.00000) => BUY`, `[ETH/USDT] Initial state: price below SMA`, `[BTC/USDT] Executing long advice due to detected uptrend: @ …`. A line about an order names it by its id instead (`[<id>] …`, see [Position and Orders](#position-and-orders)).

**The candles of every pair, every minute.** Every watched pair's candles are required every minute: a missing one stops a backtest, and a pair that stops delivering stops a realtime run.

**GridBot trades one pair**, the first of `watch.assets`, with `watch.currency`. With several assets watched, it says so once at start-up, at the `warn` level:

```
The strategy trades BTC/USDT only, the first pair watched (watch.assets): it ignores ETH/USDT, whose candles are still required every minute
```

To grid another pair, put its asset first in `watch.assets`, or watch it alone.

**Either analyzer reports on a run of several pairs.** The [RoundTripAnalyzer](./plugins.md#roundtripanalyzer) follows the round trips of each pair apart, each one's P&L from its own fills, and reports on every pair together, with each pair's figures beside; the [PortfolioAnalyzer](./plugins.md#portfolioanalyzer) values the whole portfolio at every timeframe candle. Both measure the market return on one asset, the benchmark: BTC when it is watched, otherwise the first asset of `watch.assets`, unless their `benchmarkAsset` option names another watched asset. A signal strategy trades the benchmark's pair as it trades every watched pair: watching an asset only to measure the strategy against it makes the strategy trade it too, while GridBot can be measured against a pair it does not trade (see [How Both Work](./plugins.md#how-both-work)).

### Position and Orders

The seven signal strategies hold one position per pair, all in: on each pair, they are flat or long (GridBot keeps a grid of orders instead).

- Their orders carry no amount: a BUY carries its pair's share of the currency as an `allocation`, or nothing when it is all-in (see [Pairs and Capital](#pairs-and-capital)), and a SELL sells all of the pair's asset free. They are `STICKY` orders, `MARKET` ones for SMACrossover (see the Trader's [Order Types](./plugins.md#order-types)).
- They start flat on every pair, buy only when flat and sell only when long, and never while an order of their own on that pair is pending: an order pending on one pair does not hold back the others.
- The Trader ends each order as completed, canceled or errored, a refusal included. A completed BUY makes the strategy long on its pair. A completed SELL makes it flat, unless what is left of the asset free is still enough to sell (after a SELL capped at the most the market takes in one order, or when coins reached the account after the Trader last read its balance). A canceled or errored order may have executed in part or in full: the position is then read from what the event reports and from the portfolio after the order, long when what is held is enough to sell at the market's minimums. A position read so that changes is logged at the `info` level (`[<id>] BUY order errored: 10 BTC free in the portfolio after it, enough to sell: the strategy is long`).
- When the Trader could not read the balances after an order, the strategy goes by what the order reports, or keeps its position until the end of its next order on the pair, with a warning (`[<id>] SELL order completed after selling 1 BTC, and the Trader could not read the balances after it: the strategy stays long until the end of its next order`).

The full rules, which a custom strategy can follow too, are under [Tracking Your Position](./custom-strategies.md#tracking-your-position). Each strategy's section says what becomes of a signal its position does not allow, and of an order that is canceled or refused.

**An account that holds an asset at start-up.** The strategy starts flat on its pair all the same, after a restart too (see [Stopping and Restarting a Live Run](./modes.md#stopping-and-restarting-a-live-run)), so the first signal it acts on there is a BUY. With enough currency, the BUY goes through and the next SELL signal sells everything held. With too little, the BUY is refused, or skipped on several pairs (see [Pairs and Capital](#pairs-and-capital)): the strategy then takes the asset free in the portfolio as its position when it is enough to sell, and sells it at its next SELL signal.

**An account that can neither buy nor sell.** With too little currency to buy and no sellable amount of the asset, every BUY is refused: TMA and EMARibbon send it again on every candle of their signal, the others once per trend (DEMA, MACD, RSI, CCI) or per crossover (SMACrossover), until `maxConsecutiveErrors` errored orders in a row (a TradingAdvisor option, 5 by default) stop Gekko, with exit code 0: `Max consecutive order errors reached (5)`. The errored orders of every pair count together, and a completed or canceled order of any pair resets the count. On several pairs, a BUY too small for the market is skipped instead (see [Pairs and Capital](#pairs-and-capital)): no order is sent, nothing counts towards `maxConsecutiveErrors`, and the run goes on, the pair trading nothing while its BUYs are skipped.

### Warmup

A strategy places no order during the warmup, the first `watch.warmup.candleCount` timeframe candles: in a backtest, those at the start of `watch.daterange`; in realtime, history fetched at start-up, so that the first candle a strategy can trade on is the one in progress at start-up, once it closes, unless a watched pair's history starts inside the warmup window: the warmup then starts at the first minute at which every watched pair has a candle, and ends that much later (see [Modes](./modes.md#-importer-mode)). The warmup candles feed the indicators, and a strategy advises nothing until its indicators have a value. Indicators with a value from candle K have one on the first candle after the warmup with a `candleCount` of K − 1 or more. SMACrossover and EMARibbon, which compare each candle with the one before, need K, for the last warmup candle to have one too (see their sections):

| Strategy     | Indicators with a value from candle K                       | K for the example of its section |
|--------------|-------------------------------------------------------------|----------------------------------|
| TMA          | `long`                                                      | 50                               |
| SMACrossover | `period`                                                    | 20                               |
| EMARibbon    | `start + (count − 1) × step`, the period of the slowest EMA | 45                               |
| DEMA         | `2 × period − 1` (the DEMA; the SMA from `period`)          | 23                               |
| MACD         | `long + signal − 1`                                         | 34                               |
| RSI          | `period + 1`                                                | 15                               |
| CCI          | `period`                                                    | 20                               |

GridBot uses no indicator but, with `atr` spacing, the ATR of `atrPeriod` candles, which has a value from candle `atrPeriod + 1`: its warmup then needs a `candleCount` of `atrPeriod` or more, and otherwise only delays the grid (see [When the Grid Starts](#when-the-grid-starts)).

---

## Trend Following Strategies

### TMA — Triple Moving Average

The TMA strategy uses **three Simple Moving Averages** of the same price with different periods (short, medium, long), all computed on the `watch.timeframe` candles, to identify trend direction. Waiting for the three averages to line up filters out noise and confirms a trend before taking action.

#### How It Works

1. Calculates three SMAs of `src` on each watched pair: short, medium, and long period
2. **BUY Signal**: When flat, if `short > medium > long` (bullish alignment)
3. **SELL Signal**: When long, if the alignment is mixed: the medium SMA above both others (`short < medium` and `medium > long`) or below both (`short > medium` and `medium < long`). A fully bearish alignment (`short < medium < long`) gives no signal
4. Two SMAs within 1e-9 of each other (relative) count as equal: an alignment whose medium SMA equals the short or the long one gives no signal, so a market flat over the long SMA's whole window gives none
5. The strategy starts flat and advises nothing on a pair while one of its orders is pending there. An order canceled or refused is placed again on the next candle where its signal still holds, unless it executed before it ended (see [Position and Orders](#position-and-orders)). On several pairs, a BUY skipped as too small for the market (see [Pairs and Capital](#pairs-and-capital)) is asked for again on every candle of the bullish alignment, each skip after the first logged at the `debug` level, unless the portfolio holds enough of the pair's asset to sell, which makes the strategy long there at the first skip. The advice is logged only once the BUY is placed (`[BTC/USDT] Executing long advice due to detected uptrend: 10/5/2`, at the `info` level, relayed to the `strat_info` subscribers): a skipped candle leaves the book's line alone

#### Parameters

| Parameter | Type         | Required | Default | Description                          |
|-----------|--------------|----------|---------|--------------------------------------|
| `short`   | integer ≥ 1  | Yes      | —       | Period of the short SMA, the fastest |
| `medium`  | integer ≥ 1  | Yes      | —       | Period of the medium SMA             |
| `long`    | integer ≥ 1  | Yes      | —       | Period of the long SMA, the slowest  |
| `src`     | price source | No       | `close` | Price the three SMAs average         |

The periods must increase, `short < medium < long`: swapped periods would buy on the opposite alignment and equal ones never align, so Gekko refuses them at start-up.

#### Example Configuration

```yaml
strategy:
  name: TMA
  short: 10
  medium: 21
  long: 50
  src: close
```

#### When to Use

- Strong trending markets
- When you want three averages to confirm a trend, rather than one
- Longer-term position trading

---

### SMACrossover — Simple Moving Average Crossover

The SMACrossover strategy is a classic crossover strategy that generates signals when the close crosses the **Simple Moving Average**. It uses **MARKET orders** for immediate execution (on Hyperliquid, an immediate-or-cancel limit order, see [Order Types](./plugins.md#order-types)).

#### How It Works

1. Calculates, on each watched pair, the SMA of `src` for the configured period. The price compared with it is always the candle's close, whatever `src`: with `src: hl2`, the close crosses the SMA of hl2
2. **BUY Signal**: When flat, if the close crosses **above** the SMA (logged as "SMA crossed DOWN price" once the BUY is placed: a BUY the book skips leaves the book's line alone)
3. **SELL Signal**: When long, if the close crosses **below** the SMA (logged as "SMA crossed UP price")
4. On every candle once the SMA has a value, the warmup included, the strategy records which side of the SMA the close is on: an upward crossover between the last warmup candle and the first candle after it buys (a downward one is skipped, the strategy starting flat), while one within the warmup does not trade. When the SMA has no value before the warmup ends, the first candle on which the close is off it only records the side
5. A close within 1e-9 of the SMA (relative) is on it, neither above nor below: no crossover, and the side it was on is kept. A market flat over the whole SMA window (minutes without trades, a long filled gap) gives no signal, while over a shorter flat stretch the moving SMA can still cross the frozen close; a crossover takes the close leaving the SMA on the other side
6. The strategy starts flat on each pair and advises nothing on a pair while one of its orders is pending there: a crossover the position does not allow is skipped. An order canceled or refused, or a BUY skipped as too small for the market (on several pairs only, see [Pairs and Capital](#pairs-and-capital)), is not placed again: the next one waits for the pair's next crossover

#### Parameters

| Parameter | Type         | Required | Default | Description                                                       |
|-----------|--------------|----------|---------|-------------------------------------------------------------------|
| `period`  | integer ≥ 1  | Yes      | —       | Candles the SMA averages                                          |
| `src`     | price source | No       | `close` | Price the SMA averages; the price crossing it is always the close |

With `period: 1` and `src: close` the SMA is the close itself: the close is always on it, and the strategy never trades. Gekko does not refuse it.

#### Example Configuration

```yaml
strategy:
  name: SMACrossover
  period: 20
  src: close
```

#### When to Use

- Markets with clear momentum shifts
- When you want quick entries via market orders
- Short to medium-term trading

---

### EMARibbon — Exponential Moving Average Ribbon

The EMARibbon strategy uses multiple **Exponential Moving Averages** arranged as a ribbon. It buys a tight bullish ribbon (fastest EMA on top) that is not narrowing, and sells as soon as the ribbon narrows.

#### How It Works

1. Creates, on each watched pair, a ribbon of `count` EMAs of `src`, the first of period `start`, each next one `step` periods slower
2. Measures each ribbon's **spread** on each candle, the warmup included: the gap between its highest and lowest EMA, in price units (quote currency)
3. **BUY Signal**: When flat, if the ribbon is bullish (each EMA above the next, slower one), its spread is below `spreadCompressionThreshold`, and the spread has not narrowed since the previous candle: the last warmup candle, for the first candle after the warmup
4. **SELL Signal**: When long, as soon as the spread narrows from one candle to the next, whatever the order of the EMAs and the threshold
5. Two EMAs within 1e-9 of each other (relative) count as equal, so a ribbon frozen on a flat market is not bullish; likewise, a spread within 1e-9 of the previous one has not narrowed
6. The strategy starts flat and advises nothing on a pair while one of its orders is pending there. An order canceled or refused is placed again by the next candle that signals it, unless it executed before it ended (see [Position and Orders](#position-and-orders)), and so is a BUY skipped as too small for the market (on several pairs, see [Pairs and Capital](#pairs-and-capital)): each candle of the signal asks for it again, the next skips of the pair logged at the `debug` level, the only lines they leave, since the strategy logs no advice of its own, unless the portfolio holds enough of the pair's asset to sell, which makes the strategy long there at the first skip

#### Parameters

| Parameter                    | Type         | Required | Default | Description                                                                                     |
|------------------------------|--------------|----------|---------|-------------------------------------------------------------------------------------------------|
| `src`                        | price source | No       | `close` | Price every EMA averages                                                                        |
| `count`                      | integer ≥ 2  | Yes      | —       | Number of EMAs in the ribbon                                                                    |
| `start`                      | integer ≥ 1  | Yes      | —       | Period of the first, fastest EMA                                                                |
| `step`                       | integer ≥ 1  | Yes      | —       | Periods added from one EMA to the next                                                          |
| `spreadCompressionThreshold` | number       | Yes      | —       | Spread, in quote currency, below which a bullish ribbon can buy (a spread equal to it does not) |

The threshold is in quote currency, so it scales with the price of the pair; at 0 or below the strategy never buys, a spread never being below it. With several pairs watched, the one threshold applies to the ribbon of every pair: in quote currency, a threshold that suits BTC/USDT (500 USDT in the example below) is wide enough that the ribbon of a pair priced a few hundred USDT, or less, is always compressed, so watch pairs of similar prices together, or each in a run of its own. Set `watch.warmup.candleCount` to at least the period of the slowest EMA, `start + (count − 1) × step` (45 for the example below): the ribbon then has a spread on the last warmup candle, which the first candle after the warmup is compared with. With a shorter warmup, the ribbon's first spread comes after the warmup, with none before it to compare with, which counts as not narrowed: a bullish ribbon below the threshold buys there.

#### Example Configuration

```yaml
strategy:
  name: EMARibbon
  src: close
  count: 8
  start: 10
  step: 5
  # Creates EMAs with periods: 10, 15, 20, 25, 30, 35, 40, 45
  spreadCompressionThreshold: 500 # In quote currency (500 USDT on BTC/USDT): scale it with the price of the pair
```

#### When to Use

- Strong momentum markets
- When you want visual confirmation of trend strength
- Trend-following with multiple confirmations

---

## Momentum & Mean Reversion Strategies

### DEMA — Double Exponential Moving Average

The DEMA strategy uses the difference between a **Double Exponential Moving Average** and a **Simple Moving Average** to detect trend changes. DEMA responds faster to price changes than a traditional EMA, making it suitable for catching medium-term trend reversals.

#### How It Works

1. Calculates, on each watched pair, the DEMA and the SMA of the close for the configured period
2. Computes the difference: `diff = SMA - DEMA`, in quote currency
3. An **uptrend** starts once `diff` is above the **up threshold**, a **downtrend** once it is below the **down threshold**. A trend lasts until `diff` crosses the other threshold: candles between the two thresholds do not end it
4. In an uptrend, when flat → **BUY**; in a downtrend, when long → **SELL**. One advice per trend: the strategy starts flat and advises nothing on a pair while one of its orders is pending there, and a trend the position does not allow yet is advised on its next candle past the threshold once it does: a BUY that fills during a downtrend is sold on the next candle of that downtrend below the down threshold
5. An order canceled or refused, or a BUY skipped as too small for the market (on several pairs, see [Pairs and Capital](#pairs-and-capital)), counts as its trend's advice: the next order on that pair waits for the next trend, once `diff` has crossed the other threshold. A BUY's advice is logged only once it is placed (`[BTC/USDT] Executing long advice due to detected uptrend: @ …`): a skipped BUY leaves the book's line alone

> [!NOTE]
> The DEMA follows the price closely while the SMA lags behind it, so a positive `diff` means the price has just fallen below its average, and a negative one that it has just risen above it. The strategy buys after a fall and sells after a rise: it trades against the recent move, as the DEMA of the [original Gekko](https://github.com/askmike/gekko) did, although its logs call these an uptrend and a downtrend.

#### Parameters

| Parameter         | Type        | Required | Default | Description                                                           |
|-------------------|-------------|----------|---------|-----------------------------------------------------------------------|
| `period`          | integer ≥ 2 | Yes      | —       | Candles of both the DEMA and the SMA                                  |
| `thresholds.up`   | number      | Yes      | —       | `diff` above which an uptrend starts, which buys, in quote currency   |
| `thresholds.down` | number      | Yes      | —       | `diff` below which a downtrend starts, which sells, in quote currency |

The thresholds are in quote currency, so they scale with the price of the pair: the shipped configurations use `100` and `-150` on BTC/USDT. With several pairs watched, the same thresholds apply to every pair: in quote currency, thresholds that suit BTC/USDT are far too wide for a pair priced a few USDT, which then never trends, so watch pairs of similar prices together, or each in a run of its own. Nothing checks that `down` is below `up`: set the other way round, there is no neutral zone and the trend changes at `up` alone. A period of 1 is refused, the DEMA and the SMA of a single candle both being its close. The strategy takes no `src`: both averages are computed on the close.

#### Example Configuration

```yaml
strategy:
  name: DEMA
  period: 12
  thresholds:
    up: 100 # In quote currency (USDT on BTC/USDT): scale both thresholds with the price of the pair
    down: -150
```

#### When to Use

- Markets that swing around their average rather than trend in one direction
- Medium-term trading (hours to days)
- When you want faster response than traditional moving averages

---

### MACD — Moving Average Convergence Divergence

The MACD strategy is based on the popular **MACD indicator**, the difference between a short and a long EMA of the close, with its signal line and histogram. It includes a **persistence filter** to confirm trends before acting.

#### How It Works

1. Calculates, on each watched pair, the MACD line (short EMA − long EMA), its signal line (an EMA of the MACD line) and the histogram (MACD line − signal line)
2. Reads the value `macdSrc` names (`macd`, `signal` or `hist`)
3. An **uptrend** starts once that value is above the **up threshold**, a **downtrend** once it is below the **down threshold**. A trend lasts until the value crosses the other threshold: candles between the two thresholds neither end it nor count towards its persistence
4. When flat, once the uptrend has counted `persistence` candles above the up threshold → **BUY**; when long, once the downtrend has counted `persistence` candles below the down threshold → **SELL**. A persistence of 0 or 1 advises on the trend's first candle. The candles counted need not follow each other: with a persistence of 3, three one-candle excursions above the up threshold, separated by candles between the thresholds, buy on the third
5. One advice per trend: the strategy starts flat and advises nothing on a pair while one of its orders is pending there, and a trend the position does not allow yet is advised on its next candle past the threshold once it does: a SELL that fills during an uptrend is bought back on the next candle of that uptrend above the up threshold. An order canceled or refused counts as its trend's advice, and so does a BUY skipped as too small for the market (on several pairs, see [Pairs and Capital](#pairs-and-capital)): the next order waits for the next trend, once the value has crossed the other threshold
6. Each trend a pair enters is logged at the `info` level, and so relayed to the `strat_info` subscribers, whether an order follows or not: `[BTC/USDT] MACD: up trend detected` or `[BTC/USDT] MACD: down trend detected`

#### Parameters

| Parameter                | Type                       | Required | Default | Description                                                                                        |
|--------------------------|----------------------------|----------|---------|----------------------------------------------------------------------------------------------------|
| `short`                  | integer ≥ 1                | Yes      | —       | Period of the short EMA (typically 12), below `long`                                               |
| `long`                   | integer ≥ 1                | Yes      | —       | Period of the long EMA (typically 26)                                                              |
| `signal`                 | integer ≥ 1                | Yes      | —       | Period of the signal line, the EMA of the MACD line (typically 9), at least 2 with `macdSrc: hist` |
| `macdSrc`                | `macd`, `signal` or `hist` | Yes      | —       | The value compared with the thresholds: the MACD line, the signal line or the histogram            |
| `thresholds.up`          | number                     | Yes      | —       | Value above which an uptrend starts, which buys                                                    |
| `thresholds.down`        | number                     | Yes      | —       | Value below which a downtrend starts, which sells                                                  |
| `thresholds.persistence` | integer ≥ 0                | Yes      | —       | Candles past its threshold a trend counts before it advises                                        |

Gekko refuses at start-up a `short` that is not below `long`: swapped periods give the opposite MACD, equal ones a MACD of 0. The thresholds are in price units (quote currency), as the MACD is, so they scale with the price of the pair. With several pairs watched, the same thresholds apply to every pair: thresholds away from 0 that suit BTC/USDT are far too wide for a pair priced a few USDT, which then never trends, so watch pairs of similar prices together, or each in a run of its own; thresholds of 0, as in the example below, suit any price. Nothing checks that `down` is below `up`: set the other way round, there is no neutral zone and the trend changes at `up` alone. The strategy takes no `src`: its EMAs are computed on the close.

Gekko also refuses at start-up a `signal` of 1 with `macdSrc: hist`. A signal line of period 1 is the MACD line itself, so the histogram, their difference, is 0: the strategy would never trade, or buy once and never sell with `up` below 0. The error, logged as every parameter refusal is (see [Parameters Are Checked at Start-up](#parameters-are-checked-at-start-up)), reads:

```
[TRADING ADVISOR] Invalid parameters for strategy MACD (strategy block):
✖ signal must be at least 2 with macdSrc: hist (a signal of 1 makes the signal line the MACD line itself, and the histogram 0)
```

With `macdSrc: macd` or `signal`, a `signal` of 1 is accepted: the MACD line does not depend on it, and the signal line is then the MACD line.

#### Example Configuration

```yaml
strategy:
  name: MACD
  short: 12
  long: 26
  signal: 9
  macdSrc: hist
  thresholds:
    up: 0
    down: 0
    persistence: 1
```

#### When to Use

- Markets with momentum shifts
- When you want confirmation via persistence
- Identifying trend reversals

---

### RSI — Relative Strength Index

The RSI strategy uses the **Relative Strength Index** to identify overbought and oversold conditions. It includes a **persistence filter** to avoid false signals.

#### How It Works

1. Calculates, on each watched pair, the RSI of `src` for the configured period, between 0 and 100
2. A **low trend** (oversold) starts once the RSI is below the **low threshold**, a **high trend** (overbought) once it is above the **high threshold**. A trend lasts until the RSI crosses the other threshold: candles between the two thresholds neither end it nor count towards its persistence
3. When flat, once the low trend has counted `persistence` candles below the low threshold → **BUY**
4. When long, once the high trend has counted `persistence` candles above the high threshold → **SELL**
5. A persistence of 0 or 1 advises on the trend's first candle. The candles counted need not follow each other: with a persistence of 3, three one-candle dips under the low threshold, separated by candles between the thresholds, buy on the third
6. One advice per trend: the strategy starts flat and advises nothing on a pair while one of its orders is pending there, and a trend the position does not allow yet is advised on its next candle past the threshold once it does: a BUY that fills during a high trend is sold on the next candle of that trend above the high threshold. An order canceled or refused counts as its trend's advice, and so does a BUY skipped as too small for the market (on several pairs, see [Pairs and Capital](#pairs-and-capital)): the next order waits for the next trend, once the RSI has crossed the other threshold
7. Each trend a pair enters is logged at the `info` level, and so relayed to the `strat_info` subscribers, whether an order follows or not: `[BTC/USDT] RSI: low trend detected` or `[BTC/USDT] RSI: high trend detected`

#### Parameters

| Parameter                | Type         | Required | Default | Description                                                      |
|--------------------------|--------------|----------|---------|------------------------------------------------------------------|
| `period`                 | integer ≥ 2  | Yes      | —       | RSI calculation period (typically 14)                            |
| `src`                    | price source | No       | `close` | Price the RSI reads                                              |
| `thresholds.high`        | number       | Yes      | —       | Overbought level (typically 70), above which a high trend starts |
| `thresholds.low`         | number       | Yes      | —       | Oversold level (typically 30), below which a low trend starts    |
| `thresholds.persistence` | integer ≥ 0  | Yes      | —       | Candles past its threshold a trend counts before it advises      |

The comparisons are strict and the RSI lies between 0 and 100: a `high` of 100 or more never sells, a `low` of 0 or less never buys. Nothing checks that `low` is below `high`: set the other way round, there is no neutral zone and the trend changes at `high` alone. On a market flat since the RSI's first candle, the RSI is 0 (TA-Lib's convention), which reads as oversold. A period of 1 is refused: the RSI of a single change is 100 on a rise and 0 on a fall or an unchanged close, so every unchanged close, the flat candles that fill a gap included, would read as oversold.

#### Example Configuration

```yaml
strategy:
  name: RSI
  period: 14
  src: close
  thresholds:
    high: 70
    low: 30
    persistence: 1
```

#### When to Use

- Range-bound or mean-reverting markets
- Identifying overbought/oversold conditions
- Counter-trend trading

---

### CCI — Commodity Channel Index

The CCI strategy uses the **Commodity Channel Index** to identify overbought and oversold conditions based on price deviation from the mean.

#### How It Works

1. Calculates, on each watched pair, the CCI of the typical price (`hlc3`) for the configured period
2. An **overbought** trend lasts while the CCI is at or above the **up threshold**, an **oversold** trend while it is at or below the **down threshold**: a trend ends as soon as the CCI is back between the thresholds
3. When long, once the overbought trend has lasted the persistence period → **SELL**; when flat, once the oversold trend has → **BUY**. The persistence counts candles in a row: the advice comes on the trend's first candle for a persistence of 0, and on its `persistence`-th candle from 2 on. A persistence of 1 waits for the second candle, as 2 does, one candle later than RSI and MACD advise with a persistence of 1
4. One advice per trend: the strategy starts flat and advises nothing on a pair while one of its orders is pending there, and a trend the position does not allow yet is advised on its next candle once it does: a BUY that fills during an overbought trend is sold on the next candle of that trend. An order canceled or refused counts as its trend's advice, and so does a BUY skipped as too small for the market (on several pairs, see [Pairs and Capital](#pairs-and-capital)): the next order waits for the next trend, on the other side, or on the same side once the CCI has been back between the thresholds
5. Each trend a pair enters is logged at the `info` level, and so relayed to the `strat_info` subscribers, whether an order follows or not: `[BTC/USDT] CCI: oversold trend detected` or `[BTC/USDT] CCI: overbought trend detected`, again each time the CCI comes back past a threshold from between them

#### Parameters

| Parameter                | Type        | Required | Default | Description                                                               |
|--------------------------|-------------|----------|---------|---------------------------------------------------------------------------|
| `period`                 | integer ≥ 2 | Yes      | —       | CCI calculation period (typically 20)                                     |
| `thresholds.up`          | number      | Yes      | —       | Overbought level (typically +100): a CCI at or above it sells             |
| `thresholds.down`        | number      | Yes      | —       | Oversold level (typically -100): a CCI at or below it buys                |
| `thresholds.persistence` | integer ≥ 0 | Yes      | —       | Candles in a row at or past its threshold a trend needs before it advises |

Unlike RSI and MACD, the comparisons include the thresholds, and a candle between them ends the trend. A period of 1 is refused, the CCI of a single candle being always 0. Nothing checks that `down` is below `up`: set the other way round, there is no neutral zone and the trend changes at `up` alone. The strategy takes no `src`: the CCI is computed on the typical price.

#### Example Configuration

```yaml
strategy:
  name: CCI
  period: 20
  thresholds:
    up: 100
    down: -100
    persistence: 0
```

#### When to Use

- Cyclical or mean-reverting markets
- Identifying extreme price deviations
- Commodity and cryptocurrency markets

---

## Range Trading Strategies

### GridBot — Grid Trading Strategy

The GridBot is a **grid trading strategy** that places a series of LIMIT orders above and below the current price. It profits from price oscillations within a range. Unlike the signal strategies, it holds no single position: each level of its grid trades on its own.

#### How It Works

1. **Start-up Check**: Refuses to start while orders are open on its pair (see [Restarting](#restarting)). Stopping Gekko leaves the grid's orders on the exchange: cancel them there (see [Stopping and Restarting a Live Run](./modes.md#stopping-and-restarting-a-live-run))
2. **Start**: Centres the grid on the close of the first candle after the warmup, and checks it against the market (see [When the Grid Starts](#when-the-grid-starts) and [Prices and Checks](#prices-and-checks))
3. **Rebalancing**: Splits the free balances so that every level trades the same quantity, which is not a 50/50 split (see [Rebalancing](#rebalancing))
4. **Grid Building**: Places LIMIT BUYs below the center price and LIMIT SELLs above it, as many as the free balances fund with orders the market takes (see [Grid Building](#grid-building))
5. **Order Management**: Once a level's BUY fills, sells one step above; once its SELL fills, buys one step below. A refused or canceled order is placed again up to `retryOnError` times (see [Order Management](#order-management))
6. **Range Monitoring**: Warns once when the price leaves the grid's range (see [Range Monitoring](#range-monitoring))
7. **Grid Reset**: Off by default. With `resetMode`, builds a new grid around the price once it has closed out of the range, on a side the mode arms, for `resetConfirmCandles` timeframe candles in a row, at the cost of realizing the loss of the breakout (see [Grid Reset](#grid-reset))

#### Parameters

| Parameter              | Type                                       | Required | Default | Description                                                                                                                                                       |
|------------------------|--------------------------------------------|----------|---------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `buyLevels`            | integer ≥ 0                                | Yes      | —       | Number of buy levels below center price; the lowest must stay above 0 (see [Prices and Checks](#prices-and-checks))                                               |
| `sellLevels`           | integer ≥ 0                                | Yes      | —       | Number of sell levels above center price; `buyLevels` and `sellLevels` cannot both be 0                                                                           |
| `spacingType`          | `percent`, `fixed`, `logarithmic` or `atr` | Yes      | —       | How levels are spaced                                                                                                                                             |
| `spacingValue`         | number > 0                                 | Yes      | —       | Distance between adjacent prices (see [Spacing Types Explained](#spacing-types-explained))                                                                        |
| `retryOnError`         | integer ≥ 1                                | No       | `3`     | Times a refused or canceled order is placed again before it is given up; also the orders of unknown outcome tolerated (see [Order Management](#order-management)) |
| `atrPeriod`            | integer ≥ 1                                | No       | `14`    | Period of the ATR an `atr` spacing reads, in timeframe candles (see [When the Grid Starts](#when-the-grid-starts))                                                |
| `resetMode`            | `none`, `up`, `down` or `both`             | No       | `none`  | When the grid is reset around the price: never, on a close above the grid, below it, or either way (see [Grid Reset](#grid-reset))                                |
| `resetConfirmCandles`  | integer ≥ 1                                | No       | `1`     | Timeframe candles in a row that close out of the grid on an armed side before the reset                                                                           |
| `resetCooldownCandles` | integer ≥ 0                                | No       | `0`     | Timeframe candles after a reset's new grid during which a close out of it does not count towards another reset                                                    |

`atrPeriod` is read with `atr` spacing only, and `resetConfirmCandles` and `resetCooldownCandles` with a `resetMode` other than `none`: given otherwise, they are accepted and ignored.

#### Example Configuration

```yaml
strategy:
  name: GridBot
  buyLevels: 5
  sellLevels: 5
  spacingType: percent
  spacingValue: 1
  retryOnError: 3
```

An `atr` grid that follows a breakout on either side once two timeframe candles in a row have closed out of its range, and lets ten timeframe candles go by after each reset before it counts again; its warmup must give the ATR its value (see [When the Grid Starts](#when-the-grid-starts)):

```yaml
strategy:
  name: GridBot
  buyLevels: 5
  sellLevels: 5
  spacingType: atr
  spacingValue: 1.5
  atrPeriod: 14
  resetMode: both
  resetConfirmCandles: 2
  resetCooldownCandles: 10
```

#### When to Use

- **Sideways/ranging markets** with clear support and resistance
- When you expect price to oscillate within a range
- Markets with sufficient liquidity for limit orders
- When you want to profit from volatility without directional bias

> [!CAUTION]
> Grid strategies can accumulate losses if the price breaks out of the range in one direction: below it, the grid has spent its currency on the asset and holds it as the price falls; above it, the grid has sold its asset and misses the rise. GridBot moves its grid only when `resetMode` says so, and a reset realizes the loss of the breakout (see [Grid Reset](#grid-reset)). It has no stop-loss, and it trades all the free balances of its pair: give it only the account you mean it to trade, and stop it yourself when the price leaves the range for good. Stopping Gekko leaves the grid's orders on the exchange: cancel them there (see [Stopping and Restarting a Live Run](./modes.md#stopping-and-restarting-a-live-run)).

#### Spacing Types Explained

`spacingValue` sets the distance between two adjacent prices of the grid, the center price included:

| Type          | `spacingValue` Meaning                 | Example                                                             |
|---------------|----------------------------------------|---------------------------------------------------------------------|
| `percent`     | Percent of the center price            | `1` = prices 1 % of the center price apart: 99, 100, 101 around 100 |
| `fixed`       | Price units                            | `500` = prices $500 apart                                           |
| `logarithmic` | Ratio between adjacent prices, minus 1 | `0.01` = each price 1 % above the one below it                      |
| `atr`         | Multiple of the ATR                    | `1.5` = prices 1.5 × the ATR apart: 480 apart with an ATR of 320    |

`percent` spacing is arithmetic, as `fixed` spacing is: adjacent prices are `spacingValue` % **of the center price** apart, so that `10` around 100 places them at 50, 60, … 150, +20 % from 50 to 60 but +7 % from 140 to 150. For the same percentage between every two adjacent prices, use `logarithmic` spacing.

`atr` spacing follows the volatility of the pair: when the grid starts, and again at each [reset](#grid-reset), GridBot multiplies `spacingValue` by the pair's [ATR](./indicators.md#atr--average-true-range) of `atrPeriod` timeframe candles and rounds the product to the price tick, a `fixed` step kept until the next reset (on a tick of 0.01, `spacingValue: 1.5` and an ATR of 320.0714 give 480.11). A step too narrow to pay the maker fee (`fee.maker`) on both orders of a level is raised to the smallest step at which every level breaks even, one tick at least, with a warning each time the step is resolved. With `spacingValue: 1.5` on a 5/5 grid at 60000 and a 0.1 % maker fee, an ATR of 40 gives a step of 60, raised to 121.09:

```
GridBot: ATR spacing: spacingValue 1.5 × ATR 40 is a step of 60 on the price tick 0.01, under 121.09, the minimum step at which every level of the grid breaks even on the maker fee of 0.001 (fee.maker): the grid is spaced by 121.09 instead
```

#### When the Grid Starts

GridBot places nothing during the warmup: the grid starts on the first candle after it, centred on that candle's close. With `percent`, `fixed` or `logarithmic` spacing, the warmup only delays the grid: in a backtest by `watch.warmup.candleCount` timeframe candles, 0 starting it on the close of the first timeframe candle of `watch.daterange`. In realtime, the grid, or the rebalance before it, goes out when the timeframe candle in progress at start-up closes, whatever `candleCount` (within a minute with `1m`, up to a day with `1d`), unless a watched pair's history starts inside the warmup window, which holds every pair back (see [Modes](./modes.md#-importer-mode)).

With `atr` spacing, the grid needs the ATR on that first candle: set `watch.warmup.candleCount` to `atrPeriod` or more (14 with the default period), or the run stops there, before any order (exit code 1):

```
GridBot: The ATR has no value yet on the first candle after the warmup: with atrPeriod 14 it needs 15 timeframe candles, the warmup's and the first after it, so set watch.warmup.candleCount to 14 or more
```

#### Prices and Checks

The grid's prices are rounded to the nearest price tick (`precision.price`), or to 8 decimals, with a warning, on a market that states none (for a tick that depends on the price, see [Markets Whose Tick Depends on the Price](#markets-whose-tick-depends-on-the-price)). When the grid starts and at each [reset](#grid-reset), before any order, GridBot stops the run (exit code 1) when:

- the lowest buy level would be at or below 0 once rounded to the tick (with `percent` spacing, `buyLevels × spacingValue` must stay under 100): `GridBot: Grid configuration would result in non-positive buy prices: the lowest of buyLevels 2, spaced by spacingValue 5 (fixed) below the center price 9, would be at -1`;
- the center price is outside the exchange's price limits (`price.min`, `price.max`): `GridBot: Center price … is below exchange minimum …`, or `… above exchange maximum …`;
- two adjacent prices of the grid round to the same tick, a level that would buy and sell at one price:

```
GridBot: Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.001 (percent) around the center price 100, two adjacent prices of the grid would both round to 100 at the price tick 0.01
```

The first and the last checks run again around the price a rebalance ended at, where the grid is planned again after a failed rebalance, or built once it filled: the run then stops before any grid order, and the rebalance already filled is not undone. With `fixed` spacing, keep `buyLevels × spacingValue` well under the price: a rebalance that ends lower can bring the lowest buy level to 0.

A spacing whose levels earn less than the two maker fees of a round trip, a SELL less than 2 × fee / (1 − fee) above its BUY (0.2002 % at a 0.1 % fee), is accepted with a warning each time a grid is built: such a grid loses money at each round trip. For a 5/5 grid at 60000 with a 0.1 % maker fee and a tick of 0.01, no level loses from a spacing of 121.09 (`fixed`), 0.2019 (`percent`) or 0.002003 (`logarithmic`) up:

```
GridBot: spacingValue 100 (fixed) is under the round-trip fee: a level that sells less than 0.2002 % above its buy, paying the maker fee of 0.001 (fee.maker) on its BUY and on its SELL, loses money at each round trip, 10 out of 10 here, the narrowest selling at 60500, 0.1656 % above its buy at 60400
```

#### Markets Whose Tick Depends on the Price

Hyperliquid takes 5 significant digits in a price (`precision.priceSignificantDigits`, an integer part of more digits kept whole), so its tick is one unit of the fifth significant digit: 0.1 from 1000, 1 from 10000. Its `precision.price` is only the tick at the price the markets were loaded at, so GridBot rounds each price of the grid to the tick at that price where it is coarser, as the exchange takes it: a close of 10000.37 centres a grid spaced by 1 (`fixed`) on 10000, its SELLs at 10001 and 10002.

The checks read the prices so rounded. An `atr` step is raised to a whole number of the coarser tick at the top of the grid until every level breaks even there, with a warning of its own when the step was above the minimum:

```
GridBot: ATR spacing: spacingValue 1 × ATR 8.3 is a step of 8.3 on the price tick 0.1, at which a level of the grid loses money on the maker fee of 0.0004 (fee.maker) on the price tick 1 at the top of the grid: the grid is spaced by 9 instead
```

The check of adjacent prices names the rule when the coarser tick merges two of them (spaced by 0.5 around 9999, 10000.5 and 10001 both round to 10001):

```
GridBot: Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.5 (fixed) around the center price 9999, two adjacent prices of the grid would both round to 10001 at the price tick 1, the market taking 5 significant digits in a price (precision.priceSignificantDigits)
```

A backtest rehearses these rules when its dummy-cex market data states `precision.priceSignificantDigits: 5`.

#### Rebalancing

Every level trades the same quantity `q`: the SELLs need `sellLevels × q` of the asset, and the BUYs the sum of their prices × `q` of the currency, plus the maker fee, which the simulator of backtests and paper trading charges in currency on top of a BUY (live, see the warning under [Order Management](#order-management)). At the start and at each [reset](#grid-reset), GridBot first rebalances the free balances to that split with one STICKY order, so that little of either side stays idle. The split is not 50/50, since the BUYs, below the center price, cost less than the SELLs are worth: about 51 % of the value in the asset for 5/5 levels spaced by 1 %.

Funds locked in other orders are left out, said at the `info` level. No rebalance is sent when the grid would leave less than 1 % of the value idle, nor when it would be under the market's minimum order: the grid is then built on the balances as they are.

A rebalance refused or canceled is planned again on the balances it left, and placed again up to `retryOnError` times (see [GridBot Messages](#gridbot-messages)). After `retryOnError + 1` failures, or as soon as its outcome is unknown, the run stops before any grid order (`GridBot: Rebalance failed after 4 attempts (retryOnError: 3): the grid is not built. Last error: …`). Once it has filled, the grid is built around the price it ended at, and goes out with the next minute (see [Plugin Order](./plugins.md#plugin-order)): a BUY left above a market that fell meanwhile executes at once.

#### Grid Building

Every order of the grid is for one quantity: the smaller of the free asset split over the sell levels and of the free currency split over the buy prices, the maker fee on top, rounded down to the amount step and capped by the market's maximum. With no fee, a 2/2 grid spaced by 5 (`fixed`) around 100 needs, for each unit, 2 of the asset for its SELLs at 105 and 110, and 185 of the currency for its BUYs at 95 and 90: 5 BTC and 462.5 USDT give 2.5 a level.

Every order is sized to one the market takes, of at least its minimum amount and cost (`amount.min`, `cost.min`) at the lowest price of the grid. When the free balances cannot fund every level so, each side keeps the levels nearest the center price, none for a side that funds no level (a one-sided grid), with a warning (`GridBot: 1 of the 5 buy levels and 1 of the 5 sell levels left out, …`), and the run stops only when no level is funded (`GridBot: Insufficient portfolio for any grid levels: …`). A 5/5 grid spaced by 1 % around 60000 on Binance's BTC/USDT, whose minimum order is 5 USDT, needs about 55 USDT of value.

#### Order Management

Each level spans two adjacent prices and holds one order at a time: a level below the center price starts with a BUY at its lower price, a level above it with a SELL at its upper price. When the order fills, the level places the opposite order one step away, for the grid's quantity: a SELL one price above a filled BUY, a BUY one price below a filled SELL. So a price swinging around the center trades every swing.

> [!WARNING]
> Live, unless the account pays its fees in BNB, Binance takes a BUY's fee from the asset bought, while the grid is sized as the simulator charges fees, in currency: each round trip of a level leaves the account `q × fee.maker` less of the asset than the grid counts. Once the asset that the sizing left idle is spent (a few dozen round trips for 1000 USDT on 5/5 levels at 60000, a hundred or more for a grid at the minimum), the SELL that follows a filled BUY asks for more than is free. The Trader caps it at the free balance, with a warning (`… above the free balance: … sent, all that can be sold`), and the exchange truncates it to the amount step, a step or more under the level's quantity. For a grid sized at the market minimum (about 55 USDT on BTC/USDT), that SELL can fall below the minimum cost (0.00009 BTC sent as 0.00008 at 60000, 4.8 USDT), and is then refused at each attempt until its level gives up. Backtests and paper trading never show it. Pay the fees in BNB, or fund the grid with at least twice the minimum a level.

When a grid order fails:

- A refused order is placed again on its side and at its price, for the amount GridBot asked for, whatever the Trader capped it to. A canceled one is placed again for what is left of it, its amount less the fill the exchange reported, or whole, with a warning, when no fill was reported; one filled in full, or with less left than the market takes, turns its level as a fill does.
- The refusals and cancels of a level count together until it fills: after `retryOnError + 1` of them, the level is left without an order, the rest of the grid trading on, with a warning (`GridBot: BUY at 95 failed after 4 attempts (retryOnError: 3): its level is left without an order, …`). A cancel you make by hand counts the same way, and so does an expiry by the exchange's self-trade prevention, which can hit the BUY and the SELL that two levels place at one price once a candle has crossed levels on both sides of it.
- An order whose outcome is unknown, which may still be live on the exchange (its creation's answer lost, its state not read back, its creation failed by the exchange's internal or busy errors, a poll failed for good), is never placed again: its level is left without an order, with a warning to check that order on the exchange.

The run stops (exit code 1) once no level holds an order, or once more than `retryOnError` grid orders are of unknown outcome. The TradingAdvisor's `maxConsecutiveErrors` (5 by default) counts the same errors, in a row, with a fill or a cancel in between resetting it: with the defaults, a level gives up at its 4th error, and the next error anywhere in the grid trips the circuit breaker, an orderly stop with exit code 0. With `retryOnError` at `maxConsecutiveErrors − 1` or more, a level that keeps failing trips the breaker by the time it would give up.

#### Range Monitoring

The grid stays where it was built unless a reset moves it. When a timeframe candle closes out of its range, GridBot warns once, naming the grid's price next to the bound the price left, where its orders wait:

```
GridBot: Price 111 is out of grid range [90, 110]: the grid stays in place, its orders waiting for the price to come back to 105
```

With a reset armed on that side, the warning says when the grid is reset (`…: the grid is reset once 2 consecutive timeframe candles close above it (resetConfirmCandles), …`), or, during a cooldown, how long it stays in place (`…: the grid stays in place for the 4 timeframe candles left of its cooldown (resetCooldownCandles 10), …`); the candle that triggers a reset logs the reset's line instead. GridBot logs once at the `info` level when a close is back at the price where the orders wait, or further in (`GridBot: Price 105 is back in grid range [90, 110]`), and warns once when a fill leaves orders on one side of the grid only (`GridBot: Only one side of the grid remains active`). A one-sided grid has its center price for a bound, so a close beyond it on the empty side is out of range at once.

#### Grid Reset

By default (`resetMode: none`), the grid stays where it was built. With `resetMode` (`up` above the grid, `down` below it, `both` on either side), a timeframe candle that closes out of the range on an armed side counts towards a reset, and any other close starts the count again. Once `resetConfirmCandles` candles in a row have counted, the grid is reset: with 1, the default, at the first close out of the range; with 2 or more, a spike that comes straight back passes. Each candle counted before the last is logged at the `debug` level (`GridBot: Price 111 closed above grid range [90, 110]: 1 of 2 consecutive timeframe candles towards a reset`). Nothing is counted while the grid is rebalanced or a reset is under way, nor during the `resetCooldownCandles` timeframe candles that follow a reset's new grid.

The reset is logged at the `info` level, numbered in the run:

```
GridBot: Price 112 closed above grid range [90, 110] for 2 consecutive timeframe candles (resetConfirmCandles): reset 1, its 4 open orders are canceled and a new grid is built around the price once they have ended
```

Every open order of the grid is canceled, and none is placed again: a fill before its cancel turns no level, and what it bought or sold is in the balances the new grid is built on. Once no order is open, the new grid is built around the last price the Trader reports, exactly as at the start: the `atr` step resolved again, the checks of [Prices and Checks](#prices-and-checks), then the rebalance, or the grid when none is needed, which goes out with the next minute (see [Plugin Order](./plugins.md#plugin-order)).

When the Trader could not read the balances after the cancels (live, `fetchBalance` failing its retries), the event carries its previous read and says so (`portfolioReadAfterOrder`, see [Trader Events](./plugins.md#trader-events)): what the canceled orders held may still count as locked in other orders. GridBot builds the grid on the rest all the same, after a warning (`GridBot: The Trader could not read the balances after the cancels of reset 1, …`): a smaller grid, or none, the run stopping for an insufficient portfolio. A restart builds it on the balances as they are.

A grid order of unknown outcome, left before the reset or during it, may still be live on the exchange, so the run stops where the new grid would be built over it (exit code 1): `GridBot: BUY 2.5 at 95 may be live on the exchange without GridBot tracking it: the grid of reset 1 is not built over it. Check it on the exchange`.

**What a reset costs.** A reset trades at the price of the breakout: after a breakout above, its rebalance buys back, higher, the asset the grid sold on the way up; after a breakout below, it sells, lower, what the grid bought on the way down. Left in place, the grid would wait for the price to come back into its range, where those levels trade back. A reset realizes the loss of the breakout instead, and a trend that breaks each new grid realizes it at every reset: `resetConfirmCandles` asks a breakout to last before the grid follows it, and `resetCooldownCandles` spaces the resets a trend chains.

#### Restarting

GridBot keeps its grid in memory and follows only the orders of the current run: stopping Gekko leaves the grid's orders on the exchange, where nothing follows them (see [Stopping and Restarting a Live Run](./modes.md#stopping-and-restarting-a-live-run)). So GridBot refuses to start while any order is open on its pair, whatever placed it (a previous run's grid, an order placed by hand or by another bot, a stop-loss), naming each one, and Gekko exits with code 1:

```
GridBot: 2 orders are open on BTC/USDT at start-up: LIMIT BUY 1 at 95 (id 28458), LIMIT SELL 1 at 110 (id 28459). GridBot keeps its grid in memory and follows only the orders it places: an order placed before this run, by a previous run, by hand or by another bot, would trade beside the new grid without GridBot hearing of its fills. Cancel the orders open on BTC/USDT on the exchange, then start again
```

Cancel those orders on the exchange, then start Gekko again: GridBot builds a new grid on the free balances. Orders on the other watched pairs do not stop it. Under a restart-on-failure supervisor, Gekko restarts into the same refusal until the orders are canceled. A backtest or a paper-trading session starts with no order open.

#### GridBot Messages

Besides the stops quoted above, GridBot logs these lines under the `strategy` tag, but the last, which the Trader logs under the `trader` tag:

| Line                                                                                                                                       | Level | Meaning                                                                                                                                                                         |
|--------------------------------------------------------------------------------------------------------------------------------------------|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `GridBot: Rebalance attempt 1 failed: … Retrying...`                                                                                       | warn  | The rebalance was refused or canceled: it is placed again, planned on the free balances it left                                                                                 |
| `GridBot: Rebalance attempt 1 failed: … Not placed again: the free balances it left need no rebalance, the grid is built on them`          | warn  | What the rebalance filled before it failed leaves the free balances near enough to the split                                                                                    |
| `GridBot: Rebalance attempt 1 failed: … Not placed again: the grid is built on the free balances it left`                                  | warn  | The free balances it left call for a rebalance under the market's minimum order, or one they cannot pay: the line that says which follows                                       |
| `GridBot: Rebalance attempt 1 failed: … Not placed again: the grid is refused around 9, the price it ended at`                             | warn  | The grid fails the checks of [Prices and Checks](#prices-and-checks) around the price the rebalance ended at: the error that stops the run follows                              |
| `GridBot: BUY at 95 was canceled with no fill reported: it is placed again whole, 2.5, which trades again any part of it that had filled`  | warn  | No answer of the exchange reported what the canceled order filled                                                                                                               |
| `GridBot: BUY 2.5 at 95 may be live on the exchange without GridBot tracking it: it is not placed again, and the grid of reset 1 is not …` | warn  | A grid order ended in error during a reset while it may still be live, with other orders of the reset open: the run stops once they have ended                                  |
| `GridBot: Price 112 closed above grid range [90, 110] … reset 1, its 3 open orders are canceled, then the run stops: …`                    | info  | A reset starts while an order of unknown outcome is left from before it: the open orders are canceled all the same, and the run stops once they have ended                      |
| `[<id>] Impossible to cancel order: Unknown Order`                                                                                         | warn  | A reset canceled an order that had already filled, on the candle that triggered it: the fill is heard, and the new grid is built on the balances it left                        |

A line about orders of unknown outcome names several in one list: `BUY 2.5 at 95 and SELL 2.5 at 105 may be live on the exchange without GridBot tracking them: …`.

---

## Strategy Selection Guide

| Your Goal                   | Recommended Strategy |
|-----------------------------|----------------------|
| Follow strong trends        | TMA, EMARibbon       |
| Catch trend reversals       | DEMA, MACD           |
| Trade overbought/oversold   | RSI, CCI             |
| Profit from ranging markets | GridBot              |
| Quick entries on crossovers | SMACrossover         |

---

## Debug Strategies

Six more strategies ship with Gekko for its end-to-end tests. Two shipped configurations, `config/realtime-screener.yml` and `config/realtime-supervision.yml`, select one of them, DebugAdvice, to show their alerts:

| Strategy      | Orders                                                                                                                                                                             | Parameters                                                                                                                                                                                   |
|---------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `DebugAdvice` | A STICKY order of 1 unit on every watched pair, every `each` candles from candle `wait`, counted from 0 for the first candle after the warmup: a SELL first, then a BUY, and so on | `each` (integer ≥ 1, required: 1 advises on every candle), `wait` (integer ≥ 0, default 0), `cancelAfter` (integer ≥ 0, optional: cancels each order that many candles later, 0 acting as 1) |

DebugAdvice tracks no position, unlike the strategies above: it advises a SELL whether the asset is held or not, the SELL is refused when it is not, and each refusal counts towards `maxConsecutiveErrors`. Its parameters are checked at start-up, as the others' are. The block the shipped configurations use:

```yaml
strategy:
  name: DebugAdvice
  each: 2 # one advice every 2 candles: a SELL, then a BUY, and so on
  wait: 0 # candles to let go by before the first advice
```

The other five, DebugBacktest, DebugOrderScript, DebugPositionBook, DebugRealtime and DebugTrailingStop, are the end-to-end tests' fixtures: they can be selected, but they are not meant for trading, and their parameters are in their schemas (`packages/schemas/src/strategies/debug/`).
