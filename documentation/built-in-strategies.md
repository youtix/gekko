# Built-in Strategies

Gekko comes with a variety of pre-built trading strategies that you can use right out of the box. Each strategy is designed with different market conditions and trading styles in mind.

You pick a strategy with the TradingAdvisor's `strategyName` and give its parameters directly under the top-level `strategy:` block, whose `name` must equal `strategyName` (see the [TradingAdvisor](./plugins.md#-tradingadvisor)). The seven signal strategies wait for each of their orders to end before they advise again on its pair, and GridBot re-arms a level only once that level's order has ended: run them with a [Trader](./plugins.md#-trader), for alerts only too. On `paper-binance` (realtime) and `dummy-cex` (backtest), the Trader only simulates the orders.

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

The rules these eight strategies share (their parameters checked at start-up, the pairs they trade and the currency each BUY takes, the position the signal strategies hold and the warmup they need) come first, under [Common Rules](#common-rules). The six strategies of `packages/strategies/src/debug/`, test fixtures, one of which two shipped configurations use, are described at the end, under [Debug Strategies](#debug-strategies).

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

### Pairs and Capital

The seven signal strategies trade every pair of `watch.assets`, each against `watch.currency`: one set of indicators and one position per pair, the signals of each pair as the strategy's section describes them, whatever the other pairs do. No parameter selects the pairs: `watch.assets` does, so watch one asset to trade one pair. They used to trade the first pair alone and warn of the others, as GridBot still does (see below): a configuration that watches several assets to trade the first now trades them all.

With several pairs watched, a line at the `info` level names them at start-up, with the way they share the currency:

```
Trading BTC/USDT, ETH/USDT and SOL/USDT: each BUY takes an equal share of the free currency among the pairs not invested, each SELL sells all of its asset
```

**Each BUY takes a share of the currency.** A BUY takes an equal share of the free currency among the pairs not invested, which it carries as an `allocation`, the percentage of the free currency the Trader sizes it from (see the Trader's [Sizing](./plugins.md#sizing)). With n pairs not long, the pair buying among them, the share is 100 / n %, rounded down to 6 decimals: 50 % with two, 33.333333 % with three, 25 % with four. Rounded down, the shares of one candle never add up to more than the currency: three of 33.333333 % leave a millionth of a percent of it unspent, less than any order's dust. When the pair buying is the only one not invested, the last of several to enter or a pair watched alone, its BUY is all-in, without an `allocation`, as a strategy watching one pair has always sent it. A pair whose BUY is pending counts as not invested, so that two BUYs of one candle, which the Trader sizes from the same balance read, each take their exact share; a pair whose SELL is pending is still invested. A SELL is all-in on its pair: it sells all of the pair's asset free, and the currency it brings in is shared by the next BUYs.

For instance, with 1000 USDT and four pairs flat, two BUY signals on one candle send two BUYs of 25 %, each sized from 250 USDT of the same balance read, 5 % of it kept back for the fee; once both have filled, a third pair's BUY takes 50 % of the currency left, and the fourth, the last not invested, buys all-in with what remains. A share is of the currency free at the Trader's last synchronization plus what the Trader's own BUYs still open at that read held of it, the part they filled included (see [Order Parameters](./custom-strategies.md#order-parameters)): a STICKY BUY still resting at a synchronization, which holds its currency by then, reserved or spent on its fills, takes nothing from the share of the next pair, which comes out as it would have on the candle of the first, up to what the exchange holds beyond the BUY's amount at the price it was created with (the maker fee the simulated exchange holds beside it, the moves of a STICKY BUY above that price).

**On several pairs, a share too small for the market is not sent.** Before it sends a BUY, the strategy works out what the market would take: its pair's share of the currency in its portfolio (the currency free plus, while the BUY of another pair rests, what the exchange holds for the orders open, as the Trader counts what its own open BUYs hold, see [Order Parameters](./custom-strategies.md#order-parameters); all of the currency free for the last pair's all-in BUY), less the 5 % kept back for the fee, then the amount that buys at the close (at the order's own price when it gives one, a `LIMIT` order's), truncated to the amount step of the market as the exchange takes it. When that cost is below the minimum cost of the market (`cost.min`), or the amount is below the market's minimum amount (`amount.min`), or worth less than the minimum cost once truncated, the BUY is skipped: nothing is sent, so nothing is refused and nothing counts towards `maxConsecutiveErrors`. A warning names the pair, the share, the currency free, the cost and the minimum:

```
[ETH/USDT] BUY skipped: 50 % of the 18 USDT free, 8.55 USDT once 5 % is kept back for the fee, is below the minimum cost of 10 USDT of the market: watch fewer pairs or fund the account; the next skips of this pair are logged at debug level until a BUY of it is placed
```

The line of the last pair's all-in BUY reads `all of the 9 USDT free` where a share reads `50 % of the 18 USDT free`, and advises only to `fund the account`. When the cost passes but the amount the step leaves does not, the line names that amount, the price and the step: `[BTC/USDT] BUY skipped: 50 % of the 12 USDT free, 5.7 USDT once 5 % is kept back for the fee, 0.00005 BTC at 97654.32 once truncated to the amount step 0.00001 of the market, a cost of 4.882716 USDT, is below the minimum cost of 5 USDT of the market: …`, or, for the minimum amount, `[BTC/USDT] BUY skipped: 50 % of the 12 USDT free, 5.7 USDT once 5 % is kept back for the fee, 0.00057 BTC at 10000 once truncated to the amount step 0.00001 of the market, is below the minimum amount of 0.001 BTC of the market: …`. While the BUY of another pair rests, the share names the currency it is of as the Trader does: `[ETH/USDT] BUY skipped: 50 % of 30 USDT: 15.75 USDT free at the last synchronization, plus 14.25 USDT held by the BUYs open then, 14.25 USDT once 5 % is kept back for the fee, is below the minimum cost of 15 USDT of the market: …`.

The first skip of a pair is a warning; its next skips are logged at the `debug` level, the same line without its end, and once a BUY of the pair has been placed, its next skip is a warning again. A skipped BUY is treated as a refused one, without the refusal: DEMA, MACD, RSI and CCI wait for the next trend, SMACrossover for the next crossover, while TMA and EMARibbon ask for it again on every candle of their signal, each ask skipped at the `debug` level. A skipped BUY leaves only the book's line: DEMA, SMACrossover and TMA log their advice (`[BTC/USDT] Executing long advice due to detected uptrend: 10/5/2`, at the `info` level, which the EventSubscriber relays to its `strat_info` subscribers) only once the BUY is placed, and the four others log no advice line of their own. A BUY skipped while the portfolio shows enough of its pair's asset free to sell at the close makes the strategy long on the pair instead, without the warning, at the `info` level (`[BTC/USDT] BUY skipped: 50 % of the 8 USDT free, 3.8 USDT once 5 % is kept back for the fee, is below the minimum cost of 5 USDT of the market, but 0.002 BTC is free in the portfolio, enough to sell: the strategy is long`): it sells that holding at its next SELL signal (see [Position and Orders](#position-and-orders)). A market without a minimum cost or amount skips nothing, nor does a portfolio that does not list the currency: the BUY is then sent, for the Trader to size and the exchange to take or refuse.

A strategy watching one pair skips nothing: its all-in BUY is sent as it always was, and refused when the currency is too little, which is how it learns of a holding present at start-up and how an account that can neither buy nor sell stops Gekko (see [Position and Orders](#position-and-orders)). When the market refuses that BUY for one of its minimums, its amount or its cost once truncated to the amount step, the Trader says so before it sends it (`[<id>] All-in BUY MARKET order sized from 5.5 USDT: 0.0000870833333333333 BTC at 60000 sent, truncated to 0.00008 BTC on the amount step 0.00001 of the market, a cost of 4.8 USDT once 5 % is kept back for the fee, below the minimum cost of 5 USDT on BTC/USDT, which the market refuses at that price`).

**Lines named by their pair.** Every line a signal strategy logs about a pair starts with that pair in brackets: `[BTC/USDT] SMA crossed DOWN price (9950.00000 < 10000.00000) => BUY`, `[ETH/USDT] Initial state: price below SMA`, `[BTC/USDT] Executing long advice due to detected uptrend: @ …`. A line about an order names it by its id instead (`[<id>] …`, see [Position and Orders](#position-and-orders)).

**The candles of every pair, every minute.** Every watched pair's candles are required every minute: a missing one stops a backtest, and a pair that stops delivering stops a realtime run.

**GridBot trades one pair**, the first of `watch.assets`, with `watch.currency`. With several assets watched, it says so once at start-up, at the `warn` level:

```
The strategy trades BTC/USDT only, the first pair watched (watch.assets): it ignores ETH/USDT, whose candles are still required every minute
```

The other pairs are not traded, but their candles are still required every minute. To grid another pair, put its asset first in `watch.assets`, or watch it alone.

**Either analyzer reports on a run of several pairs.** The [RoundTripAnalyzer](./plugins.md#roundtripanalyzer) follows the round trips of each pair apart, each one's P&L from its own fills, and reports on every pair together, with each pair's figures beside; the [PortfolioAnalyzer](./plugins.md#portfolioanalyzer) values the whole portfolio at every timeframe candle. Both measure the market return on one asset, the benchmark: BTC when it is watched, otherwise the first asset of `watch.assets`, unless their `benchmarkAsset` option names another watched asset.

### Position and Orders

The seven signal strategies, all but GridBot (which keeps a grid of orders instead), hold one position per pair, all in: on each pair, they are either flat or long. They follow the same rules, pair by pair:

- Their orders carry no amount. A BUY carries its pair's share of the free currency as an `allocation`, or nothing when its pair is the only one not invested (see [Pairs and Capital](#pairs-and-capital)): the Trader sizes it from that share, or from all the free currency, with 5 % kept back for the fee. A SELL is all-in on its pair: the Trader sizes it from the free asset. They are `STICKY` orders, `MARKET` ones for SMACrossover (see the Trader's [Order Types](./plugins.md#order-types)).
- They start flat on every pair. On each pair, they buy only when flat and sell only when long, and never while an order of their own on that pair is pending: an order pending on one pair does not hold back the others.
- The Trader ends each order with one of three events: completed, canceled or errored, a refusal included. A completed BUY makes the strategy long on its pair. After a completed SELL, which carries no amount, the strategy reads its position from the free balance of the asset in the portfolio after it: flat, unless what is left is enough to sell (as below), as after a SELL the Trader capped at the most the market takes in one order, or when the account received some of the asset after the Trader last read its balance (a deposit, a trade made by hand or by another bot). The strategy is then still long, and sells what is left at its next SELL signal.
- A canceled or errored order may have executed before it ended, in part or in full. The strategy then reads its position on the order's pair from what the event reports: what a canceled BUY bought, otherwise the free balance of the asset in the portfolio read after the order, for a SELL canceled after a fill too, whose fill tells what is left of the order, not of the holding (a SELL capped at the most the market takes in one order sells part of it), but never less than what that SELL left unsold, which the cancelation released: a portfolio read before the cancelation, or never read, leaves it out. It is long when that amount is enough to sell (at least the market's minimum amount and cost, once truncated to its amount step), flat otherwise, and stays as it was when the event reports neither. A position read this way that differs from the one held before is logged at the `info` level, for instance `[<id>] BUY order errored: 10 BTC free in the portfolio after it, enough to sell: the strategy is long`.

Each section says what becomes of a signal the position does not allow, and of an order that is canceled or refused. A custom strategy can keep the same bookkeeping, on one pair or on every pair: see [Tracking Your Position](./custom-strategies.md#tracking-your-position).

**An account that holds an asset at start-up.** The strategy still starts flat on its pair, so the first signal it acts on there is a BUY. With enough currency the BUY goes through, and the next SELL signal sells everything held. With too little, the BUY is refused; the strategy then takes the free balance of the asset, in the portfolio after the refusal, as its position, and sells it at its next SELL signal. On several pairs, a BUY too small for the market is skipped instead, never sent (see [Pairs and Capital](#pairs-and-capital)): the strategy then takes the free balance of the asset, in its portfolio, as its position when it is enough to sell, and sells it at its next SELL signal; a holding too small to sell leaves it flat.

**An account that can neither buy nor sell.** With too little currency to buy and no sellable amount of the asset, every BUY is refused. TMA and EMARibbon place it again on every candle of their signal, the others once per trend (DEMA, MACD, RSI, CCI) or per crossover (SMACrossover), until `maxConsecutiveErrors` errored orders in a row (a TradingAdvisor option, 5 by default) stop Gekko, with exit code 0: `Max consecutive order errors reached (5)`. The errored orders of every pair count together, and a completed or canceled order of any pair resets the count. On several pairs, a BUY too small for the market, its minimum cost or its minimum amount once the amount step is applied, is skipped rather than refused (see [Pairs and Capital](#pairs-and-capital)): it sends no order, so it is no error and does not count towards `maxConsecutiveErrors`, and the run goes on, the pair trading nothing while its BUYs are skipped.

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

The SMACrossover strategy is a classic crossover strategy that generates signals when the close crosses the **Simple Moving Average**. It uses **MARKET orders** for immediate execution.

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

1. Calculates, on each watched pair, the RSI of `src` for the configured period, between 0 and 100
2. A **low trend** (oversold) starts once the RSI is below the **low threshold**, a **high trend** (overbought) once it is above the **high threshold**. A trend lasts until the RSI crosses the other threshold: candles between the two thresholds neither end it nor count towards its persistence
3. When flat, once the low trend has counted `persistence` candles below the low threshold → **BUY**
4. When long, once the high trend has counted `persistence` candles above the high threshold → **SELL**
5. A persistence of 0 or 1 advises on the trend's first candle. The candles counted need not follow each other: with a persistence of 3, three one-candle dips under the low threshold, separated by candles between the thresholds, buy on the third
6. One advice per trend: the strategy starts flat and advises nothing on a pair while one of its orders is pending there, and a trend the position does not allow yet is advised on its next candle past the threshold once it does: a BUY that fills during a high trend is sold on the next candle of that trend above the high threshold. An order canceled or refused counts as its trend's advice, and so does a BUY skipped as too small for the market (on several pairs, see [Pairs and Capital](#pairs-and-capital)): the next order waits for the next trend, once the RSI has crossed the other threshold

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
2. **Start**: On the first candle after the warmup, centres the grid on its close, turns an `atr` spacing into a step from the ATR of the pair, and checks the grid against the market (see [When the Grid Starts](#when-the-grid-starts), [Spacing Types Explained](#spacing-types-explained) and [Prices and Checks](#prices-and-checks))
3. **Rebalancing**: Rebalances the portfolio so that it funds every level of the grid with the same quantity, which is not a 50/50 split (see [Rebalancing](#rebalancing))
4. **Grid Building**: Places buy orders below and sell orders above the center price, all for the same quantity, as far as the free balances fund orders the market takes (see [Grid Building](#grid-building))
5. **Order Management**: Each level trades back and forth between two adjacent prices of the grid: once its BUY fills it sells one step above, once its SELL fills it buys one step below (see [Order Management](#order-management))
6. **Range Monitoring**: Warns once when the price leaves the grid's range, the grid staying in place unless a reset is configured (see [Range Monitoring](#range-monitoring))
7. **Grid Reset**: Off by default. With `resetMode`, once `resetConfirmCandles` timeframe candles in a row have closed out of the range on a side it arms, cancels the grid's orders, then rebalances the portfolio and builds a new grid around the price, as at the start (see [Grid Reset](#grid-reset))

#### Key Features

- **Automatic Rebalancing**: Splits the portfolio the way the grid uses it before building the grid, so that little capital sits idle
- **Four Spacing Types**: Fixed, percent, logarithmic, or `atr`, a step that follows the volatility of the pair (its ATR) when the grid starts and at each reset
- **Orders the Market Takes**: Every order is at least the market's minimum order: a small account gets fewer levels rather than refused orders
- **Error Recovery**: A refused or canceled order is placed again up to `retryOnError` times, and an order whose outcome is unknown is never placed twice
- **Range Warnings**: One warning when the price leaves the grid, one line when it is back
- **Grid Reset**: Off by default: the grid moves to the price once it has closed out of its range for `resetConfirmCandles` candles in a row, at the cost of realizing the loss of the breakout

#### Parameters

| Parameter              | Type                                       | Required | Default | Description                                                                                                                                                       |
|------------------------|--------------------------------------------|----------|---------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `buyLevels`            | integer ≥ 0                                | Yes      | —       | Number of buy levels below center price; the lowest must stay above 0 (see *Lowest buy level*)                                                                    |
| `sellLevels`           | integer ≥ 0                                | Yes      | —       | Number of sell levels above center price; `buyLevels` and `sellLevels` cannot both be 0                                                                           |
| `spacingType`          | `percent`, `fixed`, `logarithmic` or `atr` | Yes      | —       | How levels are spaced                                                                                                                                             |
| `spacingValue`         | number > 0                                 | Yes      | —       | Distance between adjacent prices (see below)                                                                                                                      |
| `retryOnError`         | integer ≥ 1                                | No       | `3`     | Times a refused or canceled order is placed again before it is given up; also the orders of unknown outcome tolerated (see [Order Management](#order-management)) |
| `atrPeriod`            | integer ≥ 1                                | No       | `14`    | Period of the ATR an `atr` spacing reads, in timeframe candles (see [When the Grid Starts](#when-the-grid-starts))                                                |
| `resetMode`            | `none`, `up`, `down` or `both`             | No       | `none`  | When the grid is reset around the price: never, on a close above the grid, below it, or either way (see [Grid Reset](#grid-reset))                                |
| `resetConfirmCandles`  | integer ≥ 1                                | No       | `1`     | Timeframe candles in a row that close out of the grid on an armed side before the reset                                                                           |
| `resetCooldownCandles` | integer ≥ 0                                | No       | `0`     | Timeframe candles after a reset's new grid during which a close out of it does not count towards another reset                                                    |

`atrPeriod` is read with `atr` spacing only, and `resetConfirmCandles` and `resetCooldownCandles` with a `resetMode` other than `none`: given otherwise, they are accepted and ignored.

#### Spacing Types Explained

`spacingValue` sets the distance between two adjacent prices of the grid, the center price included:

| Type          | `spacingValue` Meaning                 | Example                                                             |
|---------------|----------------------------------------|---------------------------------------------------------------------|
| `percent`     | Percent of the center price            | `1` = prices 1 % of the center price apart: 99, 100, 101 around 100 |
| `fixed`       | Price units                            | `500` = prices $500 apart                                           |
| `logarithmic` | Ratio between adjacent prices, minus 1 | `0.01` = each price 1 % above the one below it                      |
| `atr`         | Multiple of the ATR                    | `1.5` = prices 1.5 × the ATR apart: 480 apart with an ATR of 320    |

`percent` spacing is arithmetic, as `fixed` spacing is: each level is `spacingValue` % **of the center price** away from its neighbour, not `spacingValue` % of the neighbour itself. Measured against the prices themselves, the levels are therefore wider at the bottom of the grid than at the top: `10` around 100 places the prices at 50, 60, … 150, so that 50 → 60 is +20 % while 140 → 150 is +7 %. For the same percentage between every two adjacent prices, use `logarithmic` spacing.

`atr` spacing follows the volatility of the pair. When the grid starts, and again at each [reset](#grid-reset), GridBot multiplies `spacingValue` by the [ATR](./indicators.md#atr--average-true-range) of the pair (its Average True Range, of period `atrPeriod` on the timeframe candles) on the last timeframe candle, and rounds the product to the market's price tick at the center price, the nearest tick, a half tick rounding up. The grid is then a `fixed` grid of that step: its prices, bounds, rebalance and quantity are those of a `fixed` grid, and the step stays as it is while the grid trades, whatever the ATR does. On a 5/5 grid at 60000, on a tick of 0.01, `spacingValue: 1.5` and an ATR of 320.0714 give a step of 480.11.

A step too narrow to pay the fees is raised. A level loses money when it sells less than 2 × fee / (1 − fee) above its buy, paying the maker fee (`fee.maker`) on both, and at a fixed step the highest level, whose buy price is the largest, earns the least: the step is raised to the smallest one at which that level breaks even, rounded up to the price tick, and to one tick at least, the floor on a market without a fee. On that grid with a 0.1 % maker fee, the minimum step is 121.09 (119.89 for a grid without sell levels), and an ATR of 40, a step of 60, is raised to it, with a warning logged at the `warn` level each time the step is resolved:

```
GridBot: ATR spacing: spacingValue 1.5 × ATR 40 is a step of 60 on the price tick 0.01, under 121.09, the minimum step at which every level of the grid breaks even on the maker fee of 0.001 (fee.maker): the grid is spaced by 121.09 instead
```

On a market without a maker fee, only a step that rounds to 0 is raised, to one tick: `GridBot: ATR spacing: spacingValue 1.5 × ATR 0.002 is a step of 0 on the price tick 0.01, under the price tick: the grid is spaced by one tick, 0.01, instead`. It is raised to one tick as well where no step breaks even, at a maker fee of 1 or more, or with so many sell levels that the highest one loses money whatever the step (from 501 at a 0.1 % maker fee, 500 × 0.2002 % being over 100 %), its warning ending `…, instead; no step breaks even on the maker fee of 0.001 (fee.maker) with 501 sell levels`, and the warning of a spacing under the round-trip fee follows (see [Prices and Checks](#prices-and-checks)). On a market whose tick depends on the price (Hyperliquid's 5 significant digits), the step is also checked on the prices the orders are placed at, rounded to the coarser tick above the next power of ten, and raised to a whole number of that tick until every level breaks even: 9 for 2 sell levels around 9999 at a 0.04 % maker fee, where 8.1 put the highest SELL at 10015, only 8 above its BUY at 10007. A step above that minimum is checked the same way, and raised to a whole number of the coarser tick when a level would lose money there, with a warning of its own: around 9940 with 8 sell levels at a 0.04 % maker fee, an ATR of 8.3 puts the highest SELL at 10006, only 7.9 above its BUY at 9998.1, and the grid is spaced by 9:

```
GridBot: ATR spacing: spacingValue 1 × ATR 8.3 is a step of 8.3 on the price tick 0.1, at which a level of the grid loses money on the maker fee of 0.0004 (fee.maker) on the price tick 1 at the top of the grid: the grid is spaced by 9 instead
```

An `atr` grid goes through the checks of [Prices and Checks](#prices-and-checks) as any other grid, and their messages name its step and where it comes from, `a step of 480.11 (spacingValue 1.5 × ATR 320.071, atr)`, or `a step of 121.09 (the minimum step, spacingValue 1.5 × ATR 40 giving 60, atr)` once raised to the minimum, or `a step of 9 (spacingValue 1 × ATR 8.3 giving 8.3, raised on the price tick 1, atr)` once raised on the coarser tick, where they name a configured spacing as it is configured, `spacingValue 1 (percent)`.

#### When the Grid Starts

GridBot places nothing during the warmup: the grid starts on the first candle after it, centred on that candle's close. With `percent`, `fixed` or `logarithmic` spacing, it uses no indicator. In a backtest, `watch.warmup.candleCount` then only delays the grid by that many timeframe candles: set it to 0 for the grid to start on the close of the first timeframe candle of `watch.daterange`. In realtime, the grid, or the rebalance that precedes it, goes out when the timeframe candle in progress at start-up closes, whatever `candleCount`: within one timeframe, a minute with `1m` and up to a day with `1d`. A longer warmup only costs history fetches.

With `atr` spacing, the grid needs the ATR on that first candle. The ATR of `atrPeriod` candles has its first value on its `atrPeriod + 1`-th timeframe candle, the true range starting on the second, and the first candle after the warmup is the `candleCount + 1`-th: set `watch.warmup.candleCount` to `atrPeriod` or more, 14 with the default period. In a backtest, the warmup candles are the first timeframe candles of `watch.daterange`, so the grid starts on the close of its `candleCount + 1`-th; in realtime, they are history fetched at start-up, and the grid goes out when the candle in progress at start-up closes, as with the other spacings. With a shorter warmup, the run stops on the first candle after it, before any order (exit code 1):

```
GridBot: The ATR has no value yet on the first candle after the warmup: with atrPeriod 14 it needs 15 timeframe candles, the warmup's and the first after it, so set watch.warmup.candleCount to 14 or more
```

#### Prices and Checks

The grid's prices are rounded to the market's price tick (`precision.price`) as they are written, a half tick rounding up: `fixed` and `percent` spacings are computed in decimal, `logarithmic` spacing in binary. A market that states no tick is priced to 8 decimals, with a warning when the grid starts; the dummy-cex configuration always states one (`precision.price`, in decimals).

On a market whose tick depends on the price, Hyperliquid, which takes 5 significant digits in a price (`precision.priceSignificantDigits`, an integer part of more digits being kept whole), each price is rounded to the tick at that price where it is coarser than `precision.price`: one unit of its fifth significant digit, 0.1 from 1000 and 1 from 10000 on. `precision.price` is only the tick at the price the markets were loaded at: a market loaded at 9990 states 0.1, while the exchange takes whole units from 10000 on. So the grid's prices are those the exchange takes as they are: there, a close of 10000.37 centres a grid spaced by 1 (`fixed`) on 10000, its SELLs at 10001 and 10002, where rounded to 0.1 they were 10001.4 and 10002.4, which the exchange takes as 10001 and 10002. A backtest rehearses the rule when its dummy-cex market data states `precision.priceSignificantDigits` (5, as on Hyperliquid): the simulator then rounds the price of every order the same way.

Besides the checks of its parameters at start-up (see [Parameters Are Checked at Start-up](#parameters-are-checked-at-start-up)), GridBot checks the grid against the market when it starts, before any order, and again at each [reset](#grid-reset), stopping the run (exit code 1) when:

- the lowest buy level would be at or below 0, once rounded to the tick: with `percent` spacing, `buyLevels × spacingValue` must stay under 100 (see *Lowest buy level*);
- the center price is outside the exchange's price limits (`price.min`, `price.max`);
- two adjacent prices of the grid round to the same tick (see *Minimum spacing*).

The first and the last checks run again around the price a rebalance ended at (see *Lowest buy level* and *Minimum spacing*).

**Lowest buy level.** The lowest buy level must stay above 0 around every price the grid is centred on. It is checked when the grid starts or is reset, and again around the price a rebalance ended at, where the grid is planned again (after a failed rebalance) or built (once it filled). A grid whose lowest buy level would be at or below 0 there stops the run with the error of the start, naming the price the grid would be built around, for example `GridBot: Grid configuration would result in non-positive buy prices: the lowest of buyLevels 2, spaced by spacingValue 5 (fixed) below the center price 9, would be at -1`. No grid order is sent, and the rebalance already filled is not undone. With `fixed` spacing, keep `buyLevels × spacingValue` well under the price: a grid started with its lowest buy level a few ticks above 0 is refused once a rebalance ends a few ticks lower. An `atr` grid, whose step is fixed too, meets it once `buyLevels` steps reach the price, which the ATR of a sharp fall can make them do at a reset. `percent` and `logarithmic` grids, whose levels scale with the price, meet it only when their lowest buy level rounds to 0 on the tick, after a much larger fall.

**Minimum spacing.** Once rounded to the market's price tick, adjacent prices of the grid must stay at least one tick apart. A spacing that rounds two of them to the same price, a level that would buy and sell at that one price, stops the run when the grid starts or is reset, again before a failed rebalance is placed again around the price it ended at, so that no second rebalance is paid for a grid that would then be refused, and when the grid is built around the price a rebalance ended at (a `percent` or `logarithmic` step shrinks with the price). The first two check the grid as configured, the last the levels the free balances fund:

```
GridBot: Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.001 (percent) around the center price 100, two adjacent prices of the grid would both round to 100 at the price tick 0.01
```

On a market whose tick depends on the price, the tick is the one at each price, and the error names the rule where its tick, coarser than `precision.price`, merged two prices. On Hyperliquid loaded at 9990, a grid spaced by 0.5 (`fixed`) around 9999 with 2 buy and 4 sell levels keeps 10000.5 and 10001 a tick of 0.1 apart, but the exchange takes both as 10001:

```
GridBot: Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.5 (fixed) around the center price 9999, two adjacent prices of the grid would both round to 10001 at the price tick 1, the market taking 5 significant digits in a price (precision.priceSignificantDigits)
```

A spacing whose levels earn less than the two maker fees of a round trip (`fee.maker`), a SELL less than 2 × fee / (1 − fee) above its BUY (0.08003 % at a 0.04 % fee, 0.2002 % at 0.1 %), is accepted with one warning, logged at the `warn` level each time a grid is built, at the start and at each reset, on the levels built around the price they are built at: such a grid loses money at each round trip. After a rebalance, that price is the one the rebalance ended at, where a step that breaks even around the price the grid was placed at can leave its top level under the fee: an `atr` step on its minimum, after the BUY rebalance of a breakout upwards, is warned of there. For a 5/5 grid at 60000 with a 0.1 % maker fee and a tick of 0.01, no level loses with a spacing of 121.09 or more with `fixed` spacing (121.08 loses on the highest level, and 100 on all ten, as below), 0.2019 or more with `percent` and 0.002003 or more with `logarithmic`. An `atr` step is raised to that minimum (see [Spacing Types Explained](#spacing-types-explained)):

```
GridBot: spacingValue 100 (fixed) is under the round-trip fee: a level that sells less than 0.2002 % above its buy, paying the maker fee of 0.001 (fee.maker) on its BUY and on its SELL, loses money at each round trip, 10 out of 10 here, the narrowest selling at 60500, 0.1656 % above its buy at 60400
```

#### Rebalancing

Every level of the grid trades the same quantity. For a quantity `q`, the SELLs need `sellLevels × q` of the asset, and the BUYs need the sum of their prices × `q` of the currency, plus the maker fee (`fee.maker`), which the simulator of backtests and paper trading charges in currency on top of a BUY. The grid is sized on the free balances, rounded down to the market's amount step, so what one side holds beyond what the other side funds stays idle for the whole run.

Before building the grid, at the start and at each [reset](#grid-reset), GridBot therefore rebalances the free balances to that split with one STICKY order: it buys or sells the amount after which both sides fund the same quantity, the order's own price and fee included. Funds locked in other orders are left out, and reported once at the `info` level. The portfolio is not rebalanced when the grid would leave less than 1 % of its value idle, nor when the rebalance would be smaller than the market's minimum order (`amount.min`, or `cost.min` at the price of the STICKY order): the grid is then built on the balances as they are.

The split is not 50/50, since the BUYs, below the center price, cost less than the SELLs are worth. A symmetric grid holds a little more than half of its value in the asset, about 51 % for 5/5 levels spaced by 1 % and 56 % for 20/20 levels spaced by 2 %, and an asymmetric one about its share of sell levels, 76 % for 1 buy and 3 sell levels spaced by 5 at 100. A grid without sell levels is rebalanced all in currency, and one without buy levels all in the asset, buying what the currency pays once the fee is on top.

A rebalance refused or canceled is planned again on the balances it left, and placed again up to `retryOnError` times: once it has failed `retryOnError + 1` times, or as soon as its outcome is unknown (it may be live on the exchange), the run stops before any grid order is sent, for instance with `GridBot: Rebalance failed after 4 attempts (retryOnError: 3): the grid is not built. Last error: …`. Once the rebalance has filled, the grid is built around the price the rebalance ended at, the last price the Trader reports with the fill. Its orders reach the exchange with the next minute. In a backtest they go with the candle after the one the rebalance filled on, a strategy's reaction to an order event being sent with the following bucket; live, with the bucket that arrives after the fill, which delivers it before its hooks. If the market moved meanwhile, a BUY above it executes at once on an exchange, and in backtest at the next candle, at its own price.

Each failed attempt before the last is warned of with what follows it:

- `GridBot: Rebalance attempt 1 failed: … Retrying...` when the rebalance planned again is placed;
- `GridBot: Rebalance attempt 1 failed: … Not placed again: the free balances it left need no rebalance, the grid is built on them`, or `… Not placed again: the grid is built on the free balances it left` when they call for a rebalance the market would refuse or they cannot pay, followed by the line that says why;
- `GridBot: Rebalance attempt 1 failed: … Not placed again: the grid is refused around 9, the price it ended at` when the grid planned around that price fails the checks of the start (see [Prices and Checks](#prices-and-checks)), followed by the error that stops the run.

#### Grid Building

The grid places a LIMIT BUY on each buy level below the center price and a LIMIT SELL on each sell level above it, all for one quantity: the smaller of the free asset split over the sell levels and of the free currency split over the buy prices with the maker fee on top, rounded down to the market's amount step and capped by its maximum at the highest price of the grid. For instance, with no fee, a 2/2 grid spaced by 5 (`fixed`) around 100 needs, for each unit of quantity, 2 of the asset for its SELLs at 105 and 110, and 95 + 90 = 185 of the currency for its BUYs: 5 BTC and 462.5 USDT, its split, give 2.5 a level, with no rebalance. The first example configuration below, on the dummy-cex market data of `config/backtest.yml` (a 0.04 % maker fee), started at 61234.56 with 1000 USDT, rebalances with a STICKY BUY of 0.00828635 BTC, then trades 0.00165727 BTC a level.

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

During a [reset](#grid-reset), the orders the reset cancels are neither placed again nor followed by their opposite: each level is released as its order ends, filled, canceled or refused, and the new grid replaces it. An order whose outcome is unknown is still left untracked, and no new grid is built over it: the run stops once the orders the reset canceled have ended (see [Grid Reset](#grid-reset)).

#### Range Monitoring

The grid stays where it was built unless a reset moves it (see [Grid Reset](#grid-reset)). When a timeframe candle closes out of the grid's range, below its lowest price or above its highest, GridBot warns once, naming the price where the grid's orders wait: the grid's price next to the bound the price left, where the bottom level's SELL or the top level's BUY rests once the orders beyond have filled. Without a reset on that side (`resetMode: none`, the default, or a reset of the other side only), the warning reads:

```
GridBot: Price 111 is out of grid range [90, 110]: the grid stays in place, its orders waiting for the price to come back to 105
```

With a reset on that side, the warning says when the grid is reset, or, during the cooldown after a reset, how long the new grid stays in place (the second line: a grid rebuilt around 112, on the sixth candle of a cooldown of ten, see [Grid Reset](#grid-reset)):

```
GridBot: Price 111 is out of grid range [90, 110]: the grid is reset once 2 consecutive timeframe candles close above it (resetConfirmCandles), its orders waiting for the price to come back to 105 until then
GridBot: Price 123 is out of grid range [102, 122]: the grid stays in place for the 4 timeframe candles left of its cooldown (resetCooldownCandles 10), its orders waiting for the price to come back to 117
```

The candle that triggers a reset logs the reset's line instead of the warning: with `resetConfirmCandles: 1`, outside a cooldown, a close out on an armed side resets the grid without a warning. GridBot logs once at the `info` level when a close is back at the price where the orders wait or inside it (`GridBot: Price 105 is back in grid range [90, 110]`), not at every crossing of the bound itself, and warns again when a close is out on the other side. A one-sided grid has its center price for a bound, so a close beyond it on the empty side is out of range at once. When a fill leaves orders on one side of the grid only, GridBot warns once (`GridBot: Only one side of the grid remains active`), until a fill gives it both sides again.

#### Grid Reset

By default (`resetMode: none`), the grid stays where it was built, whatever the price does. With `resetMode`, GridBot builds a new grid around the price once the price has left the range on a side the mode arms: `up` above the grid, `down` below it, `both` on either side.

**When.** A timeframe candle that closes out of the range on an armed side, above the grid's highest price or below its lowest, counts towards a reset. A close at a bound or inside the range, or out on a side the mode does not arm, starts the count again, and a close out on the other armed side starts it again on that side. Once `resetConfirmCandles` candles in a row have counted, the grid is reset: with 1, the default, at the first close out of the range; with 2 or more, a single close out, such as a spike that comes straight back, passes without a reset. Each candle counted before the last is logged at the `debug` level:

```
GridBot: Price 111 closed above grid range [90, 110]: 1 of 2 consecutive timeframe candles towards a reset
```

Nothing is counted while the grid is rebalanced, at the start or at a reset, nor while a reset waits for the grid's orders to end. A one-sided grid has its center price for a bound on its empty side (see [Range Monitoring](#range-monitoring)), so a close beyond it there counts.

**What a reset does.** The reset is logged at the `info` level, numbered in the run (`reset 1`, `reset 2`, …), with the open orders it cancels. For the 2/2 grid spaced by 5 around 100 of [Grid Building](#grid-building), with `resetMode: up` and `resetConfirmCandles: 2`, whose two SELLs filled and turned to BUYs at 100 and 105 as the price rose, the second close above 110 reads:

```
GridBot: Price 112 closed above grid range [90, 110] for 2 consecutive timeframe candles (resetConfirmCandles): reset 1, its 4 open orders are canceled and a new grid is built around the price once they have ended
```

Then:

1. Every open order of the grid is canceled. Each level is released as its order ends, canceled, refused, or filled before its cancelation: none is placed again, and a fill does not turn its level to its other side, the new grid replacing every level. What a fill bought or sold is in the balances the new grid is built on.
2. Once no order of the grid is open, the new grid is built around the last price of the pair, the one the Trader reports with the end of the last order, exactly as at the start: an `atr` step is resolved again, from the ATR of the last timeframe candle; the checks of [Prices and Checks](#prices-and-checks) run around that price, stopping the run with the errors of the start; the free balances are rebalanced to the split the new grid needs (see [Rebalancing](#rebalancing)); and the grid is built around the price the rebalance ended at, or around the reset's price when none is needed, a spacing under the round-trip fee there warned of again, with the lines of the start (`GridBot: Rebalancing - BUY … (STICKY order)`, `GridBot: Rebalance complete, building grid`, `GridBot: Grid built around …`).
3. The `resetCooldownCandles` timeframe candles that follow the new grid, none by default, do not count towards another reset: a close out of the range during them is warned of with the candles left (see [Range Monitoring](#range-monitoring)), and the count starts after them (the candle that ends the cooldown is not counted either: a close out of the range on it is warned of with the tail `the grid is reset once … (resetConfirmCandles) …` of [Range Monitoring](#range-monitoring)).

In a backtest, the cancelations are heard in the candle that triggered the reset, and the rebalance, or the new grid when it needs none, goes out with the next candle; live, with the bucket that arrives after the last cancelation, which delivers it before its hooks. A grid order that the triggering candle itself fills, its high reaching the top SELL before the close, has ended before its cancel reaches the Trader, which warns `Impossible to cancel order` for it: the fill is heard as usual, and the new grid is built on the balances it left. Live, the same happens to an order that fills between its last poll and the cancel.

**Balances read before the reset.** The Trader reads the balances the new grid is built on once the last order has ended, best effort: when that read fails (live, `fetchBalance` failing its retries), the event carries the Trader's previous read, which may date from before the reset and still count what the canceled orders held as locked in other orders, left out of the new grid (see [Rebalancing](#rebalancing)). GridBot then builds the grid on the free balances all the same, a smaller grid, or stops the run for an insufficient portfolio, after a warning that gives the cause:

```
GridBot: The Trader could not read the balances after the cancels of reset 1, its last read predating the reset: what the canceled orders held may still count as locked in other orders, and the grid is built on the rest; a restart builds it on the balances as they are
```

A restart builds the grid on the balances as the exchange has them (see [Restarting](#restarting)).

**Orders of unknown outcome.** A grid order that errors during the reset while it may still be live on the exchange is no longer followed, as in [Order Management](#order-management). A new grid would trade beside such an order, so when the grid would be rebuilt, any order of unknown outcome of the run, left during the reset or before it, stops the run instead (exit code 1):

```
GridBot: BUY 2.5 at 95 may be live on the exchange without GridBot tracking it: the grid of reset 1 is not built over it. Check it on the exchange
```

One left during the reset is warned of as it errors, while other orders of the reset are still open: `GridBot: BUY 2.5 at 95 may be live on the exchange without GridBot tracking it: it is not placed again, and the grid of reset 1 is not built over it, the run stopping once the other orders the reset canceled have ended. Check it there. Last error: …`. When it was the last order open, the stop above comes at once, followed by `. Last error: …`, and once more than `retryOnError` orders are in that case, the run stops at once as in [Order Management](#order-management). Several orders are named in one list (`BUY 2.5 at 95 and SELL 2.5 at 105 may be live on the exchange without GridBot tracking them: …`).

An order of unknown outcome left before the reset makes that stop certain, so the line that starts the reset says so in place of the new grid, its open orders canceled all the same: `GridBot: Price 112 closed above grid range [90, 110] for 2 consecutive timeframe candles (resetConfirmCandles): reset 1, its 3 open orders are canceled, then the run stops: BUY 2.5 at 95 may be live on the exchange without GridBot tracking it, and no grid is built over it`, and the stop above follows once they have ended, at once when none is open (`…: reset 1, no order is open, and the run stops: …`).

**What a reset costs.** A reset trades at the price of the breakout. After a breakout above, the grid has sold its asset on the way up, and its rebalance buys back, higher, the asset the new grid sells; after a breakout below, the grid has bought on the way down, and its rebalance sells, lower, what the new grid does not need. Left in place, the grid would wait for the price to come back into its range, where those levels trade back; a reset realizes the loss of the breakout instead, and a trend that breaks each new grid in turn realizes it at every reset. This is why the reset is off by default, and why `resetConfirmCandles` and `resetCooldownCandles` bound it: the first asks a breakout to last before the grid follows it, the second spaces the resets a trend chains.

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
> Grid strategies can accumulate losses if the price breaks out of the range in one direction: below it, the grid has spent its currency on the asset and holds it as the price falls; above it, the grid has sold its asset and misses the rise. GridBot moves its grid only when `resetMode` says so, and a reset realizes the loss of the breakout (see [Grid Reset](#grid-reset)). It has no stop-loss, and it trades all the free balances of its pair: give it only the account you mean it to trade, and stop it yourself when the price leaves the range for good. Stopping Gekko leaves the grid's orders on the exchange: cancel them there.

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

`packages/strategies/src/debug/` holds six more strategies, which the end-to-end tests run, and which `config/realtime-screener.yml` and `config/realtime-supervision.yml` select (DebugAdvice) to show their alerts. They are test fixtures, not trading strategies: each orders a fixed amount, 1 unit of the asset (DebugBacktest instead all-in when its `allIn` is set, or by the `cost` or the `allocation` its block gives, for the Trader to size; DebugOrderScript the amount its block gives each order; DebugPositionBook as the signal strategies size theirs, a BUY its pair's share of the currency and a SELL all of its asset), on a fixed calendar of candles counted from 0 for the first candle after the warmup. All but DebugPositionBook track no position, unlike the strategies above: a SELL is advised whether the asset is held or not, it is refused when it is not, and each refusal counts towards `maxConsecutiveErrors`. DebugPositionBook keeps a position on each pair, as the signal strategies do (see [Pairs and Capital](#pairs-and-capital)), and skips a step the position of its pair does not allow. Their parameters are checked at start-up as the others' are.

| Strategy            | Orders                                                                                                                                                                                                            | Parameters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|---------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `DebugAdvice`       | A STICKY order of 1 on every watched pair, every `each` candles from candle `wait`: a SELL first, then a BUY, and so on                                                                                           | `each` (integer ≥ 1, required: 1 advises on every candle), `wait` (integer ≥ 0, default 0), `cancelAfter` (integer ≥ 0, optional: cancels each order that many candles later, 0 acting as 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DebugBacktest`     | A BUY, then a MARKET SELL, on every watched pair, on the candles listed: of 1, or all-in with `allIn`, or of the `cost` or the `allocation` given; a MARKET BUY, or a LIMIT BUY at `buyLimitPrice` when it is set | `buyCandleIndex` and `sellCandleIndex` (a candle index or a list of them, from 0, required); `buyLimitPrice` (a price above 0, optional: every BUY is sent as a LIMIT order at it); `allIn` (a boolean, optional: every order is sent without an amount, for the Trader to size); `cost` (a number above 0, in the currency, optional: every order is sent with that cost instead of an amount, what a BUY may spend, its 5 % fee buffer included, or the notional a SELL sells); `allocation` (a number above 0 and at most 100, optional: every order is sent with that share, in percent, of the balance the Trader read last, the currency for a BUY, the asset for a SELL, 100 being all-in). At most one of `allIn: true`, `cost` and `allocation`: two are refused at start-up. |
| `DebugOrderScript`  | The orders its block lists, on the first watched pair, each on its candle with its side, type, amount and price, and canceled `cancelAfter` candles later unless it has ended                                     | `orders` (a list of at least one, required), each with `candle` (integer ≥ 0), `side` (`BUY` or `SELL`), `type` (`MARKET`, `STICKY` or `LIMIT`), `amount` (above 0, default 1), `price` (above 0, optional: the last price of the pair without it) and `cancelAfter` (integer ≥ 1, optional)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DebugPositionBook` | On each step's candle, a MARKET BUY or SELL on each of its pairs (every watched pair without `symbols`) through the signal strategies' position book; a step the pair's position does not allow is skipped        | `steps` (a list of at least one, required), each with `candle` (integer ≥ 0), `side` (`BUY` or `SELL`) and `symbols` (a list of at least one pair, optional: every watched pair without it; a pair that is not watched is refused at start-up)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DebugRealtime`     | A MARKET BUY of 1 on every watched pair on the first candle, a MARKET SELL on the second                                                                                                                          | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DebugTrailingStop` | One MARKET BUY of 1 on the first watched pair, with a trailing stop, on candle `wait`                                                                                                                             | `wait` (integer ≥ 0, default 0), `trigger` (number > 0, optional: without it the stop is active at once), `percentage` (above 0 and below 100, required)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

DebugPositionBook logs each step it skips at the `info` level, naming the pair and why: `[BTC/USDT] BUY step of candle 3 skipped: the strategy is long`, `[ETH/USDT] SELL step of candle 4 skipped: the strategy is flat`, or `… an order is pending`, and a BUY the position book skips as too small for the market is said by the book's own line alone.

`waittime`, which older DebugAdvice blocks carry, is not one of its parameters: Gekko refuses it at start-up, as any unknown key. The block the shipped configurations use:

```yaml
strategy:
  name: DebugAdvice
  each: 2 # one advice every 2 candles: a SELL, then a BUY, and so on
  wait: 0 # candles to let go by before the first advice
```
