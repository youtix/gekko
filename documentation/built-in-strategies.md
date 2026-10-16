# Built-in Strategies

Gekko 2 comes with a variety of pre-built trading strategies that you can use right out of the box. Each strategy is designed with different market conditions and trading styles in mind.

You pick a strategy with the TradingAdvisor's `strategyName` and give its parameters directly under the top-level `strategy:` block, whose `name` must equal `strategyName` (see the [TradingAdvisor](./plugins.md#-tradingadvisor)). The seven signal strategies wait for each of their orders to end before they advise again, and GridBot re-arms a level only once that level's order has ended: run them with a [Trader](./plugins.md#-trader), for alerts only too. On `paper-binance` (realtime) and `dummy-cex` (backtest), the Trader only simulates the orders.

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

The rules these eight strategies share (their parameters checked at start-up, the one pair each trades, the position the signal strategies hold and the warmup they need) come first, under [Common Rules](#common-rules). The four strategies of `src/strategies/debug/`, test fixtures that two shipped configurations use, are described at the end, under [Debug Strategies](#debug-strategies).

---

## Common Rules

### Parameters Are Checked at Start-up

Each strategy declares its parameters in a schema, which checks the `strategy:` block, `name` aside, when the TradingAdvisor creates the strategy at start-up, before the first candle. The parameter tables below give the type, the bounds and the default of each parameter; a parameter without a default is required. Gekko stops, with exit code 1, on a key the strategy does not take (a misspelling, or a parameter of another strategy, such as `src` on CCI, DEMA or MACD), on a missing parameter, on a number written in quotes or that is not finite, and on a value out of bounds. The error lists every issue with its path:

```
[TRADING ADVISOR] Invalid parameters for strategy RSI (strategy block):
✖ Unrecognized key: "hight"
  → at thresholds
✖ Invalid input: expected number, received undefined
  → at thresholds.high
```

The schemas check each parameter on its own, the order of the periods of MACD and TMA, a MACD `signal` of at least 2 with `macdSrc: hist`, and that GridBot has at least one level. Other combinations that cannot trade well, such as thresholds set the wrong way round, are accepted: each section says which. A `src` parameter is the price the indicators read from each candle, a price source: `open`, `high`, `low`, `close`, `hl2` (the mean of high and low), `hlc3` (of high, low and close) or `ohlc4` (of all four), `close` when left out.

### One Pair per Strategy

Each strategy trades a single pair: the first of `watch.assets`, with `watch.currency`. With several assets watched, it says so once at start-up, at the `warn` level:

```
The strategy trades BTC/USDT only, the first pair watched (watch.assets): it ignores ETH/USDT, whose candles are still required every minute
```

The other pairs are not traded, but their candles are still required every minute: a missing one stops a backtest, and a pair that stops delivering stops a realtime run. To trade another pair, put its asset first in `watch.assets`, or watch it alone.

### Position and Orders

The seven signal strategies, all but GridBot (which keeps a grid of orders instead), hold one position at a time, all in: they are either flat or long. They follow the same rules:

- Their orders carry no amount: the Trader sizes a BUY from the free currency, with 5 % kept back for the fee, and a SELL from the free asset. They are `STICKY` orders, `MARKET` ones for SMACrossover (see the Trader's [Order Types](./plugins.md#order-types)).
- They start flat. They buy only when flat and sell only when long, and never while an order of their own is pending.
- The Trader ends each order with one of three events: completed, canceled or errored, a refusal included. A completed BUY makes the strategy long. After a completed SELL, which carries no amount, the strategy reads its position from the free balance of the asset in the portfolio after it: flat, unless what is left is enough to sell (as below), as after a SELL the Trader capped at the most the market takes in one order, or when the account received some of the asset after the Trader last read its balance (a deposit, a trade made by hand or by another bot). The strategy is then still long, and sells what is left at its next SELL signal.
- A canceled or errored order may have executed before it ended, in part or in full. The strategy then reads its position from what the event reports: the fill of a cancelation (what a BUY bought, what a SELL left unsold), otherwise the free balance of the asset in the portfolio read after the order. It is long when that amount is enough to sell (at least the market's minimum amount and cost, once truncated to its amount step), flat otherwise, and stays as it was when the event reports neither. A position read this way that differs from the one held before is logged at the `info` level, for instance `[<id>] BUY order errored: 10 BTC free in the portfolio after it, enough to sell: the strategy is long`.

Each section says what becomes of a signal the position does not allow, and of an order that is canceled or refused. A custom strategy can keep the same bookkeeping: see [Tracking Your Position](./custom-strategies.md#tracking-your-position).

**An account that holds the asset at start-up.** The strategy still starts flat, so the first signal it acts on is a BUY. With enough currency the BUY goes through, and the next SELL signal sells everything held. With too little, the BUY is refused; the strategy then takes the free balance of the asset, in the portfolio after the refusal, as its position, and sells it at its next SELL signal.

**An account that can neither buy nor sell.** With too little currency to buy and no sellable amount of the asset, every BUY is refused. TMA and EMARibbon place it again on every candle of their signal, the others once per trend (DEMA, MACD, RSI, CCI) or per crossover (SMACrossover), until `maxConsecutiveErrors` errored orders in a row (a TradingAdvisor option, 5 by default) stop Gekko, with exit code 0: `Max consecutive order errors reached (5)`.

### Warmup

A strategy places no order during the warmup, the first `watch.warmup.candleCount` timeframe candles: in a backtest, those at the start of `watch.daterange`; in realtime, history fetched at start-up, so that the first candle a strategy can trade on is the one in progress at start-up, once it closes. The warmup candles feed the indicators, and a strategy advises nothing until its indicators have a value. Indicators with a value from candle K have one on the first candle after the warmup with a `candleCount` of K − 1 or more. SMACrossover and EMARibbon, which compare each candle with the one before, need K, for the last warmup candle to have one too (see their sections):

| Strategy     | Indicators with a value from candle K                       | K for the example of its section |
|--------------|-------------------------------------------------------------|----------------------------------|
| TMA          | `long`                                                      | 50                               |
| SMACrossover | `period`                                                    | 20                               |
| EMARibbon    | `start + (count − 1) × step`, the period of the slowest EMA | 45                               |
| DEMA         | `2 × period − 1` (the DEMA; the SMA from `period`)          | 23                               |
| MACD         | `long + signal − 1`                                         | 34                               |
| RSI          | `period + 1`                                                | 15                               |
| CCI          | `period`                                                    | 20                               |

GridBot uses no indicator: its warmup only delays the grid (see [When the Grid Starts](#when-the-grid-starts)).

---

## Trend Following Strategies

### TMA — Triple Moving Average

The TMA strategy uses **three Simple Moving Averages** of the same price with different periods (short, medium, long), all computed on the `watch.timeframe` candles, to identify trend direction. Waiting for the three averages to line up filters out noise and confirms a trend before taking action.

#### How It Works

1. Calculates three SMAs of `src`: short, medium, and long period
2. **BUY Signal**: When flat, if `short > medium > long` (bullish alignment)
3. **SELL Signal**: When long, if the alignment is mixed: the medium SMA above both others (`short < medium` and `medium > long`) or below both (`short > medium` and `medium < long`). A fully bearish alignment (`short < medium < long`) gives no signal
4. Two SMAs within 1e-9 of each other (relative) count as equal: an alignment whose medium SMA equals the short or the long one gives no signal, so a market flat over the long SMA's whole window gives none
5. The strategy starts flat and advises nothing while one of its orders is pending. An order canceled or refused is placed again on the next candle where its signal still holds, unless it executed before it ended (see [Position and Orders](#position-and-orders))

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

The SMACrossover strategy is a classic crossover strategy that generates signals when the close crosses the **Simple Moving Average**. It uses **MARKET orders** for immediate execution.

#### How It Works

1. Calculates the SMA of `src` for the configured period. The price compared with it is always the candle's close, whatever `src`: with `src: hl2`, the close crosses the SMA of hl2
2. **BUY Signal**: When flat, if the close crosses **above** the SMA (logged as "SMA crossed DOWN price")
3. **SELL Signal**: When long, if the close crosses **below** the SMA (logged as "SMA crossed UP price")
4. On every candle once the SMA has a value, the warmup included, the strategy records which side of the SMA the close is on: an upward crossover between the last warmup candle and the first candle after it buys (a downward one is skipped, the strategy starting flat), while one within the warmup does not trade. When the SMA has no value before the warmup ends, the first candle on which the close is off it only records the side
5. A close within 1e-9 of the SMA (relative) is on it, neither above nor below: no crossover, and the side it was on is kept. A market flat over the whole SMA window (minutes without trades, a long filled gap) gives no signal, while over a shorter flat stretch the moving SMA can still cross the frozen close; a crossover takes the close leaving the SMA on the other side
6. The strategy starts flat and advises nothing while one of its orders is pending: a crossover the position does not allow is skipped. An order canceled or refused is not placed again: the next one waits for the next crossover

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

1. Creates a ribbon of `count` EMAs of `src`, the first of period `start`, each next one `step` periods slower
2. Measures the ribbon's **spread** on each candle, the warmup included: the gap between its highest and lowest EMA, in price units (quote currency)
3. **BUY Signal**: When flat, if the ribbon is bullish (each EMA above the next, slower one), its spread is below `spreadCompressionThreshold`, and the spread has not narrowed since the previous candle: the last warmup candle, for the first candle after the warmup
4. **SELL Signal**: When long, as soon as the spread narrows from one candle to the next, whatever the order of the EMAs and the threshold
5. Two EMAs within 1e-9 of each other (relative) count as equal, so a ribbon frozen on a flat market is not bullish; likewise, a spread within 1e-9 of the previous one has not narrowed
6. The strategy starts flat and advises nothing while one of its orders is pending. An order canceled or refused is placed again by the next candle that signals it, unless it executed before it ended (see [Position and Orders](#position-and-orders))

#### Parameters

| Parameter                    | Type         | Required | Default | Description                                                                                     |
|------------------------------|--------------|----------|---------|-------------------------------------------------------------------------------------------------|
| `src`                        | price source | No       | `close` | Price every EMA averages                                                                        |
| `count`                      | integer ≥ 2  | Yes      | —       | Number of EMAs in the ribbon                                                                    |
| `start`                      | integer ≥ 1  | Yes      | —       | Period of the first, fastest EMA                                                                |
| `step`                       | integer ≥ 1  | Yes      | —       | Periods added from one EMA to the next                                                          |
| `spreadCompressionThreshold` | number       | Yes      | —       | Spread, in quote currency, below which a bullish ribbon can buy (a spread equal to it does not) |

The threshold is in quote currency, so it scales with the price of the pair; at 0 or below the strategy never buys, a spread never being below it. Set `watch.warmup.candleCount` to at least the period of the slowest EMA, `start + (count − 1) × step` (45 for the example below): the ribbon then has a spread on the last warmup candle, which the first candle after the warmup is compared with. With a shorter warmup, the ribbon's first spread comes after the warmup, with none before it to compare with, which counts as not narrowed: a bullish ribbon below the threshold buys there.

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

1. Calculates the DEMA and the SMA of the close for the configured period
2. Computes the difference: `diff = SMA - DEMA`, in quote currency
3. An **uptrend** starts once `diff` is above the **up threshold**, a **downtrend** once it is below the **down threshold**. A trend lasts until `diff` crosses the other threshold: candles between the two thresholds do not end it
4. In an uptrend, when flat → **BUY**; in a downtrend, when long → **SELL**. One advice per trend: the strategy starts flat and advises nothing while one of its orders is pending, and a trend the position does not allow yet is advised on its next candle past the threshold once it does: a BUY that fills during a downtrend is sold on the next candle of that downtrend below the down threshold
5. An order canceled or refused counts as its trend's advice: the next order waits for the next trend, once `diff` has crossed the other threshold

> [!NOTE]
> The DEMA follows the price closely while the SMA lags behind it, so a positive `diff` means the price has just fallen below its average, and a negative one that it has just risen above it. The strategy buys after a fall and sells after a rise: it trades against the recent move, as Gekko 1's DEMA did, although its logs call these an uptrend and a downtrend.

#### Parameters

| Parameter         | Type        | Required | Default | Description                                                           |
|-------------------|-------------|----------|---------|-----------------------------------------------------------------------|
| `period`          | integer ≥ 2 | Yes      | —       | Candles of both the DEMA and the SMA                                  |
| `thresholds.up`   | number      | Yes      | —       | `diff` above which an uptrend starts, which buys, in quote currency   |
| `thresholds.down` | number      | Yes      | —       | `diff` below which a downtrend starts, which sells, in quote currency |

The thresholds are in quote currency, so they scale with the price of the pair: the shipped configurations use `100` and `-150` on BTC/USDT. Nothing checks that `down` is below `up`: set the other way round, there is no neutral zone and the trend changes at `up` alone. A period of 1 is refused, the DEMA and the SMA of a single candle both being its close. The strategy takes no `src`: both averages are computed on the close.

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

1. Calculates the MACD line (short EMA − long EMA), its signal line (an EMA of the MACD line) and the histogram (MACD line − signal line)
2. Reads the value `macdSrc` names (`macd`, `signal` or `hist`)
3. An **uptrend** starts once that value is above the **up threshold**, a **downtrend** once it is below the **down threshold**. A trend lasts until the value crosses the other threshold: candles between the two thresholds neither end it nor count towards its persistence
4. When flat, once the uptrend has counted `persistence` candles above the up threshold → **BUY**; when long, once the downtrend has counted `persistence` candles below the down threshold → **SELL**. A persistence of 0 or 1 advises on the trend's first candle. The candles counted need not follow each other: with a persistence of 3, three one-candle excursions above the up threshold, separated by candles between the thresholds, buy on the third
5. One advice per trend: the strategy starts flat and advises nothing while one of its orders is pending, and a trend the position does not allow yet is advised on its next candle past the threshold once it does: a SELL that fills during an uptrend is bought back on the next candle of that uptrend above the up threshold. An order canceled or refused counts as its trend's advice: the next order waits for the next trend, once the value has crossed the other threshold

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

Gekko refuses at start-up a `short` that is not below `long`: swapped periods give the opposite MACD, equal ones a MACD of 0. The thresholds are in price units (quote currency), as the MACD is, so they scale with the price of the pair. Nothing checks that `down` is below `up`: set the other way round, there is no neutral zone and the trend changes at `up` alone. The strategy takes no `src`: its EMAs are computed on the close.

Gekko also refuses at start-up a `signal` of 1 with `macdSrc: hist`. A signal line of period 1 is the MACD line itself, so the histogram, their difference, is 0: the strategy would never trade, or buy once and never sell with `up` below 0. The error reads:

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

1. Calculates the RSI of `src` for the configured period, between 0 and 100
2. A **low trend** (oversold) starts once the RSI is below the **low threshold**, a **high trend** (overbought) once it is above the **high threshold**. A trend lasts until the RSI crosses the other threshold: candles between the two thresholds neither end it nor count towards its persistence
3. When flat, once the low trend has counted `persistence` candles below the low threshold → **BUY**
4. When long, once the high trend has counted `persistence` candles above the high threshold → **SELL**
5. A persistence of 0 or 1 advises on the trend's first candle. The candles counted need not follow each other: with a persistence of 3, three one-candle dips under the low threshold, separated by candles between the thresholds, buy on the third
6. One advice per trend: the strategy starts flat and advises nothing while one of its orders is pending, and a trend the position does not allow yet is advised on its next candle past the threshold once it does: a BUY that fills during a high trend is sold on the next candle of that trend above the high threshold. An order canceled or refused counts as its trend's advice: the next order waits for the next trend, once the RSI has crossed the other threshold

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

1. Calculates the CCI of the typical price (`hlc3`) for the configured period
2. An **overbought** trend lasts while the CCI is at or above the **up threshold**, an **oversold** trend while it is at or below the **down threshold**: a trend ends as soon as the CCI is back between the thresholds
3. When long, once the overbought trend has lasted the persistence period → **SELL**; when flat, once the oversold trend has → **BUY**. The persistence counts candles in a row: the advice comes on the trend's first candle for a persistence of 0, and on its `persistence`-th candle from 2 on. A persistence of 1 waits for the second candle, as 2 does, one candle later than RSI and MACD advise with a persistence of 1
4. One advice per trend: the strategy starts flat and advises nothing while one of its orders is pending, and a trend the position does not allow yet is advised on its next candle once it does: a BUY that fills during an overbought trend is sold on the next candle of that trend. An order canceled or refused counts as its trend's advice: the next order waits for the next trend, on the other side, or on the same side once the CCI has been back between the thresholds

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

The GridBot is a sophisticated **grid trading strategy** that places a series of LIMIT orders above and below the current price. It profits from price oscillations within a range. Unlike the signal strategies, it holds no single position: each level of its grid trades on its own.

#### How It Works

1. **Start-up Check**: Refuses to start while orders are open on its pair (see [Restarting](#restarting))
2. **Start**: On the first candle after the warmup, centres the grid on its close and checks it against the market (see [When the Grid Starts](#when-the-grid-starts) and [Prices and Checks](#prices-and-checks))
3. **Rebalancing**: Rebalances the portfolio so that it funds every level of the grid with the same quantity, which is not a 50/50 split (see [Rebalancing](#rebalancing))
4. **Grid Building**: Places buy orders below and sell orders above the center price, all for the same quantity, as far as the free balances fund orders the market takes (see [Grid Building](#grid-building))
5. **Order Management**: Each level trades back and forth between two adjacent prices of the grid: once its BUY fills it sells one step above, once its SELL fills it buys one step below (see [Order Management](#order-management))
6. **Range Monitoring**: Never moves the grid, and warns once when the price leaves its range (see [Range Monitoring](#range-monitoring))

#### Key Features

- **Automatic Rebalancing**: Splits the portfolio the way the grid uses it before building the grid, so that little capital sits idle
- **Three Spacing Types**: Fixed, percent, or logarithmic level distribution
- **Orders the Market Takes**: Every order is at least the market's minimum order: a small account gets fewer levels rather than refused orders
- **Error Recovery**: A refused or canceled order is placed again up to `retryOnError` times, and an order whose outcome is unknown is never placed twice
- **Range Warnings**: One warning when the price leaves the grid, one line when it is back

#### Parameters

| Parameter      | Type                                | Required | Default | Description                                                                                                                                                       |
|----------------|-------------------------------------|----------|---------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `buyLevels`    | integer ≥ 0                         | Yes      | —       | Number of buy levels below center price; the lowest must stay above 0 (see *Lowest buy level*)                                                                    |
| `sellLevels`   | integer ≥ 0                         | Yes      | —       | Number of sell levels above center price; `buyLevels` and `sellLevels` cannot both be 0                                                                           |
| `spacingType`  | `percent`, `fixed` or `logarithmic` | Yes      | —       | How levels are spaced                                                                                                                                             |
| `spacingValue` | number > 0                          | Yes      | —       | Distance between adjacent prices (see below)                                                                                                                      |
| `retryOnError` | integer ≥ 1                         | No       | `3`     | Times a refused or canceled order is placed again before it is given up; also the orders of unknown outcome tolerated (see [Order Management](#order-management)) |

#### Spacing Types Explained

`spacingValue` is the distance between two adjacent prices of the grid, the center price included:

| Type          | `spacingValue` Meaning                 | Example                                                             |
|---------------|----------------------------------------|---------------------------------------------------------------------|
| `percent`     | Percent of the center price            | `1` = prices 1 % of the center price apart: 99, 100, 101 around 100 |
| `fixed`       | Price units                            | `500` = prices $500 apart                                           |
| `logarithmic` | Ratio between adjacent prices, minus 1 | `0.01` = each price 1 % above the one below it                      |

`percent` spacing is arithmetic, as `fixed` spacing is: each level is `spacingValue` % **of the center price** away from its neighbour, not `spacingValue` % of the neighbour itself. Measured against the prices themselves, the levels are therefore wider at the bottom of the grid than at the top: `10` around 100 places the prices at 50, 60, … 150, so that 50 → 60 is +20 % while 140 → 150 is +7 %. For the same percentage between every two adjacent prices, use `logarithmic` spacing.

#### When the Grid Starts

GridBot uses no indicator, and places nothing during the warmup: the grid starts on the first candle after it, centred on that candle's close. In a backtest, `watch.warmup.candleCount` only delays the grid by that many timeframe candles: set it to 0 for the grid to start on the close of the first timeframe candle of `watch.daterange`. In realtime, the grid, or the rebalance that precedes it, goes out when the timeframe candle in progress at start-up closes, whatever `candleCount`: within one timeframe, a minute with `1m` and up to a day with `1d`. A longer warmup only costs history fetches.

#### Prices and Checks

The grid's prices are rounded to the market's price tick (`precision.price`) as they are written, a half tick rounding up: `fixed` and `percent` spacings are computed in decimal, `logarithmic` spacing in binary. A market that states no tick is priced to 8 decimals, with a warning when the grid starts; the dummy-cex configuration always states one (`precision.price`, in decimals).

On a market whose tick depends on the price, Hyperliquid, which takes 5 significant digits in a price (`precision.priceSignificantDigits`, an integer part of more digits being kept whole), each price is rounded to the tick at that price where it is coarser than `precision.price`: one unit of its fifth significant digit, 0.1 from 1000 and 1 from 10000 on. `precision.price` is only the tick at the price the markets were loaded at: a market loaded at 9990 states 0.1, while the exchange takes whole units from 10000 on. So the grid's prices are those the exchange takes as they are: there, a close of 10000.37 centres a grid spaced by 1 (`fixed`) on 10000, its SELLs at 10001 and 10002, where rounded to 0.1 they were 10001.4 and 10002.4, which the exchange takes as 10001 and 10002. A backtest rehearses the rule when its dummy-cex market data states `precision.priceSignificantDigits` (5, as on Hyperliquid): the simulator then rounds the price of every order the same way.

Besides the checks of its parameters at start-up (see [Parameters Are Checked at Start-up](#parameters-are-checked-at-start-up)), GridBot checks the grid against the market when it starts, before any order, and stops the run (exit code 1) when:

- the lowest buy level would be at or below 0, once rounded to the tick: with `percent` spacing, `buyLevels × spacingValue` must stay under 100 (see *Lowest buy level*);
- the center price is outside the exchange's price limits (`price.min`, `price.max`);
- two adjacent prices of the grid round to the same tick (see *Minimum spacing*).

The first and the last checks run again around the price a rebalance ended at (see *Lowest buy level* and *Minimum spacing*).

**Lowest buy level.** The lowest buy level must stay above 0 around every price the grid is centred on. It is checked when the grid starts, and again around the price a rebalance ended at, where the grid is planned again (after a failed rebalance) or built (once it filled). A grid whose lowest buy level would be at or below 0 there stops the run with the error of the start, naming the price the grid would be built around, for example `GridBot: Grid configuration would result in non-positive buy prices: the lowest of buyLevels 2, spaced by spacingValue 5 (fixed) below the center price 9, would be at -1`. No grid order is sent, and the rebalance already filled is not undone. With `fixed` spacing, keep `buyLevels × spacingValue` well under the price: a grid started with its lowest buy level a few ticks above 0 is refused once a rebalance ends a few ticks lower. `percent` and `logarithmic` grids, whose levels scale with the price, meet it only when their lowest buy level rounds to 0 on the tick, after a much larger fall.

**Minimum spacing.** Once rounded to the market's price tick, adjacent prices of the grid must stay at least one tick apart. A spacing that rounds two of them to the same price, a level that would buy and sell at that one price, stops the run when the grid starts, again before a failed rebalance is placed again around the price it ended at, so that no second rebalance is paid for a grid that would then be refused, and when the grid is built around the price a rebalance ended at (a `percent` or `logarithmic` step shrinks with the price). The first two check the grid as configured, the last the levels the free balances fund:

```
GridBot: Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.001 (percent) around the center price 100, two adjacent prices of the grid would both round to 100 at the price tick 0.01
```

On a market whose tick depends on the price, the tick is the one at each price, and the error names the rule where its tick, coarser than `precision.price`, merged two prices. On Hyperliquid loaded at 9990, a grid spaced by 0.5 (`fixed`) around 9999 with 2 buy and 4 sell levels keeps 10000.5 and 10001 a tick of 0.1 apart, but the exchange takes both as 10001:

```
GridBot: Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.5 (fixed) around the center price 9999, two adjacent prices of the grid would both round to 10001 at the price tick 1, the market taking 5 significant digits in a price (precision.priceSignificantDigits)
```

A spacing whose levels earn less than the two maker fees of a round trip (`fee.maker`), a SELL less than 2 × fee / (1 − fee) above its BUY (0.08003 % at a 0.04 % fee, 0.2002 % at 0.1 %), is accepted with one warning, logged at the `warn` level when the grid starts: such a grid loses money at each round trip. For a 5/5 grid at 60000 with a 0.1 % maker fee, no level loses with a spacing of 121.1 or more with `fixed` spacing (100 loses money there), 0.2019 or more with `percent` and 0.002003 or more with `logarithmic`:

```
GridBot: spacingValue 100 (fixed) is under the round-trip fee: a level that sells less than 0.2002 % above its buy, paying the maker fee of 0.001 (fee.maker) on its BUY and on its SELL, loses money at each round trip, 10 out of 10 here, the narrowest selling at 60500, 0.1656 % above its buy at 60400
```

#### Rebalancing

Every level of the grid trades the same quantity. For a quantity `q`, the SELLs need `sellLevels × q` of the asset, and the BUYs need the sum of their prices × `q` of the currency, plus the maker fee (`fee.maker`), which the simulator of backtests and paper trading charges in currency on top of a BUY. The grid is sized on the free balances, rounded down to the market's amount step, so what one side holds beyond what the other side funds stays idle for the whole run.

Before building the grid, GridBot therefore rebalances the free balances to that split with one STICKY order: it buys or sells the amount after which both sides fund the same quantity, the order's own price and fee included. Funds locked in other orders are left out, and reported once at the `info` level. The portfolio is not rebalanced when the grid would leave less than 1 % of its value idle, nor when the rebalance would be smaller than the market's minimum order (`amount.min`, or `cost.min` at the price of the STICKY order): the grid is then built on the balances as they are.

The split is not 50/50, since the BUYs, below the center price, cost less than the SELLs are worth. A symmetric grid holds a little more than half of its value in the asset, about 51 % for 5/5 levels spaced by 1 % and 56 % for 20/20 levels spaced by 2 %, and an asymmetric one about its share of sell levels, 76 % for 1 buy and 3 sell levels spaced by 5 at 100. A grid without sell levels is rebalanced all in currency, and one without buy levels all in the asset, buying what the currency pays once the fee is on top.

A rebalance refused or canceled is planned again on the balances it left, and placed again up to `retryOnError` times: once it has failed `retryOnError + 1` times, or as soon as its outcome is unknown (it may be live on the exchange), the run stops before any grid order is sent, for instance with `GridBot: Rebalance failed after 4 attempts (retryOnError: 3): the grid is not built. Last error: …`. Once the rebalance has filled, the grid is built around the price the rebalance ended at, the last price the Trader reports with the fill. Its orders reach the exchange with the next minute, as a strategy's reaction to an order event is queued and sent with the following bucket: if the market moved meanwhile, a BUY above it executes at once on an exchange, and in backtest at the next candle, at its own price.

Each failed attempt before the last is warned of with what follows it:

- `GridBot: Rebalance attempt 1 failed: … Retrying...` when the rebalance planned again is placed;
- `GridBot: Rebalance attempt 1 failed: … Not placed again: the free balances it left need no rebalance, the grid is built on them`, or `… Not placed again: the grid is built on the free balances it left` when they call for a rebalance the market would refuse or they cannot pay, followed by the line that says why;
- `GridBot: Rebalance attempt 1 failed: … Not placed again: the grid is refused around 9, the price it ended at` when the grid planned around that price fails the checks of the start (see [Prices and Checks](#prices-and-checks)), followed by the error that stops the run.

#### Grid Building

The grid places a LIMIT BUY on each buy level below the center price and a LIMIT SELL on each sell level above it, all for one quantity: the smaller of the free asset split over the sell levels and of the free currency split over the buy prices with the maker fee on top, rounded down to the market's amount step and capped by its maximum at the highest price of the grid. For instance, with no fee, a 2/2 grid spaced by 5 (`fixed`) around 100 needs, for each unit of quantity, 2 of the asset for its SELLs at 105 and 110, and 95 + 90 = 185 of the currency for its BUYs: 5 BTC and 462.5 USDT, its split, give 2.5 a level, with no rebalance. The example configuration below, on the dummy-cex market data of `config/backtest.yml` (a 0.04 % maker fee), started at 61234.56 with 1000 USDT, rebalances with a STICKY BUY of 0.00828635 BTC, then trades 0.00165727 BTC a level.

Every order of the grid is one the market takes: at least its minimum amount (`amount.min`, one amount step) and its minimum cost (`cost.min`) at the lowest price of the grid. When the free balances cannot fund every level with that minimum, each side keeps the levels it funds, the nearest to the center price, and leaves out the farthest, with a warning:

```
GridBot: 1 of the 5 buy levels and 1 of the 5 sell levels left out, the farthest from the center price: 0.0004 BTC and 25 USDT free fund no more orders of the market minimum, 0.00009 BTC at 58785.18, the lowest price of the grid
```

A side that funds no level is left out entirely, which builds a one-sided grid; the run stops only when no level at all is funded (`GridBot: Insufficient portfolio for any grid levels: … fund no order the market takes`). A grid needs a little more than one minimum order a level: about 55 USDT of value for 5/5 levels spaced by 1 % on Binance's BTC/USDT, whose minimum order is 5 USDT. A smaller account gets fewer levels.

#### Order Management

Each level of the grid spans two adjacent prices and holds one order at a time: a level below the center price starts with a BUY at its lower price, a level above it with a SELL at its upper price, and the two levels next to the center share the center price. When a level's order fills, the same level places the opposite order one step away: a filled BUY is followed by a SELL one price above, a filled SELL by a BUY one price below. So the first fill next to the center places its order at the center price, and a price swinging around the center trades every swing. Since each level reacts to its own fills only, the grid re-arms the same way whatever the order in which several fills are reported (a backtest reports a drop's BUYs highest first, paper and live trading in the order they are polled). When one candle or poll interval crosses levels on both sides of a price, both levels place their order at that price, a BUY and a SELL, and the one the market has already passed fills next.

When a grid order fails:

- A refused order is placed again on its side and at its price, for the amount refused. A canceled one is placed again for what is left of it, its amount less what it filled: the largest fill any answer of the exchange reported for it, a poll before the cancelation included. A canceled order reported filled in full, or with less left than the market takes, turns its level to its other side, as after a fill. When no answer of the exchange reported its fill, a canceled order is placed again whole, with a warning: `GridBot: BUY at 95 was canceled with no fill reported: it is placed again whole, 2.5, which trades again any part of it that had filled`.
- The refusals and cancels of a level count together until it fills. Once its order has failed `retryOnError + 1` times, the level is left without an order for the rest of the run, with a warning such as `GridBot: BUY at 95 failed after 4 attempts (retryOnError: 3): its level is left without an order, the rest of the grid trades on. Last error: …`. The rest of the grid trades on, and the run stops once no level holds an order.
- An order whose outcome is unknown, which may still be live on the exchange (its creation's answer lost, the order created but its state not read back, its creation failed by the exchange without a refusal, such as Binance's internal errors -1000 and -1006 and its busy or overloaded answers -1004 and -1008, or a poll that failed for good while it was open), is never placed again: its level is left without an order, with a warning to check that order on the exchange. The run stops once more than `retryOnError` grid orders are in that case, or once no level holds an order.

Each of these stops is an error (exit code 1). The TradingAdvisor's `maxConsecutiveErrors` (5 by default) counts the same errors, in a row, with a fill or a cancel in between resetting it: with the defaults, a level gives up at its 4th error, and the next error anywhere in the grid trips the circuit breaker, an orderly stop with exit code 0. With `retryOnError` at `maxConsecutiveErrors − 1` or more, a level that keeps failing trips the breaker by the time it would give up.

On a live exchange, a grid order you cancel by hand is placed again for what is left of it, its level giving up at the `retryOnError + 1`-th cancel. After a candle crossed both sides of a price, the BUY and the SELL left at that price can be expired in turn by the exchange's self-trade prevention: each expiry counts as a cancel, and both levels give up after `retryOnError + 1` of them.

#### Range Monitoring

GridBot never moves its grid. When a timeframe candle closes out of the grid's range, below its lowest price or above its highest, it warns once, naming the price where the grid's orders wait: the grid's price next to the bound the price left, where the bottom level's SELL or the top level's BUY rests once the orders beyond have filled:

```
GridBot: Price 111 is out of grid range [90, 110]: the grid stays in place, its orders waiting for the price to come back to 105
```

It logs once at the `info` level when a close is back at that price or inside it (`GridBot: Price 105 is back in grid range [90, 110]`), not at every crossing of the bound itself, and warns again when a close is out on the other side. A one-sided grid has its center price for a bound, so a close beyond it on the empty side is out of range at once. When a fill leaves orders on one side of the grid only, GridBot warns once (`GridBot: Only one side of the grid remains active`), until a fill gives it both sides again.

#### Restarting

GridBot keeps its grid in memory and follows only the orders it places in the current run. Stopping Gekko (Ctrl-C, a crash, a deploy) does not cancel the grid on the exchange. So at start-up, on the first minute, GridBot refuses to start while any order is open on its pair, whatever placed it: a previous run's grid, an order placed by hand or by another bot, a stop-loss or a take-profit included. It stops with an error naming each order by type, side, the amount it has left, price (`market` for an order without one) and id, and Gekko exits with code 1:

```
GridBot: 2 orders are open on BTC/USDT at start-up: LIMIT BUY 1 at 95 (id 28458), LIMIT SELL 1 at 110 (id 28459). GridBot keeps its grid in memory and follows only the orders it places: an order placed before this run, by a previous run, by hand or by another bot, would trade beside the new grid without GridBot hearing of its fills. Cancel the orders open on BTC/USDT on the exchange, then start again
```

Cancel those orders on the exchange, then start Gekko again: GridBot builds a new grid on the free balances. It does not adopt them. Orders on the other watched pairs, which GridBot does not trade, do not stop it. Under a restart-on-failure supervisor, Gekko restarts into the same refusal until the orders are canceled; each restart reads the open orders and sends nothing. A backtest or a paper-trading session starts with no order open, so it is never refused.

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

#### When to Use

- **Sideways/ranging markets** with clear support and resistance
- When you expect price to oscillate within a range
- Markets with sufficient liquidity for limit orders
- When you want to profit from volatility without directional bias

> [!CAUTION]
> Grid strategies can accumulate losses if the price breaks out of the range in one direction: below it, the grid has spent its currency on the asset and holds it as the price falls; above it, the grid has sold its asset and misses the rise. GridBot never moves its grid and has no stop-loss, and it trades all the free balances of its pair: give it only the account you mean it to trade, and stop it yourself when the price leaves the range for good. Stopping Gekko leaves the grid's orders on the exchange: cancel them there.

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

`src/strategies/debug/` holds five more strategies, which the end-to-end tests run, and which `config/realtime-screener.yml` and `config/realtime-supervision.yml` select (DebugAdvice) to show their alerts. They are test fixtures, not trading strategies: each orders a fixed amount, 1 unit of the asset (DebugBacktest all-in instead when its `allIn` is set, DebugOrderScript the amount its block gives each order), on a fixed calendar of candles counted from 0 for the first candle after the warmup. They track no position, unlike the strategies above: a SELL is advised whether the asset is held or not, it is refused when it is not, and each refusal counts towards `maxConsecutiveErrors`. Their parameters are checked at start-up as the others' are.

| Strategy            | Orders                                                                                                                                                                        | Parameters                                                                                                                                                                                                                                                                                   |
|---------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `DebugAdvice`       | A STICKY order of 1 on every watched pair, every `each` candles from candle `wait`: a SELL first, then a BUY, and so on                                                       | `each` (integer ≥ 1, required: 1 advises on every candle), `wait` (integer ≥ 0, default 0), `cancelAfter` (integer ≥ 0, optional: cancels each order that many candles later, 0 acting as 1)                                                                                                 |
| `DebugBacktest`     | A BUY, then a MARKET SELL, of 1 on every watched pair, or all-in when `allIn` is set, on the candles listed: a MARKET BUY, or a LIMIT BUY at `buyLimitPrice` when it is set   | `buyCandleIndex` and `sellCandleIndex` (a candle index or a list of them, from 0, required); `buyLimitPrice` (a price above 0, optional: every BUY is sent as a LIMIT order at it); `allIn` (a boolean, optional: every order is sent without an amount, for the Trader to size)             |
| `DebugOrderScript`  | The orders its block lists, on the first watched pair, each on its candle with its side, type, amount and price, and canceled `cancelAfter` candles later unless it has ended | `orders` (a list of at least one, required), each with `candle` (integer ≥ 0), `side` (`BUY` or `SELL`), `type` (`MARKET`, `STICKY` or `LIMIT`), `amount` (above 0, default 1), `price` (above 0, optional: the last price of the pair without it) and `cancelAfter` (integer ≥ 1, optional) |
| `DebugRealtime`     | A MARKET BUY of 1 on every watched pair on the first candle, a MARKET SELL on the second                                                                                      | none                                                                                                                                                                                                                                                                                         |
| `DebugTrailingStop` | One MARKET BUY of 1 on the first watched pair, with a trailing stop, on candle `wait`                                                                                         | `wait` (integer ≥ 0, default 0), `trigger` (number > 0, optional: without it the stop is active at once), `percentage` (above 0 and below 100, required)                                                                                                                                     |

`waittime`, which older DebugAdvice blocks carry, is not one of its parameters: Gekko refuses it at start-up, as any unknown key. The block the shipped configurations use:

```yaml
strategy:
  name: DebugAdvice
  each: 2 # one advice every 2 candles: a SELL, then a BUY, and so on
  wait: 0 # candles to let go by before the first advice
```
