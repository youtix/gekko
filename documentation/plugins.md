# 🔌 Plugins

Plugins are the modular components that extend Gekko's functionality. Each plugin handles a specific aspect of the trading workflow — from running strategies to executing orders, analyzing performance, and sending notifications. This guide provides detailed documentation for all available plugins.

---

## Overview

| Plugin                  | Purpose                                              | Mode Availability           |
|-------------------------|------------------------------------------------------|-----------------------------|
| **TradingAdvisor**      | Runs your strategy and generates trading signals     | Backtest, Realtime          |
| **Trader**              | Executes orders on exchanges                         | Backtest, Realtime          |
| **RoundTripAnalyzer**   | Measures performance round trip by round trip        | Backtest, Realtime          |
| **PortfolioAnalyzer**   | Measures performance from the portfolio's value      | Backtest, Realtime          |
| **PerformanceReporter** | Exports backtest results to CSV files                | Backtest                    |
| **CandleWriter**        | Saves candle data to the database                    | Importer, Realtime          |
| **EventSubscriber**     | Sends trading events to Telegram                     | Realtime                    |
| **Supervision**         | System monitoring and Telegram bot commands          | Realtime                    |

> [!IMPORTANT]
> Each entry under `plugins:` may only hold the options listed for its plugin below. An option the plugin does not know, misspelt (`maxConsecutiveError`) or meant for another plugin, stops Gekko at start-up with an `Unrecognized key` error naming it, instead of being ignored while the default applies. The top level of the file and its `watch`, `exchange` and `storage` sections refuse unknown keys the same way. The `strategy` block, whose `name` must equal the TradingAdvisor's `strategyName`, is checked by the strategy's own schema, which every built-in strategy declares: when the TradingAdvisor creates the strategy, at start-up, an unknown, missing or invalid parameter stops Gekko with an `Invalid parameters for strategy <name> (strategy block)` error listing every issue. A strategy that declares no schema, as a custom one may, gets the whole block unchecked (an `info` line says so), so a misspelt parameter is simply `undefined` there.

---

## 📈 TradingAdvisor

**Purpose:** The TradingAdvisor is the central plugin that runs your trading strategy and generates buy/sell signals. It acts as the bridge between market data and your strategy logic.

### How It Works

1. At start-up, creates your strategy, checks its `strategy` block, and reads from the exchange the balance and the orders open on each watched pair, which the strategy's `init` receives as `portfolio` and `openOrders`
2. Receives 1-minute candles from the market data stream (the strategy's `init` runs on the first one)
3. Batches candles into your configured timeframe (e.g., 1h, 4h, 1d)
4. Passes timeframe candles to your strategy
5. Relays strategy signals (create order, cancel order) to other plugins: the Trader executes the orders
6. Manages the strategy warmup period

The orders open at start-up are read once, and the run does not follow them: the Trader follows only the orders the strategy creates. There are none in a backtest or on `paper-binance`, whose simulator starts without any. GridBot refuses to start while any order is open on its pair, whatever placed it (a previous run's grid, an order placed by hand or by another bot): cancel them on the exchange, then start Gekko again.

### Configuration

```yaml
plugins:
  - name: TradingAdvisor
    strategyName: RSI          # One of Gekko's strategies: a built-in one, or one exported from packages/strategies/src/custom/index.ts
    maxConsecutiveErrors: 5    # Optional: errored orders in a row that stop Gekko (at least 1, or -1: never)
```

A strategy of your own kept in a file outside the codebase is loaded from that file: `strategyPath` gives its path, and `strategyName` the name of the class it exports (see [Where Your Strategy Lives](./custom-strategies.md#where-your-strategy-lives)).

```yaml
plugins:
  - name: TradingAdvisor
    strategyName: MyStrategy                           # The class the file exports
    strategyPath: ./strategies/myStrategy.strategy.ts  # Absolute, or relative to the directory Gekko is started from
```

With a `strategyPath`, Gekko takes `strategyName` from that file only, never from its own strategies: a built-in name beside a path, such as `strategyName: RSI`, stops Gekko at start-up (`[TRADING ADVISOR] Cannot find external RSI strategy in <path>`) unless the file exports a class of that name, and so does a file it cannot import (`[TRADING ADVISOR] Cannot import the strategy file <path>: …`, with the reason).

### Configuration Reference

| Parameter              | Type     | Required | Default | Description                                                                                                   |
|------------------------|----------|----------|---------|---------------------------------------------------------------------------------------------------------------|
| `name`                 | string   | Yes      | —       | Must be `TradingAdvisor`                                                                                      |
| `strategyName`         | string   | Yes      | —       | The strategy to run: one of Gekko's, or the class a `strategyPath` file exports (see above)                   |
| `strategyPath`         | string   | No       | —       | Path of your own strategy file, absolute or relative to the directory Gekko is started from (see above)       |
| `maxConsecutiveErrors` | integer  | No       | `5`     | Errored orders in a row after which Gekko stops (exit code 0), at least `1`; `-1` never stops, `0` is refused |

The strategy's `onOrderErrored` still runs for the error that trips the circuit breaker, before Gekko stops.

### Events

**Listens to:**
- `OrderCompleted` — Notifies strategy when orders are filled, and gives its candle hooks the portfolio after the fill
- `OrderCanceled` — Notifies strategy when orders are canceled, and gives its candle hooks the portfolio after the cancelation
- `OrderErrored` — Notifies strategy when orders fail, and gives its candle hooks the portfolio after the error
- `PortfolioChange` — Updates strategy with current portfolio state

The candle hooks get the latest portfolio received, from the candle after it arrived: the balance the TradingAdvisor reads at start-up, then the one a `portfolioChange` or the end of an order carries. The end of an order carries the portfolio the Trader read after it, even when its `portfolioUpdates` filter holds back the `portfolioChange`.

**Emits:**
- `StrategyCreateOrder` — Signal to create a new order, which the Trader executes
- `StrategyCancelOrder` — Signal to cancel an existing order
- `StrategyInfo` — The strategy's log lines (`tools.log`) at the `info`, `warn` and `error` levels, whatever `GEKKO_LOG_LEVEL`; its `debug` lines are only printed. An `error` line is delivered at once, not with the other events of its minute, so the line that stops the bot reaches the EventSubscriber's `strat_info`
- `StrategyWarmupCompleted` — Indicates warmup period has ended
- `TimeframeCandle` — Batched candle for the configured timeframe, queued after the strategy's hooks of that candle, and so after the warmup event that candle completes

### Dependencies

- Requires **exchange** injection: the market data of the watched pairs, and the balance and the open orders it hands to the strategy at start-up
- Credentials only on a real exchange (`binance` or `hyperliquid`, their sandbox included), whose balance and open orders need them: `apiKey` and `secret` on binance, `walletAddress` on hyperliquid; `dummy-cex` and `paper-binance` need none. A failed read stops Gekko at start-up. On hyperliquid, Gekko refuses at start-up a realtime configuration with a TradingAdvisor but without `walletAddress`, or with a Trader but without `privateKey`, the key that signs its orders
- Requires a **Trader** as soon as the strategy creates orders (see below)

> [!IMPORTANT]
> The TradingAdvisor is required for any mode that involves running a strategy (backtest or realtime trading).

> [!IMPORTANT]
> Configure a **Trader** with it, for alerts only too. The Trader is the only plugin that executes the orders the strategy creates, and ends each one with `orderCompleted`, `orderCanceled` or `orderErrored`. Every built-in strategy waits for its order to end before it advises again: without a Trader, its first order never ends and it advises once per run on each pair. On `paper-binance` (realtime) and `dummy-cex` (backtest) the Trader only simulates the orders, from `simulationBalance`; `hyperliquid` has no paper exchange, so its Trader places them on the account, or on its testnet with `sandbox: true`. Without a Trader, Gekko warns at start-up (`warn` level, so set `GEKKO_LOG_LEVEL` to `warn` or `info` to see it): `TradingAdvisor emits strategyCreateOrder, but no configured plugin executes orders…`. Only a strategy that never creates orders can do without one.

---

## 💹 Trader

**Purpose:** The Trader plugin executes orders on exchanges. It bridges the gap between strategy signals and actual order placement — whether on a live exchange, sandbox, or simulated dummy exchange.

### How It Works

1. Receives order signals from the TradingAdvisor
2. Sizes each order from the balances it last read, and caps it (see [Sizing](#sizing)): the exchange checks it against the market's limits and the funds, and an order it refuses ends with `OrderErrored`
3. Submits orders to the configured exchange
4. Monitors order status and handles fills/cancellations
5. Emits portfolio updates after order execution

### Configuration

```yaml
plugins:
  - name: Trader
    portfolioUpdates:          # Optional: emit the portfolio only when it changes significantly
      threshold: 1             # Change of an asset quantity, in %
      dust: 10                 # Value in quote currency below which an asset is ignored
```

### Configuration Reference

| Parameter                    | Type       | Required                   | Default | Description                                                                                                                              |
|------------------------------|------------|----------------------------|---------|------------------------------------------------------------------------------------------------------------------------------------------|
| `name`                       | string     | Yes                        | —       | Must be `Trader`                                                                                                                         |
| `portfolioUpdates`           | object     | No                         | —       | Without it, the portfolio is emitted after every synchronization; the end of an order carries the portfolio after it whatever the filter |
| `portfolioUpdates.threshold` | number ≥ 0 | Yes, in `portfolioUpdates` | —       | Change of an asset quantity, in % (`1` for 1%), that emits the portfolio                                                                 |
| `portfolioUpdates.dust`      | number ≥ 0 | Yes, in `portfolioUpdates` | —       | Value in quote currency below which an asset is ignored                                                                                  |

### Events

**Listens to:**
- `StrategyCreateOrder` — Receives new order requests from strategy
- `StrategyCancelOrder` — Receives cancel requests from strategy
- `StrategyWarmupCompleted` — Synchronizes with the exchange, so that the strategy's first orders are sized from a balance read then, and emits the portfolio unless the `portfolioUpdates` filter holds it back: with the filter, the first portfolio read, at start-up, is always emitted, a later one only when an asset crossed `dust` either way, or the quantity of an asset held changed by more than `threshold` %, since the last one emitted

**Emits:**
- `OrderInitiated` — Order has been submitted to exchange
- `OrderCompleted` — Order has been fully filled
- `OrderCanceled` — Order has been canceled
- `OrderErrored` — Order execution failed
- `PortfolioChange` — Portfolio balances have changed

A partial fill or a status change of an order is only logged (`info` level), not emitted. Each order ends in one of `OrderCompleted`, `OrderCanceled` and `OrderErrored`, which no other plugin emits: a built-in strategy waits for that end before it advises again (see the TradingAdvisor).

### Sizing

The Trader sizes an order from the balances it read at its last synchronization, less what the orders it placed since take from them. The strategy gives each order at most one of an `amount`, in the asset, a `cost`, in the currency, and an `allocation`, a percentage of the balance read; an order given none of them is all-in (see [Order Parameters](./custom-strategies.md#order-parameters)):

- A SELL is capped to the free balance of its asset, with a warning, and an all-in SELL sells that balance. A SELL by `cost` asks for that worth of the asset at the order's price, one by `allocation` for that share of the asset read: either is capped so. Once the SELLs placed since the last synchronization take that balance whole, a SELL of an `amount`, a `cost` or an `allocation` is sent as asked, with a warning that they took it, and the exchange refuses it unless one of them was refused or canceled first.
- An all-in BUY spends the free currency, sized at the order's price with 5 % kept back for the fee, in decimal; a BUY with an `amount` is placed as asked.
- A BUY by `cost` spends that sum, the 5 % kept back for the fee included, sized as an all-in BUY is; one by `allocation` spends that share of the currency read, plus what the BUYs it placed and still open at that read hold of it, reserved or spent on their fills, whatever the BUYs placed since spend: two BUYs of `allocation: 50` on one candle both go through, and `allocation: 100` buys what an all-in BUY does (capped there with a warning when BUYs were open at the read). Either is capped at what the BUYs placed since leave of the currency, with a warning, and sized to 0 once nothing is left.
- A SELL, the trailing stop's included, and a BUY without an `amount` are also capped at the most the market takes in one order of their type (the maximum of its amount range, narrowed for a `MARKET` order by Binance's MARKET_LOT_SIZE), with a warning (`[<id>] SELL MARKET order of 100 BTC above the maximum amount of a MARKET order on BTC/USDT: 86.27382215 BTC sent, the rest stays held`): the rest stays held, or unspent, for a later order, and `OrderCompleted` carries the amount executed. A BUY with an `amount` above that maximum is refused by the exchange.
- An all-in order sized from nothing is warned of with its cause before the exchange refuses its amount of 0: `[<id>] All-in BUY MARKET order sized from 0 USDT: 0 BTC sent, which the market refuses (0 USDT free at the last synchronization)`, or `(no balance read from the exchange yet)` while every synchronization has failed. So is a BUY by `cost` or `allocation` whose budget comes to nothing, or a SELL by `allocation` of an asset the Trader read none of, its line naming the cost or the share it asked for: `[<id>] BUY MARKET order of 100 USDT: 0 BTC sent, which the market refuses (…)`, `[<id>] SELL MARKET order of 0 BTC (50 % of 0 BTC): 0 BTC sent, which the market refuses (0 BTC free at the last synchronization)`.
- An order by `cost` or `allocation`, or an all-in BUY, that the market refuses for one of its minimums is warned of before it is sent, then refused by the exchange: an `OrderErrored` that counts towards the TradingAdvisor's `maxConsecutiveErrors`. Its amount, truncated to the amount step of the market as the exchange takes it, is checked against the minimum amount of the market (that of a market order for a `MARKET` one) first: `[<id>] BUY MARKET order of 6 USDT: 0.00057 BTC at 10000 sent, below the minimum amount of 0.001 BTC of a MARKET order on BTC/USDT, which the market refuses`. Then its cost at its price is checked against the minimum cost (for a BUY, 95 % of its budget at most, the rest kept back for the fee): `[<id>] BUY MARKET order of 5 USDT (5 % of 100 USDT): 0.0475 BTC at 100 sent, a cost of 4.75 USDT once 5 % is kept back for the fee, below the minimum cost of 10 USDT on BTC/USDT, which the market refuses at that price`, with `, truncated to 0.00008 BTC on the amount step 0.00001 of the market` after `sent` when the step cut the amount. The cost is valued at the price of the order, the last close for a `MARKET` order, where a live exchange checks it at its ticker: near the minimum the two can disagree. An order sized to 0 gets the warning of its cause instead, and one the step cuts to 0 gets none: the exchange refuses it for its amount, naming the step. An all-in BUY is warned of in the same way, its line opening with `[<id>] All-in BUY MARKET order sized from <currency> USDT`; an order with an `amount`, and an all-in SELL, are not.

A share, like an all-in order, is of the balance as of the last synchronization: every `exchangeSynchInterval` in realtime (10 minutes by default), every `watch.timeframe` in a backtest (10 minutes at least), and after the end of each order. What reached the account since, a deposit or a trade made by hand or by another bot, counts from the next one. The built-in signal strategies size their BUYs so when they trade several pairs, each BUY carrying its pair's share of the currency (see [Pairs and Capital](./built-in-strategies.md#pairs-and-capital)).

### Dependencies

- Requires **exchange** injection for order execution

### Order Types

The Trader supports multiple order types depending on your strategy:

| Order Type | Description                                                                               |
|------------|-------------------------------------------------------------------------------------------|
| `MARKET`   | Execute immediately at current market price                                               |
| `LIMIT`    | Execute at specified price or better                                                      |
| `STICKY`   | Limit order kept at the best bid (BUY) or ask (SELL), moved when the market moves past it |

A `STICKY` order is placed one minimum price step (`price.min` of the pair's market data) above the best bid for a BUY, below the best ask for a SELL, so that it leads the book. It is checked every `orderSynchInterval` of the exchange (20 s by default) in realtime, and at every minute in backtest: once the market has moved past it (a higher bid for a BUY, a lower ask for a SELL), it is canceled and what is left to fill is placed again at the new price. Its price and what is left are worked out in decimal, as the exchange takes them: 101.2 + 0.01 is 101.21, not 101.21000000000001 (the exchange rounds a price to its tick and truncates an amount to its step). A relaunch the exchange refuses once part of the order has filled, what is left being under the market's minimum for instance, ends the order as completed with what it filled. It has no option of its own. Like a `MARKET` order, it ignores the price an advice may give, which then only sizes a BUY without an amount and a SELL by `cost`.

### Exchange Modes

| Exchange        | Description                                                                  | Risk Level |
|-----------------|------------------------------------------------------------------------------|------------|
| `dummy-cex`     | Simulated exchange for backtesting                                           | None       |
| `paper-binance` | Simulated orders on live Binance data, from a `simulationBalance` (realtime) | None       |
| Sandbox         | Exchange testnet with virtual funds                                          | None       |
| Live            | Real exchange with real funds                                                | High       |

> [!CAUTION]
> When using the Trader with a live exchange, real money is at risk. Always test thoroughly with backtesting and sandbox trading first.

---

## 📊 RoundTripAnalyzer and PortfolioAnalyzer

**Purpose:** The analyzers measure how your strategy performs: its profit and return, the return of the market over the same period, its risk-adjusted ratios and its exposure. The **RoundTripAnalyzer** follows the trades of every watched pair, as round trips from the BUY that opens a position on a pair to the SELL that closes it, each pair's apart. The **PortfolioAnalyzer** follows the value of the whole portfolio at every timeframe candle. Both run on one pair or several, value the whole portfolio, and measure the market on one asset, the benchmark (see step 4 below). At the end of the run, the analyzer logs its performance report and sends it to the PerformanceReporter.

> [!IMPORTANT]
> Configure one analyzer, not both: they both emit `performanceReport`, and an event can only have one emitting plugin, so Gekko refuses to start with the two of them. Both run in backtest and realtime mode, on the data of the TradingAdvisor (warmup, timeframe candles) and of the Trader (orders, portfolio): without a portfolio from the Trader, the report is empty (all zeros) and a warning says so.

| Analyzer              | Measures                                                                          | Pairs       | Specific to its report                                                |
|-----------------------|-----------------------------------------------------------------------------------|-------------|-----------------------------------------------------------------------|
| **RoundTripAnalyzer** | Each round trip of each pair, from the BUY that opens it to the SELL that ends it | One or more | Win rate, trade count, largest adverse excursions, per-pair breakdown |
| **PortfolioAnalyzer** | The equity curve: the portfolio's value at every timeframe candle                 | One or more | Max and longest drawdown, portfolio changes                           |

### Configuration

```yaml
plugins:
  - name: RoundTripAnalyzer    # Or PortfolioAnalyzer: both take the same options
    riskFreeReturn: 5          # Yearly risk-free return (%)
    enableConsoleTable: true   # Print the report as a table in the terminal
    benchmarkAsset: BTC        # The asset whose return is the market's, one of watch.assets
```

### Configuration Reference

| Parameter            | Type       | Required | Default                              | Description                                                                                                                                                                                                   |
|----------------------|------------|----------|--------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `name`               | string     | Yes      | —                                    | `RoundTripAnalyzer` or `PortfolioAnalyzer`                                                                                                                                                                    |
| `riskFreeReturn`     | number ≥ 0 | No       | `5`                                  | Yearly return of a riskless investment (%), which the Sharpe and Sortino ratios subtract                                                                                                                      |
| `enableConsoleTable` | boolean    | No       | `false`                              | Print the report as a table, at any log level, instead of a log line (see step 5 below; the RoundTripAnalyzer also prints each round trip as a table, and each pair's figures when several pairs are watched) |
| `benchmarkAsset`     | string     | No       | BTC if watched, else the first asset | The asset whose return over the period is the market return of the report: one of `watch.assets`, written as there (see step 4 below)                                                                         |

### How Both Work

1. The period measured starts when the strategy's warmup completes, at the close of the timeframe candle that completes it (the end of its last minute), when the strategy starts to act. It ends with the last minute of the run.
2. The start equity is the value of the latest portfolio received from the Trader at the closes of that minute, the prices the market return starts from too: the currency, plus every watched asset at the close of its pair (an asset that is not watched, such as BNB kept for the fees, is left out). Both analyzers value the whole portfolio so, whatever the pairs traded. If no portfolio has arrived by then, the first one received afterwards gives it, valued at the prices of that moment, with a warning unless it came before the next bucket (`No portfolio received during the warmup: start equity taken late, at the prices of 2024-03-01T10:07:00.000Z.`).
3. The portfolio valued is the latest one received, with a `portfolioChange`, an `orderCompleted`, an `orderCanceled` or an `orderErrored` (each order event carries the portfolio the Trader read after it, except the empty one it sends before any of its synchronizations succeeds, which is ignored): the Trader's `portfolioUpdates` filter can hold back the `portfolioChange` of a small fill. It is marked to market at the close of every timeframe candle, and once more at the end of the run.
4. The market return, which the alpha is worked out from, is that of one asset, the benchmark: the `benchmarkAsset` option, else BTC when it is watched, otherwise the first asset of `watch.assets`. It is the return of holding that asset over the period, from the close of its pair at the start to its last close, which are the start and end prices of the report; the report names it (`benchmarkAsset`), and so does the table of either analyzer, in its `Benchmark` row (PortfolioAnalyzer) or its `benchmark` row (RoundTripAnalyzer). The benchmark is one of `watch.assets`, written as there: an asset in lower case is refused with the configuration (`Asset 'eth' must be written in upper-case letters and digits, as in BTC or 1INCH`), and one that is not watched as the analyzer is created (`[PORTFOLIO ANALYZER] benchmarkAsset must be one of the watched assets (BTC and ETH), got "SOL"`, the same under `[ROUNDTRIP ANALYZER]`).
5. At the end of the run, the report is computed, logged at the `info` level (start Gekko with `GEKKO_LOG_LEVEL=info` to see it) or printed as a table with `enableConsoleTable`, whatever the log level, and emitted as `performanceReport` for the PerformanceReporter. The table rounds its percentages to 2 decimals by the rule of each figure, as the CSV does (see [CSV Output Format](#csv-output-format)): down for the returns, the alpha and the drawdown, half to even for the win rate and the exposure (`PERCENT_ROUNDING`, `packages/plugins/src/analyzers/analyzer.const.ts`), and down for the adverse excursions, which the CSV writes to 8 decimals; Alpha has its `%` in the tables of both analyzers. Its ratios and deviations have 2 decimals, as in the CSV, and its amounts are grouped by thousands. It holds every figure of the report's CSV row, the net profit and the total return among them, and the PortfolioAnalyzer's longest drawdown as the CSV writes it (`0` without one). On several pairs, the RoundTripAnalyzer prints each pair's figures in a second table, after the report's (see below). When the run stopped before its end (a crash, missing candles, the circuit breaker), a line above the table says so, and why: `Run interrupted, the report below covers a partial period. Reason: [STRATEGY] Max consecutive order errors reached (5)`. The report is sent from `processFinalize`, so it is emitted directly: a handler gets the report itself, not an array of payloads. The analyzer waits for the handlers; one that throws is logged at the `error` level (`A listener failed on the performance report: …`) and does not change the exit code. When it cannot measure the period, the analyzer emits an empty report and a warning says why: for the RoundTripAnalyzer, the warmup never completed, no portfolio was received, or the start equity is 0 or less (`Start equity of 0 USDT: no return to measure`); for the PortfolioAnalyzer, no start equity or no point of the curve (`Insufficient data for report generation.`), or a start equity of 0 or less.

### RoundTripAnalyzer

It follows the orders the Trader fills on every watched pair, and keeps the round trips of each pair apart: a BUY of ETH neither opens nor adds to a round trip of BTC, and several pairs can be in a round trip at once, as with a signal strategy trading several pairs (see [Pairs and Capital](./built-in-strategies.md#pairs-and-capital)):

- A BUY completed while its pair is flat opens a round trip of that pair. Its entry equity is the value of the whole portfolio just before that BUY: the portfolio the Trader read after it, the pair's asset valued at the BUY's price and the other watched assets at their latest closes, plus the BUY's fee. When the ends of two orders reach the Trader before one balance read, as the BUYs of two pairs on one candle do in a backtest, both carry the portfolio read after both, and the entry equity of each counts the other order too: its fee, and the gap between its price and the last close of its pair (from 300,000 USDT, BUYs of 1 BTC at 9,000 and 1 ETH at 2,200 at a 0.1 % fee enter with 299,997.8 and 299,991). More BUYs of the pair add to the position, and the entry price is the mean of the BUY prices weighted by their amounts.
- SELLs of the pair reduce the position, and the exit price is the mean of their prices weighted by their amounts. The round trip ends once what is left of the position (bought, not sold yet and still held) is at most 1 % of the amount bought (`DUST_TOLERANCE`): the dust left by an amount rounded to the exchange's lot size, or by a fee taken in the asset, does not keep it open.
- Its `pnl` is what its own fills made, in the currency: the proceeds of its SELLs less the cost of its BUYs, each fill its amount times its price, less the fees of all its orders as the Trader reports them (an unknown fee counting 0), worked out in decimal. Neither an asset held before the round trip nor the trades of the other pairs change it. Its `profit` is that `pnl` in % of its entry equity. A round trip whose `pnl` is less than a unit of the 8th decimal (0.00000001, the smallest amount the simulator and Binance book) away from 0, or whose proceeds are within a billionth of its cost and fees together, broke even: `pnl` and `profit` 0, neither a win nor a loss (its `profit` NaN when its entry equity is unknown, as below).
- The fee of a BUY that the exchange takes in the asset bought, as Binance does when the account does not pay its fees in BNB, counts twice: in the fees, as the Trader reports it in the currency, and in the proceeds, the SELL selling the smaller amount that fee left. The P&L of such a round trip is understated by that fee, 0.1 % of the BUY's cost at Binance's regular rate: the order events do not say which asset a fee was taken in. The simulated exchanges of a backtest and of `paper-binance` take every fee in the currency, and their round trips are exact.
- When the BUY's end carries the empty portfolio of a Trader that has read none yet (in realtime, its balance reads failing since start-up), the entry equity is unknown, and so is the round trip's `profit` (NaN in its `roundtripCompleted` payload and its info line, `unknown` in the console table and on Telegram). Its `pnl`, from its fills, is known: the round trip counts in the win rate, the trades, the exposure and the MAEs, not in the returns the volatility and the ratios are computed from, and a warning says so as it closes (`Round trip 2 on ETH/USDT left out of the returns, its profit unknown: the Trader had read no portfolio when BUY order <id> opened it.`). Should the warmup leave a round trip open, it counts from the start of the period, with the start equity as its entry equity: the same warning comes for it, naming its BUY, when no start equity was taken by then.
- A BUY or a SELL canceled after a partial fill counts for the part that filled, as a trade of its pair dated at the cancelation and priced at the mean price of the fills the exchange reported (`fillPrice` on the event, which the Trader gives a canceled LIMIT or STICKY order, never a MARKET one); without it, a `LIMIT` order at its own price, any other order (a MARKET or a STICKY one, whose price is only the one the strategy sized it from, or a LIMIT one placed at the market) at the last close of its pair. Its fee is unknown and counted as 0.
- A SELL while its pair is flat ends no round trip. Before the first trade of its pair in the period, such as one that sells an asset held before it, it is not counted as a trade either.
- Its maximum adverse excursion (MAE) is the deepest fall of a 1-minute low of its pair below its entry price (the weighted mean of its BUYs so far), in % of the entry price, over the 1-minute candles that close while the position is held: after the fill of the BUY that opens it, and by that of the SELL that ends it. A strategy that buys at the market at the close of minute a and sells at the close of minute b reads the candles of minutes a + 1 to b in every mode: its orders fill at those closes in a backtest and in paper trading, and a few seconds into minutes a + 1 and b + 1 live, where the candle of minute b + 1, held for those seconds only, is left out. The candles are picked by the dates of the fills, not by when the Trader reports them: a fill reported with a later bucket, as in realtime, is measured from the same candles, as long as it is reported within the hour.
- Each round trip is logged at the `info` level (and printed as a table with `enableConsoleTable`, its first row naming the pair when several pairs are watched) and emitted as `roundtripCompleted`, which the EventSubscriber can relay to Telegram. The round trips of all the pairs are numbered together, from 0, in the order they close, and the numbering never restarts: should the warmup close round trips, they take the first ids, though the report leaves them out.
- The report covers the period only, and no trade comes before it: until the warmup is over, the strategy cannot create an order (`tools.createOrder` stops Gekko with an error, even from `init`).
- Every pair counts in the report. Its start and final balances are the whole portfolio's value (see step 2 above), its win rate counts the closed round trips of every pair, its trade count their trades, and its largest adverse excursions are those of every closed round trip. Its returns, which the volatility and the ratios are computed from, are the profits of the closed round trips of every pair, but the unknown ones.
- The exposure is the share of the period during which at least one pair was in a round trip, those still open at the end included: the round trips of two pairs that overlap count their common time once.
- The report's `pairs` gives the figures of each watched pair, in the order of `watch.assets`, a pair without a round trip included: its closed round trips (`roundTripCount`) and those that made a profit (`winCount`), its win rate, its trades, its P&L (the `pnl` of its closed round trips added up, in the currency), its exposure (its own round trips, the one still open included) and its deepest MAE. With `enableConsoleTable`, a run that watches several pairs prints them in a second table, after the report's: a row per pair, and the columns `roundTrips`, `wins`, `winRate`, `tradeCount`, `P&L`, `exposurePct` and `deepestMAE`, written as in the report's table. The report's table, on one pair too, names the benchmark in its `benchmark` row, right after `endPrice`.
- A position still open at the end is logged, pair by pair, with its unrealized P&L at its pair's last close: what its fills made so far, the asset still held valued at that close, without the fee of the SELL that would close it, and that P&L in % of its entry equity, unknown when no portfolio valued its entry (`Position still open on BTC/USDT at the end of the period, entered at …`). The final balance and the exposure include it; the win rate, the ratios and the MAEs, which only count the closed round trips, leave it out.

**Listens to:**
- `StrategyWarmupCompleted` — Starts the period and takes the start equity
- `TimeframeCandle` — Marks the portfolio to market
- `PortfolioChange` — Updates the portfolio it values
- `OrderCompleted` — Opens, extends and ends the round trips of the order's pair, and refreshes the portfolio it values
- `OrderCanceled` — Counts the part of a canceled order that filled in the round trips of its pair, and refreshes the portfolio it values
- `OrderErrored` — Refreshes the portfolio it values

**Emits:**
- `RoundtripCompleted` — A round trip has ended
- `PerformanceReport` — The report, at the end of the run

### PortfolioAnalyzer

It values the whole portfolio, on one pair or several: the currency plus every watched asset at its latest close (an asset that is not watched, such as BNB kept for the fees, is left out).

- The equity curve gets a point at the close of every timeframe candle after the warmup, the one that completes it included: the latest portfolio valued at that candle's closes. When the start equity is taken late (see step 2 above), the portfolio that gives it is the first point of the curve instead, at the end of the minute it came in, and the timeframe candles before it have none. Each of these points is emitted as `equitySnapshot`: once per timeframe candle, and once for a late start equity (no built-in plugin listens to it; a custom one can, with `onEquitySnapshot`). At the end of the run, the latest portfolio at the last prices ends the curve: it replaces the value of the last point when the run ends at the close of a timeframe candle, and is added otherwise; it is not emitted.
- It listens to `orderCompleted`, `orderCanceled` and `orderErrored` only to refresh the portfolio it values (see step 3 above: the Trader's `portfolioUpdates` filter can hold back the `portfolioChange` of a small fill): none of them adds a point to the curve, nor counts as a portfolio change.
- The returns of the curve, one per timeframe candle, give the volatility and the ratios. The curve also gives the max drawdown (the largest fall from a peak, the start equity being the first peak) and the longest drawdown (the longest time from a peak to the point that gets back to it, or to the end of the run). The equities are computed in decimal, as the exchanges book the balances, and two equities less than 0.00000001 of the currency apart, the smallest amount the simulator and Binance book, count as equal: a portfolio back at its peak value ends its drawdown, and a change smaller than that is a return of 0.
- The exposure is the share of the period during which the portfolio held an asset other than the currency worth at least 1 % of the portfolio, at the latest prices, counted one timeframe at a time. Neither the dust left by a SELL nor a position deliberately kept under 1 % of the equity counts.
- The market return is that of the benchmark asset (see step 4 above): the `benchmarkAsset` option, else BTC when it is watched, otherwise the first asset of `watch.assets`. The start and end prices of the report are its closes.

**Listens to:**
- `StrategyWarmupCompleted` — Starts the period and takes the start equity
- `TimeframeCandle` — Adds a point to the equity curve
- `PortfolioChange` — Updates the portfolio it values, and gives a late start equity, with its point of the curve
- `OrderCompleted` — Refreshes the portfolio it values, without adding a point to the curve
- `OrderCanceled` — Refreshes the portfolio it values, without adding a point to the curve
- `OrderErrored` — Refreshes the portfolio it values, without adding a point to the curve

**Emits:**
- `EquitySnapshot` — A point of the equity curve: once per timeframe candle after the warmup, and once for a late start equity
- `PerformanceReport` — The report, at the end of the run

### Performance Report

The report holds the fields of `Report` (`packages/shared/src/models/event.types.ts`), and those of its analyzer. The PerformanceReporter writes it as a row of CSV (see its columns below).

| Field                                        | Analyzer  | Description                                                                                                                                                                                          |
|----------------------------------------------|-----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `id`                                         | Both      | `TRADING REPORT` (RoundTripAnalyzer) or `PORTFOLIO PROFIT REPORT` (PortfolioAnalyzer)                                                                                                                |
| `periodStartAt`, `periodEndAt`               | Both      | Start and end of the period (epoch milliseconds)                                                                                                                                                     |
| `formattedDuration`                          | Both      | Length of the period, such as `3 months 2 days`, counted on the UTC calendar, the same on every machine                                                                                              |
| `netProfit`                                  | Both      | End equity minus start equity, in quote currency, computed in decimal as the equities are                                                                                                            |
| `totalReturnPct`                             | Both      | Return over the period (%)                                                                                                                                                                           |
| `annualizedNetProfit`, `annualizedReturnPct` | Both      | Net profit and return per year (see below)                                                                                                                                                           |
| `marketReturnPct`                            | Both      | Return of holding the benchmark asset over the period (%)                                                                                                                                            |
| `alpha`                                      | Both      | Total return minus market return, in percentage points                                                                                                                                               |
| `exposurePct`                                | Both      | Share of the period spent exposed (%)                                                                                                                                                                |
| `volatility`                                 | Both      | Standard deviation of the returns (%): the population one, over their number, not their number less one; 0 for returns all equal (within a relative 1e-9)                                            |
| `downsideDeviation`                          | Both      | Root mean square of the negative returns, the positive ones counting as 0 (%)                                                                                                                        |
| `sharpeRatio`, `sortinoRatio`                | Both      | Risk-adjusted returns, annualized (see below)                                                                                                                                                        |
| `startPrice`, `endPrice`                     | Both      | Price of the benchmark asset at the start and at the end                                                                                                                                             |
| `benchmarkAsset`                             | Both      | Asset whose closes give the market return and the start and end prices (see step 4); `''` in an empty report                                                                                         |
| `interruption`                               | Both      | Message of the error that stopped the run before its end (a crash, missing candles, the circuit breaker), absent when it completed; written in the CSV's `status` column and above the console table |
| `startBalance`, `finalBalance`               | RoundTrip | Value of the whole portfolio at the start and at the end (see step 2 above), the positions still open included                                                                                       |
| `winRate`                                    | RoundTrip | Share of the closed round trips of every pair with a positive P&L (%), `null` without any; not rounded (the console table and the CSV round it to 2 decimals)                                        |
| `tradeCount`                                 | RoundTrip | Trades of the period on every pair: orders completed and canceled ones that filled in part, each pair's from its first BUY on                                                                        |
| `topMAEs`                                    | RoundTrip | The 10 largest maximum adverse excursions of the closed round trips of every pair (%), largest first                                                                                                 |
| `pairs`                                      | RoundTrip | Each watched pair's figures, in the order of `watch.assets` (see below); empty in an empty report, and not written in the CSV                                                                        |
| `startEquity`, `endEquity`                   | Portfolio | Portfolio value at the start and at the end                                                                                                                                                          |
| `equityCurve`                                | Portfolio | The points of the equity curve, `{ date, totalValue }`                                                                                                                                               |
| `maxDrawdownPct`                             | Portfolio | Largest fall from a peak of the equity curve (%)                                                                                                                                                     |
| `longestDrawdownMs`                          | Portfolio | Longest drawdown (milliseconds)                                                                                                                                                                      |
| `portfolioChangeCount`                       | Portfolio | Deliveries of portfolio changes: the changes the Trader queues before one flush are delivered together and count once                                                                                |

An entry of `pairs` (`PairTradingSummary`) holds the pair's `symbol`, `roundTripCount` (its round trips closed during the period), `winCount` (those with a positive P&L), `winRate` (`winCount` in % of `roundTripCount`, `null` without a round trip, not rounded), `tradeCount` (its trades of the period), `pnl` (the `pnl` of its closed round trips added up, in quote currency), `exposurePct` (the share of the period spent in its round trips, the one still open included) and `maxAdverseExcursion` (the deepest adverse excursion of its closed round trips, in %, 0 without one).

A `roundtripCompleted` payload (`RoundTrip`) holds the round trip's `id` (0 for the first one of the run, the round trips of every pair numbered together in the order they close), `symbol` (its pair), `entryAt`, `entryPrice`, `entryEquity` (the whole portfolio's value before the BUY that opened it), `exitAt`, `exitPrice`, `cost` (the amount times the price of each of its BUYs, added up, in quote currency), `proceeds` (the same for its SELLs), `fees` (the fees of all its orders as the Trader reports them, in quote currency, an unknown one counting 0), `duration` (milliseconds), `pnl` (`proceeds − cost − fees`), `profit` (`pnl` in % of `entryEquity`) and `maxAdverseExcursion` (%): `entryEquity` and `profit` are NaN when the Trader had read no portfolio when the BUY that opened the round trip filled. A BUY fee that the exchange takes in the asset bought (Binance without BNB) is reported in currency all the same, while the SELL can only sell what the fee left: such a fee counts twice, in `fees` and through the smaller `proceeds`, and the `pnl` is understated by it (0.1 % of the BUY's cost at Binance's regular rate); the order events do not say which asset a fee was taken in. An `equitySnapshot` payload is a `{ date, totalValue }` point of the equity curve.

### How the Statistics Are Computed

Both analyzers compute them the same way, each from its own returns: the profit of each closed round trip of every pair, but the unknown ones, for the RoundTripAnalyzer, the change of the equity curve at each timeframe candle for the PortfolioAnalyzer. The annualized figures (net profit, return, Sharpe and Sortino ratios) share one horizon: the period, or a day for a run shorter than a day, as if its returns had been spread over that day, and a warning says so then: annualized over its own length, a run of a few minutes would turn the moves of a few candles into a yearly return of thousands of %.

- **Annualized net profit and return** (`yearly profit` in the CSV): the net profit and the total return divided by the horizon in years, each worked out from the equities and rounded once. The annualization is linear, without compounding: +5 % over half a year is +10 % a year. The horizon is counted in years of the calendar, in UTC, the same on every machine: the whole years from the start to its last anniversary (a start on Feb 29 has its anniversaries on Feb 28 in other years), plus the time left over the length of the year from that anniversary to the next, 365 or 366 days. Half of 2024 is 182/366 of a year.
- **Sharpe ratio:** the annualized return minus `riskFreeReturn`, divided by the standard deviation of the returns annualized by √(returns per year), the returns per year being their number divided by the horizon in years. It is 0 without a return or without volatility: returns all equal, or equal but for the rounding of the arithmetic that made them (within a relative 1e-9), have none.
- **Sortino ratio:** the same, with the downside deviation in place of the standard deviation: the root mean square of the negative returns, the positive ones counting as 0. It is 0 when no return is negative.
- **Alpha:** the total return minus the market return, 0 when the two differ only by the rounding of the arithmetic, as for a portfolio holding the benchmark asset alone.

The percentages of the report (the total, annualized and market returns, the alpha, the max drawdown, the exposure and the win rate) are computed in decimal: a change is worked out exactly, and each percentage comes of one division rid of the noise of binary arithmetic, so that a figure on a hundredth, such as a market return of 0.01 % from 1.0000 to 1.0001, is written as it is once rounded.

### Understanding the Metrics

> [!TIP]
> **Sharpe Ratio Interpretation:**
> - Below 1.0: Suboptimal risk-adjusted returns
> - 1.0 - 2.0: Good risk-adjusted performance
> - 2.0 - 3.0: Very good performance
> - Above 3.0: Excellent (rare in real trading)

> [!NOTE]
> The `riskFreeReturn` parameter is used in Sharpe and Sortino ratio calculations. Adjust this based on current treasury rates or your opportunity cost of capital; `0` (cash that earns nothing) is accepted.

---

## 📋 PerformanceReporter

**Purpose:** The PerformanceReporter exports backtest results to CSV files, enabling easy comparison across multiple backtest runs and external analysis. It is also where [Fox](./fox.md) collects its results: each variant of a sweep adds its row to the file its template names.

### How It Works

1. Receives the performance report of the PortfolioAnalyzer or of the RoundTripAnalyzer
2. Identifies the run by the values of the `strategy` block joined by `-` (the `id` column), the same for every run with the same parameters, followed by its `label` in parentheses when it has one (`RSI-21-70-30-0 (fee 0.1%)`), which tells apart runs of the same parameters
3. Appends the row to the CSV file while holding a lock file, `<fileName>.lock`, next to it, so that backtests ending together, such as the variants Fox runs side by side, do not write into each other's rows. It keeps trying for up to a minute, 25 to 75 ms between two attempts: long enough for every variant of a sweep ending at once to take its turn, and for a lock left behind by a run killed while writing (kill -9, Ctrl-C at that instant, a crash) to be taken over, which happens automatically once the lock is 30 s old (a `<fileName>.lock.takeover` file left by a run killed while taking such a lock over is handled the same way). If the lock is still held after that minute, the report is lost: an error says so, naming the lock file, and the run fails at its end (step 5). Delete the lock by hand if no other run is writing the file.
4. Creates the output directory and file if they don't exist
5. Fails the run at its end when its row was not written, whether the lock was never obtained, the first line of the file is not the expected header (see [CSV Output Format](#csv-output-format)) or the write failed: Gekko exits with code 1 once the analyzer has logged its report, and [Fox](./fox.md#results) reports the variant as failed, naming the row and the cause (`PerformanceReporter failed to finalize: The TRADING REPORT row was not written: ./reports/backtest.csv could not be locked (see the error logged above)`), so that a row missing from the file of a sweep never goes unnoticed. The error logged as the row was lost says more: the lock file to delete, or the file to move.

### Configuration

```yaml
plugins:
  - name: PerformanceReporter
    filePath: ./reports        # Directory for CSV output
    fileName: backtest.csv     # Output filename
    label: fee 0.1%            # Optional: written after the id of each row
```

### Configuration Reference

| Parameter  | Type   | Required | Default                   | Description                                                            |
|------------|--------|----------|---------------------------|------------------------------------------------------------------------|
| `name`     | string | Yes      | —                         | Must be `PerformanceReporter`                                          |
| `filePath` | string | No       | Current working directory | Directory for output file                                              |
| `fileName` | string | No       | `performance_reports.csv` | Name of the output CSV file, not empty                                 |
| `label`    | string | No       | —                         | Written after the `id` of each row, in parentheses, not empty          |

The `label` tells apart the rows of runs whose `strategy` blocks are the same, such as backtests of one strategy under two fees: without it, their `id` is the same. [Fox](./fox.md#results) gives each variant of a sweep the label of its values, `--exchange.marketData.0.marketData.fee.maker 0.01`, unless the template's PerformanceReporter has a label of its own. Without a label, the `id` is the values of the `strategy` block alone, as before, and the columns are the same either way, so a file keeps taking the rows of both.

### Events

**Listens to:**
- `PerformanceReport` — Receives final performance statistics

### CSV Output Format

The reports of the PortfolioAnalyzer and of the RoundTripAnalyzer share one header, so both can be appended to the same file. A column that a report type does not have is left empty (*Portfolio only* / *Trading only* below). The lock of step 3 above covers writing the header of a new or empty file, checking the header and appending the row, so that no other run writes in between. The reporter never appends to a file whose first line is not this header, such as a file written by an older version: it logs an error, skips the report and fails the run at its end (step 5 above), so move or rename that file. A byte order mark at the start of the file and a `\r\n` line ending after the header, which Excel and LibreOffice add when they save the file back on Windows, are accepted; the rows the reporter appends still end with `\n`. The layout changed when the `timeframe` column was added and `pair` went back to holding the watched pairs (it had been repeating the report type), and again when the `status` column was added, so every file written before that is refused: the 28-column files without `status`, and the files of the version that wrote one header per report type, ending in `;status`.

Cells are separated by `;`. A cell that holds a `;`, a double quote or a line break (a strategy parameter, for example) is enclosed in double quotes, and its own double quotes are doubled: the usual CSV quoting, which spreadsheets read back as the original value.

Amounts and prices (`net profit`, the profit in `yearly profit`, `start balance`, `final balance`, `start price`, `end price`) are plain numbers, written the same whatever the locale of the machine: a `.` decimal separator, no thousands separator and up to 8 decimals, so that a price of a fraction of a cent or a profit in BTC keeps its value (e.g., `1234.5678`, `0.0000012`). A value that is not a number leaves its cell empty. Percentages are computed in decimal (see [How the Statistics Are Computed](#how-the-statistics-are-computed)), then rounded to 2 decimals: down for `total return`, the return in `yearly profit`, `market`, `alpha` and `max drawdown` (so `-1.234` is written `-1.24%`), to the nearest for `win rate` and `exposure`. The ratios and deviations (`sharpe ratio`, `sortino ratio`, `standard deviation`, `downside deviation`) are written with 2 decimals, such as `1.50` (`0.00` for any value between -0.005 and 0.005); one that is missing, not a number or infinite leaves its cell empty. `top maes` is a JSON array of the values written as the amounts are, up to 8 decimals and never with an exponent, largest first (e.g., `[4.21876543,1.5]`). Rows written by earlier versions can hold the unrounded values there (`4.218765432098766`, `1.000000338535756e-8`), and amounts rounded to 3 decimals and grouped in the machine's locale (`1,234.568`, or `1 234,568` on a French machine). A trading row written by an earlier version leaves `benchmark asset` empty.

| Column                      | Description                                                                                                                                                                                                        |
|-----------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `id`                        | `strategy` block values joined by `-` (e.g., `RSI-21-70-30-0`), then the `label` of the reporter in parentheses when it has one (e.g., `RSI-21-70-30-0 (--strategy.period 21)`, as Fox labels each variant)        |
| `report type`               | `Portfolio` (PortfolioAnalyzer) or `Trading` (RoundTripAnalyzer)                                                                                                                                                   |
| `pair`                      | Watched pairs, separated by a space (e.g., `BTC/USDT ETH/USDT`)                                                                                                                                                    |
| `timeframe`                 | Candle timeframe of the run, `watch.timeframe` (e.g., `1h`)                                                                                                                                                        |
| `net profit`                | Profit in quote currency                                                                                                                                                                                           |
| `total return`              | Return over the period (%)                                                                                                                                                                                         |
| `yearly profit`             | Annualized net profit, with the annualized return (%): over the period, or a day for a shorter run                                                                                                                 |
| `win rate`                  | Share of the closed round trips of every pair with a positive P&L (%), `N/A` without any, *Trading only*                                                                                                           |
| `market`                    | Buy-and-hold return of the benchmark asset (%)                                                                                                                                                                     |
| `alpha`                     | Excess return vs market (%)                                                                                                                                                                                        |
| `sharpe ratio`              | Sharpe ratio, annualized over the same horizon as `yearly profit`                                                                                                                                                  |
| `sortino ratio`             | Sortino ratio, annualized over the same horizon as `yearly profit`                                                                                                                                                 |
| `max drawdown`              | Maximum drawdown (%), *Portfolio only*                                                                                                                                                                             |
| `total changes`             | Number of portfolio change deliveries (see `portfolioChangeCount`), *Portfolio only*                                                                                                                               |
| `trade count`               | Number of trades of the period on every pair (orders completed, canceled ones that filled in part), each pair's from its first BUY on, *Trading only*                                                              |
| `start time`                | Start of the period, when the warmup completed (ISO 8601)                                                                                                                                                          |
| `end time`                  | End of the period, the end of the last minute (ISO 8601)                                                                                                                                                           |
| `duration`                  | Length of the period (e.g., `3 months 2 days`), counted on the UTC calendar, the same on every machine                                                                                                             |
| `exposure`                  | Share of the period in a position (%): in round trips of any pair, the open ones included, a time several pairs share counted once (*Trading*); holding an asset worth at least 1 % of the portfolio (*Portfolio*) |
| `start balance`             | Value of the portfolio at the start, in quote currency: the currency plus every watched asset at its close                                                                                                         |
| `final balance`             | Value of the portfolio at the end, in quote currency, valued as `start balance` is, positions still open included                                                                                                  |
| `start price`               | Price of the benchmark asset at start                                                                                                                                                                              |
| `end price`                 | Price of the benchmark asset at end                                                                                                                                                                                |
| `standard deviation`        | Standard deviation of the returns: of the round trips (*Trading*), of the timeframe candles (*Portfolio*)                                                                                                          |
| `downside deviation`        | Root mean square of the negative returns, the positive ones counting as 0                                                                                                                                          |
| `longest drawdown duration` | Duration of the longest drawdown, counted from 1970-01-01T00:00Z on the UTC calendar (59 days are written `2 months`, 30 days `30 days`), *Portfolio only*                                                         |
| `benchmark asset`           | Asset whose price gives the market return (the analyzers' `benchmarkAsset`), empty for an empty report                                                                                                             |
| `top maes`                  | The 10 largest maximum adverse excursions (%), as a JSON array, *Trading only*                                                                                                                                     |
| `status`                    | `completed`, or `interrupted: <reason>` when the run stopped before its end (the message of the error that stopped it, quoted when it holds a `;`, a double quote or a line break)                                 |

> [!TIP]
> Use the PerformanceReporter when running multiple backtests with different parameters. The CSV format makes it easy to analyze results in spreadsheet software or import into data analysis tools.

---

## 💾 CandleWriter

**Purpose:** The CandleWriter saves candle data to the configured database. It's essential for the Importer mode and optional for Realtime mode if you want to persist incoming market data.

### How It Works

1. Receives 1-minute candles from the pipeline
2. Buffers candles in memory for efficiency
3. Writes candles to the database in batches
4. Writes the candles still buffered on finalization. When that last insert fails, a run that ended normally fails (exit code 1) with an error giving, per pair, how many minutes were not written, and their range, which an import writes again; after a run that failed, or that the circuit breaker stopped, that error is logged at the `error` level beside the run's own

### Configuration

```yaml
plugins:
  - name: CandleWriter
```

### Configuration Reference

| Parameter | Type   | Required | Default | Description             |
|-----------|--------|----------|---------|-------------------------|
| `name`    | string | Yes      | —       | Must be `CandleWriter`  |

### Dependencies

- Requires **storage** injection for database access

### Mode Usage

| Mode      | Required | Purpose                                        |
|-----------|----------|------------------------------------------------|
| Importer  | Yes      | Store fetched historical candles               |
| Realtime  | No       | Optionally persist live candles for later use  |

> [!IMPORTANT]
> The CandleWriter is **required** for Importer mode. Without it, fetched historical data will not be saved to the database.

---

## 📱 EventSubscriber

**Purpose:** The EventSubscriber sends trading events to Telegram, keeping you informed about strategy signals, order executions, and trading activity in real-time.

### How It Works

1. Connects to Telegram Bot API using your bot token
2. Listens for commands to manage event subscriptions
3. Filters events based on your active subscriptions
4. Sends formatted messages for relevant trading events

> [!IMPORTANT]
> The EventSubscriber starts subscribed to nothing, and sends no notification until its chat subscribes: once Gekko runs, send the bot `/subscribe_all`, or the `/sub_<event>` of each event you want (see [Telegram Commands](#telegram-commands)). The subscriptions are kept in memory only: subscribe again after every restart. With `chatId` set, the commands your chat sent the bot while Gekko was not running are handled as it starts (those of the last 24 hours, which Telegram keeps for the bot), so a `/subscribe_all` sent while Gekko was down takes effect from the start.

> [!NOTE]
> Messages go out in the background, one at a time and in the order of their events, so a slow or unreachable Telegram never holds up candles or orders. Up to 1000 wait their turn, enough for a burst such as a grid strategy placing hundreds of orders at once; beyond that, each new one drops the oldest, with a single warning until the queue has emptied (the next drops are logged at the `debug` level). When sends keep failing (the bot blocked, a wrong `chatId`), only the first failure is a warning: the next ones are logged at the `debug` level until a message goes out again, which is logged at the `info` level. When Gekko stops on its own (circuit breaker or error) it waits at most 15 s for them, those queued while it stops included; Ctrl-C or a kill signal does not wait.

### Configuration

```yaml
plugins:
  - name: EventSubscriber
    token: YOUR_TELEGRAM_BOT_TOKEN
    botUsername: YOUR_BOT_USERNAME
    chatId: 123456789 # Your chat id, a number: the only chat the bot answers and notifies
```

### Configuration Reference

| Parameter     | Type    | Required          | Default | Description                                                                                                                                 |
|---------------|---------|-------------------|---------|---------------------------------------------------------------------------------------------------------------------------------------------|
| `name`        | string  | Yes               | —       | Must be `EventSubscriber`                                                                                                                   |
| `token`       | string  | Yes               | —       | Telegram Bot API token                                                                                                                      |
| `botUsername` | string  | Yes               | —       | Your Telegram bot's username                                                                                                                |
| `chatId`      | integer | No, but advisable | —       | The only chat whose commands the bot handles and that gets its messages (positive for a private chat, negative for a group; `0` is refused) |

> [!IMPORTANT]
> Anyone can find a Telegram bot by its username and write to it. With `chatId` set, the bot only takes commands from that chat and only sends its notifications there, from start-up; whatever another chat sends is ignored. Every member of that chat can command the bot, so prefer your private chat to a group.
>
> Without `chatId`, the bot belongs to the first chat that sends it a command once Gekko has started (a plain text does not count, and whatever was sent to the bot while Gekko was not running is dropped at start-up: send it again) until Gekko stops. It warns about it at start-up (`warn` level) and logs the chat it takes at the `info` level, with its id and whose chat it is (`private chat with @you`, `group "Title"`). To find your chat id, start Gekko with `GEKKO_LOG_LEVEL=info`, then press **Start** in your chat with the bot (or send it `/help`), check that the log line that says `set chatId: <id>` names your own chat, and copy the id from it; or ask [@userinfobot](https://t.me/userinfobot), which replies with your id. If the bot does not answer you, `GEKKO_LOG_LEVEL=debug` shows why it ignored a message: a chat other than its own (with that chat's id), a command addressed to another bot, which names both bots (a misspelt `botUsername` ignores every command tapped in a group's menu), or, while it has no chat yet, a text that is not a command (once bound, it ignores a plain text from its own chat without a log line).

### Events

**Listens to:**
- `StrategyInfo` — The strategy's log lines at the `info`, `warn` and `error` levels
- `StrategyCreateOrder` — New order signals from strategy
- `StrategyCancelOrder` — Order cancellation signals from strategy
- `OrderInitiated` — Orders submitted to exchange
- `OrderCanceled` — Canceled orders
- `OrderErrored` — Failed orders
- `OrderCompleted` — Filled orders
- `PortfolioChange` — The balances the Trader read, which `/portfolio` shows, as it shows those every order event carries
- `RoundtripCompleted` — Closed round trips (sent by the RoundTripAnalyzer)

### Telegram Commands

Control your subscriptions, or ask for the portfolio, via Telegram commands:

| Command                   | Description                                            |
|---------------------------|--------------------------------------------------------|
| `/help`                   | Show all available commands                            |
| `/start`                  | Same as `/help` (sent by the Start button)             |
| `/subscribe_all`          | Subscribe to all event types                           |
| `/unsubscribe_all`        | Unsubscribe from all events                            |
| `/subscriptions`          | List current active subscriptions                      |
| `/sub_<event>`            | Toggle subscription for specific event                 |
| `/portfolio`              | Show the balances, the last prices and the total value |

`/portfolio` answers at once, whatever the chat is subscribed to, with what the EventSubscriber received through the events: it asks the exchange nothing. Its balances, total, free and used for each watched asset and the currency, are those of the last portfolio the Trader read, as a `portfolioChange` or an order event (`orderInitiated`, `orderCompleted`, `orderCanceled`, `orderErrored`) brought it, with their age, `just now` within a second or when the clock was set back. An order event says when the Trader read the balances it carries, and the answer is dated with that read (`Balances read by the Trader at …`, as below); a `portfolioChange` does not, and the answer is then dated with its arrival, a minute or so after the read at most (`Balances read by the Trader, received at …`). The Trader reads the account at start-up, once the strategy's warmup is over, every `exchangeSynchInterval` in realtime (10 minutes by default) and after each order's end; its `portfolioUpdates` filter holds back the `portfolioChange` of a small change, never the order events. The end of an order carries the read made once it ended. The creation of an order, the end of one whose read failed, and one refused before it was placed carry the Trader's last read as it stands, up to `exchangeSynchInterval` old, each with the time of that read. Without a Trader, or until its first read arrives with the first 1-minute candle processed, the answer opens with `No balance received from the Trader yet (no Trader configured, or its first read still on its way)` instead, and lists no balance. Its prices are each watched pair's close in the last 1-minute candle processed, dated by the end of that minute, and its total value is the currency plus each watched asset at that price (an asset that is not watched, such as BNB kept for the fees, is left out):

```
Balances read by the Trader at 2024-01-15T14:30:02.000Z (3 minutes 12 seconds ago)
BTC: 0.5 (free 0.4, used 0.1)
ETH: 0 (free 0, used 0)
USDT: 10,000 (free 10,000, used 0)
Prices at the close of 2024-01-15T14:33:00.000Z
BTC/USDT: 42,500 USDT
ETH/USDT: 2,550 USDT
Total value: 31,250 USDT
```

> [!NOTE]
> A command can also be addressed to the bot, as `/help@your_bot`, to single it out in a group with other bots. A command addressed to another bot is ignored.

### Available Event Types

| Event Type           | Description                                                                                                                                                                                                     |
|----------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `strat_info`         | The strategy's log lines at `info`, `warn` and `error` (not `debug`), whatever `GEKKO_LOG_LEVEL`, the error line that stops the bot included                                                                    |
| `strat_create`       | New order signals from strategy, with the size asked for: its amount (`auto` for an all-in order), its cost or its share                                                                                        |
| `strat_cancel`       | Order cancellation signals from strategy, naming the order's pair, or saying the strategy did not create the order or that it had ended                                                                         |
| `order_init`         | Order submitted to exchange, with its price: the limit of a LIMIT order given a price, or the price any other is placed or sized at                                                                             |
| `order_cancel`       | Order cancellation confirmed, with what it filled first (`Filled amount: not reported` when the exchange reported no fill) and, for a LIMIT or STICKY order, the mean price of that fill (`Average fill price`) |
| `order_error`        | Order execution failed, with a line saying so when the order may still be live on the exchange, to be checked there                                                                                             |
| `order_complete`     | Order fully executed                                                                                                                                                                                            |
| `roundtrip_complete` | Round trip closed, naming its pair, with its PnL and profit, the profit `unknown` when the Trader had read no portfolio by the time its BUY filled (needs the `RoundTripAnalyzer`)                              |

A `strat_create` message gives the size the strategy asked for on its `Requested amount` line: the amount (`Requested amount: 0.5`), `auto` for an all-in order, a cost in the currency (`Requested amount: 100 USDT worth`) or a share with its base (`Requested amount: 25 % of the USDT` for a BUY, `25 % of the BTC` for a SELL).

A `strat_create` or `order_init` message names the price of its order: `Requested limit price: 42,500 USDT` for a LIMIT order given a price, and for any other `Target price: …`, its price or, without one, the last close of its pair: a MARKET or a STICKY order executes at the market, its price only sizing a BUY by `cost` or `allocation`, or a SELL by `cost`. An `order_cancel` message quotes the limit price of a LIMIT order given one and the last close otherwise (`Current price: …`), and, after the fill of a LIMIT or STICKY order whose fills the exchange priced, their mean price, without the fee: `Average fill price: 42,510.5 USDT`.

A `strat_cancel` message names the pair on its first line, `Strategy requested order cancellation for BTC/USDT`, for an order the strategy created in this run whose end it has not heard of yet, among the 10 000 most recent of those: the StrategyManager forgets the oldest beyond that, which only orders that do not end reach, as without a Trader. For any other id it reads `Strategy requested order cancellation for an order it did not create, or that had ended`, and the Trader, which does not know that order either, warns `[<id>] Impossible to cancel order: Unknown Order`. It can warn so of a request that names its pair too, for an order that has just ended, its report still on its way to the strategy.

### Example Notifications

**Order Completed:**
```
BUY MARKET order completed (abc-123-def) for BTC/USDT
Amount: 0.5 BTC
Price: 42,542.5 USDT
Fee percent: 0.1%
Fee: 21.25 USDT
At time: 2024-01-15T14:30:00.000Z
Current portfolio: 0.5 BTC / 47,500 USDT
------
```

`Price` includes the fee. When no trade of the order reported a fee rate, it reads `Price (excluding fee): 42,500 USDT`, with `Fee percent: unknown` and `Fee: unknown`.

**Roundtrip Completed** (a BUY of 1 BTC at 40,000 and its SELL at 41,000, a 0.1 % fee each, from a portfolio worth 100,000 USDT before the BUY, the price down to 39,500 in between: a PnL of 41,000 − 40,000 − 40 − 41):
```
Roundtrip completed for BTC/USDT
PnL: 919
Profit: 0.91%
Duration: 3 days 4 hours
Entry Price: 40,000
Exit Price: 41,000
Max Adverse Excursion: 1.25%
At time: 2024-01-18T18:30:00.000Z
------
```

Amounts, prices, balances and fees are written as in the console tables: thousands grouped, up to 8 decimals and never an exponent (`47,500`, `0.00000012`). A fee rate keeps its decimals (`0.075%`). A round trip's profit and adverse excursion are rounded down to 2 decimals, as its console table rounds them (0.919 % is `0.91%`), and its duration is counted on the UTC calendar. Its `Profit` reads `unknown` when the Trader had read no portfolio by the time the BUY that opened the round trip filled; its `PnL`, from its fills, is always known. An order error says why after `Due to`, the reason the strategy gets as `order.reason`, without the tag of the failure: `Due to Order 'cost' with value 4.8987648 is out of range. Expected a value between 5 and 9000000.`, not `Due to [EXCHANGE] Order 'cost' …`.

> [!TIP]
> Create a Telegram bot by messaging [@BotFather](https://t.me/BotFather) and following the instructions. Keep your token secure!

---

## 🔧 Supervision

**Purpose:** The Supervision plugin provides system monitoring and health checks via Telegram. It alerts you when resource usage exceeds thresholds and allows you to control monitoring remotely.

### How It Works

1. Connects to Telegram Bot API for command/response interaction
2. Monitors CPU and memory usage at configurable intervals
3. Sends alerts when thresholds are exceeded
4. Validates candle data against exchange for accuracy
5. Monitors application logs and forwards warnings/errors

> [!IMPORTANT]
> Supervision starts subscribed to nothing, and runs no check, so sends no alert, until its chat subscribes: once Gekko runs, send the bot `/subscribe_all`, or the `/sub_...` of each check you want (see [Telegram Commands](#telegram-commands-1)). Until then, the thresholds and intervals below only configure checks that have not started. The subscriptions are kept in memory only: subscribe again after every restart (with `chatId` set, a command your chat sent the bot while Gekko was not running is handled as it starts, as for the EventSubscriber).

### Configuration

```yaml
plugins:
  - name: Supervision
    token: YOUR_TELEGRAM_BOT_TOKEN
    botUsername: YOUR_BOT_USERNAME
    chatId: 123456789             # Your chat id, a number: the only chat the bot answers and alerts
    cpuThreshold: 80              # Alert if CPU > 80%
    memoryThreshold: 1024         # Alert if memory > 1024 MB
    cpuCheckInterval: 10000       # Check CPU every 10 seconds
    memoryCheckInterval: 10000    # Check memory every 10 seconds
    logMonitoringInterval: 60000  # Check logs every 60 seconds
    candleCheckInterval: 60000    # Check every 60 seconds that 1m candles keep coming
    candleStaleThreshold: 180000  # Alert when no 1m candle came for 3 minutes
```

### Configuration Reference

| Parameter               | Type       | Required          | Default  | Description                                                                                                                                 |
|-------------------------|------------|-------------------|----------|---------------------------------------------------------------------------------------------------------------------------------------------|
| `name`                  | string     | Yes               | —        | Must be `Supervision`                                                                                                                       |
| `token`                 | string     | Yes               | —        | Telegram Bot API token                                                                                                                      |
| `botUsername`           | string     | Yes               | —        | Your Telegram bot's username                                                                                                                |
| `chatId`                | integer    | No, but advisable | —        | The only chat whose commands the bot handles and that gets its messages (positive for a private chat, negative for a group; `0` is refused) |
| `cpuThreshold`          | number > 0 | No                | `80`     | CPU usage alert threshold (%)                                                                                                               |
| `memoryThreshold`       | number > 0 | No                | `1024`   | Memory usage alert threshold (MB)                                                                                                           |
| `cpuCheckInterval`      | integer    | No                | `10000`  | CPU check interval (milliseconds)                                                                                                           |
| `memoryCheckInterval`   | integer    | No                | `10000`  | Memory check interval (milliseconds)                                                                                                        |
| `logMonitoringInterval` | integer    | No                | `60000`  | Log monitoring interval (milliseconds)                                                                                                      |
| `candleCheckInterval`   | integer    | No                | `60000`  | Candle freshness check interval (milliseconds)                                                                                              |
| `candleStaleThreshold`  | integer    | No                | `180000` | Age of the last 1-minute candle beyond which the candle check alerts that the candles stopped coming (milliseconds, above `60000`)          |

The four intervals (`cpuCheckInterval`, `memoryCheckInterval`, `logMonitoringInterval` and `candleCheckInterval`) are whole milliseconds between `1000` (one second) and `2147483647` (about 24.8 days, the longest timer delay). `candleStaleThreshold` is a whole number of milliseconds above `60000`: the 1-minute candles come once a minute, so a shorter threshold would alert between every two of them.

> [!IMPORTANT]
> Set `chatId`, as for the EventSubscriber above (whose configuration section also tells how to find your chat id): without it, the first chat to send the bot a command after start-up gets the alerts and the forwarded logs, and controls the monitoring, until Gekko stops.

### Events

**Listens to:**
- `TimeframeCandle` — Validates candles against exchange data

### Telegram Commands

Control monitoring via Telegram commands:

| Command                      | Description                                |
|------------------------------|--------------------------------------------|
| `/help`                      | Show all available commands                |
| `/start`                     | Same as `/help` (sent by the Start button) |
| `/healthcheck`               | Check if Gekko is running                  |
| `/sub_cpu_check`             | Toggle CPU usage monitoring                |
| `/sub_memory_check`          | Toggle memory usage monitoring             |
| `/sub_candle_check`          | Toggle the candle checks (see below)       |
| `/sub_monitor_log`           | Toggle log monitoring (warns/errors)       |
| `/subscribe_all`             | Subscribe to all monitoring                |
| `/unsubscribe_all`           | Unsubscribe from all monitoring            |
| `/subscriptions`             | List current active subscriptions          |

> [!NOTE]
> A command can also be addressed to the bot, as `/help@your_bot`, to single it out in a group with other bots. A command addressed to another bot is ignored.

> [!NOTE]
> Once Gekko is stopping, a command that would start a monitoring (`/subscribe_all`, or a `/sub_...` that subscribes) is answered `Gekko is stopping: no monitoring can start any more` and starts nothing. Unsubscribing still works.

### Monitoring Features

| Feature               | Description                                              |
|-----------------------|----------------------------------------------------------|
| **Health Check**      | Verify the bot process is running                        |
| **CPU Monitoring**    | Alert when CPU usage exceeds threshold                   |
| **Memory Monitoring** | Alert when memory usage exceeds threshold                |
| **Candle Validation** | Compare local candles with exchange data for accuracy    |
| **Candle Freshness**  | Alert when the 1-minute candles stop coming              |
| **Log Monitoring**    | Forward warning and error logs to Telegram               |

### Example Alerts

**CPU Alert:**
```
⚠️ CPU usage exceeded: 85.42%
```

**Memory Alert:**
```
⚠️ Memory usage exceeded: 1156.78 MB
```

**Candle Mismatch** (one line per field that differs, the exchange's value first):
```
⚠️ Timeframe candle mismatch detected: BTC/USDT 1h candle starting at 2024-01-15T14:00:00.000Z (exchange | Gekko)
close: 42500 | 42498
volume: 1234.5 | 1234.7
```

**Candle Stall** (then one message when the candles come again):
```
⚠️ No 1m candle received for 3 minutes, last one @ 2024-01-15T14:00:00.000Z
✅ 1m candles are coming again, last one @ 2024-01-15T14:05:00.000Z
```

> [!NOTE]
> `/sub_candle_check` turns on both candle checks. The validation compares each timeframe candle with the exchange's. The freshness check looks every `candleCheckInterval` at the age of the last 1-minute bucket, because the strategy, the trailing stops and the circuit breaker only run on candles: it sends one alert when that age exceeds `candleStaleThreshold`, then one message when the candles come again. An alert Telegram did not take is logged as a warning and sent again at the next check. Before the first bucket, the age is counted from the subscription. The buckets of the realtime warmup count as they are replayed, however long the warmup, so a subscription made before any candle came alerts only when the first bucket comes more than `candleStaleThreshold` after it: a first page of the warmup history slow to come, for instance, or a run of leading buckets dropped while a watched pair has no candle yet.

> [!NOTE]
> The candle check runs in the background, so a slow or unreachable exchange or Telegram never holds up candles or orders. A timeframe candle that closes while the check of the previous one is still running is not checked (a debug log line says so).

> [!NOTE]
> The Supervision plugin is designed for production deployments where monitoring bot health is critical. For development and testing, it's typically not needed.

### Dependencies

- Requires **exchange** injection for candle validation feature

---

## Plugin Dependencies

Understanding plugin dependencies helps you configure the correct combination for your use case.

### Dependency Graph

```mermaid
graph TD
    subgraph Core Plugins
        TA[TradingAdvisor]
        TR[Trader]
        AN["RoundTripAnalyzer<br>or PortfolioAnalyzer"]
    end
    
    subgraph Data Plugins
        CW[CandleWriter]
        PR[PerformanceReporter]
    end
    
    subgraph Notification Plugins
        ES[EventSubscriber]
        SU[Supervision]
    end
    
    TA -->|"StrategyCreateOrder<br>StrategyCancelOrder<br>StrategyWarmupCompleted"| TR
    TA -->|"TimeframeCandle"| SU
    TR -->|"OrderCompleted<br>OrderCanceled<br>OrderErrored<br>PortfolioChange"| TA
    TA -->|"StrategyWarmupCompleted<br>TimeframeCandle"| AN
    TR -->|"OrderCompleted<br>OrderCanceled<br>OrderErrored<br>PortfolioChange"| AN
    AN -->|"PerformanceReport"| PR
    AN -->|"RoundtripCompleted<br>(RoundTripAnalyzer)"| ES
    TA -->|"StrategyInfo<br>StrategyCreateOrder<br>StrategyCancelOrder"| ES
    TR -->|"Order Events<br>PortfolioChange"| ES
    
    style TA fill:#4CAF50,color:white
    style TR fill:#2196F3,color:white
    style AN fill:#FF9800,color:white
    style CW fill:#9C27B0,color:white
    style PR fill:#E91E63,color:white
    style ES fill:#00BCD4,color:white
    style SU fill:#795548,color:white
```

### Plugin Order

List the TradingAdvisor first, then the Trader, then the analyzer, as the combinations below do. The plugins that emit no event (the PerformanceReporter, the EventSubscriber, Supervision and the CandleWriter) can go anywhere, last by habit. Gekko neither checks nor warns about the order.

Once every plugin has processed a 1-minute candle, the events they queued are delivered in a single pass over `plugins:`, in its order: at its turn, a plugin delivers its own events to every plugin that listens to them, wherever that one is listed. An event a plugin queues after its turn, in answer to the events of a plugin listed after it, waits for the next pass, with the next candle, a minute later. In realtime, what the plugins queue between two candles, such as the end of an order, which the Trader reports as the exchange answers, is delivered in a pass of its own as the next candle arrives, before the plugins process it. So the strategy and the analyzers know of every order ended before a candle when they process it, as in a backtest, and what the strategy does in answer goes out in the pass after that candle.

So a Trader listed before the TradingAdvisor gets the strategy's orders at the TradingAdvisor's turn, after its own, and what it answers comes a minute late: in a backtest, the strategy and the analyzer hear of each fill with the candle after the one it filled on, and the fill of the last minute is never delivered, so the report leaves it out (a SELL of that minute leaves its round trip open). Likewise, a RoundTripAnalyzer listed before the Trader sends its `roundtripCompleted` to the EventSubscriber a minute late.

---

## Recommended Plugin Combinations

Each combination lists its plugins in the order Gekko needs (see [Plugin Order](#plugin-order)).

### Importer Mode

```yaml
plugins:
  - name: CandleWriter    # Required to save candles
```

### Backtest Mode

```yaml
plugins:
  - name: TradingAdvisor
    strategyName: YourStrategy

  - name: Trader

  - name: RoundTripAnalyzer      # Or PortfolioAnalyzer, not both
    enableConsoleTable: true

  - name: PerformanceReporter    # Optional: export to CSV
    filePath: ./reports
```

### Realtime Screener (Alerts Only)

```yaml
exchange:
  name: paper-binance           # Real Binance prices, simulated orders: no API key
  simulationBalance:            # Simulated balances, required by paper-binance
    - assetName: BTC
      balance: 1
    - assetName: USDT
      balance: 10000

plugins:
  - name: TradingAdvisor
    strategyName: RSI

  - name: Trader                # Simulates the orders, whose end the strategy waits for

  - name: EventSubscriber
    token: YOUR_TOKEN
    botUsername: YOUR_BOT
    chatId: 123456789           # Your chat id
```

Keep the Trader, even for alerts: without it, the first order of the strategy never ends, and a built-in strategy advises once per run on each pair (see the TradingAdvisor above). On `paper-binance` it trades nothing for real: the orders are simulated from `simulationBalance`. Once Gekko runs, send the bot `/subscribe_all`, and again after every restart: the EventSubscriber sends nothing until its chat subscribes (see the [EventSubscriber](#-eventsubscriber) above).

### Realtime Trading

```yaml
plugins:
  - name: TradingAdvisor
    strategyName: DEMA

  - name: Trader

  - name: PortfolioAnalyzer
    riskFreeReturn: 5

  - name: EventSubscriber       # Notifications, through a first bot
    token: YOUR_EVENTS_BOT_TOKEN
    botUsername: YOUR_EVENTS_BOT
    chatId: 123456789           # Your chat id

  - name: Supervision           # Health monitoring, through a second bot
    token: YOUR_SUPERVISION_BOT_TOKEN
    botUsername: YOUR_SUPERVISION_BOT
    chatId: 123456789           # The same chat can get both bots
```

> [!NOTE]
> Each Telegram plugin needs its own bot, with its own token: Telegram serves a bot's updates (`getUpdates`) to a single reader at a time, so two plugins on one token conflict, with HTTP 409 errors, and lose each other's commands. Both bots can talk to the same chat, and each sends nothing until that chat subscribes to it: send `/subscribe_all` to each bot once Gekko runs, and again after every restart.

---

## Creating Custom Plugins

Gekko's plugin architecture is extensible. Custom plugins can:

- Listen to any emitted event
- Emit custom events for other plugins
- Access exchange and storage services
- Run code at initialization, on each candle, and at finalization

> [!NOTE]
> Custom plugin development documentation is planned for a future update.
