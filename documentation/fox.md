# Fox

Fox compares the parameters of a strategy by backtesting them all. You give it a template, a backtest configuration as Gekko reads one, and, on its command line, the values to try for some of the template's keys: Fox makes one configuration of each combination of those values, a variant, checks every variant, then backtests them side by side, each in a worker of its own. The template's PerformanceReporter adds the figures of each variant as a row of one CSV file, which you then sort and compare.

Fox is the second executable of the Gekko checkout: `bun run build:exec` compiles it to `dist/fox`, beside `dist/gekko`, and each GitHub release comes with both. It runs the backtests itself, with Gekko's own pipeline, so it needs neither `dist/gekko` nor a configuration file per variant.

---

## Table of Contents

- [Quick Start](#quick-start)
- [The Template](#the-template)
- [Options](#options)
- [Values: Lists and Ranges](#values-lists-and-ranges)
- [Variants](#variants)
- [Checked Before the First Backtest](#checked-before-the-first-backtest)
- [Workers](#workers)
- [Results](#results)
- [Logs and Exit Code](#logs-and-exit-code)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

### 1. Import the Candles

A backtest reads its candles from `storage.database`, and refuses to start while a minute of `watch.daterange` is missing there: so does every variant. The templates shipped with Fox, `apps/fox/templates/dema.yml` and `apps/fox/templates/tma.yml`, backtest BTC and ETH over 2024 on `./db/binance-BTC_ETH_USDT.sql`, the database `config/importer.yml` writes. Import it first, from the root of the checkout (see the [Quick Start guide](./quick-start.md) for the executable and `.env.local`):

```bash
GEKKO_CONFIG_FILE_PATH=./config/importer.yml ./dist/gekko
```

### 2. Run Fox

From the root of the checkout, where the template's relative paths lead (`./db/…`, and the CSV file the PerformanceReporter writes):

```bash
# 5 periods (10, 15, 20, 25 and 30) × 2 up thresholds (50 and 100): 10 variants, 4 at a time
./dist/fox --template-path apps/fox/templates/dema.yml --strategy.period 10..30:5 --strategy.thresholds.up 50,100 --max-workers 4

# The same from source, without building
bun run dev:fox --template-path apps/fox/templates/dema.yml --strategy.period 10..30:5 --strategy.thresholds.up 50,100 --max-workers 4

# Fox's usage, its options and how values are written
./dist/fox --help
```

### 3. Read the Results

Each variant adds a row to the CSV file of the template's PerformanceReporter, `DEMA_performance_reports.csv` in the working directory for `dema.yml`, its `id` column the values of its `strategy` block joined by `-`, then, in parentheses, the values Fox gave the variant (`DEMA-15-100--150 (--strategy.period 15 --strategy.thresholds.up 100)`), so that each row names its variant (see [Results](#results)). At the default log level a sweep that succeeds prints nothing: set `GEKKO_LOG_LEVEL=info` to follow the variants, and mind the exit code, 1 when a variant failed (see [Logs and Exit Code](#logs-and-exit-code)).

---

## The Template

A template is a whole configuration, written as for Gekko (YAML, JSON or JSON5, see [Modes](./modes.md#-backtest-mode)), that runs a backtest:

- `watch.mode` is `backtest`, the exchange `dummy-cex` with its `marketData` and `simulationBalance`, and `storage.database` the database the candles were imported into;
- its `strategy` block holds every parameter of the strategy, the values Fox does not vary included: each variant starts from it;
- its plugins are `TradingAdvisor`, `Trader`, an analyzer (`PortfolioAnalyzer` or `RoundTripAnalyzer`, not both: they send the same report) and a `PerformanceReporter`, which writes the results: without one, a variant's figures go to its log alone, and Fox warns of it as it starts. Each must run in backtest mode, which the `CandleWriter`, the `EventSubscriber` and `Supervision` do not.

A relative path of the template, `storage.database` and the PerformanceReporter's file, is read from the directory Fox runs in, not from the template's: run Fox from the root of the checkout, or point a sweep at another database with `--storage.database /path/to/db.sql`.

`apps/fox/templates/dema.yml` reads as follows, `tma.yml` the same with TMA (`short: 10`, `medium: 21`, `long: 50`, `src: close`):

```yaml
# Fox's template for DEMA: backtests BTC and ETH in 2024 on the database config/importer.yml writes, run that import first. Each option
# of Fox's command line sets a key of it, and its lists and ranges make the variants (documentation/fox.md):
#   fox --template-path apps/fox/templates/dema.yml --strategy.period 10..30:5 --strategy.thresholds.up 50,100

showLogo: false
watch:
  assets:
    - BTC
    - ETH
  currency: USDT
  timeframe: 1h
  mode: backtest
  warmup:
    candleCount: 100
  daterange:
    start: '2024-01-01T00:00:00.000Z'
    end: '2024-12-31T23:59:00.000Z'

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
        precision:
          price: 8
          amount: 8
        fee:
          maker: 0.0004
          taker: 0.0007
    - symbol: ETH/USDT
      marketData:
        price:
          min: 0.01
          max: 1000000
        amount:
          min: 0.0001
          max: 9000
        cost:
          min: 5
          max: 9000000
        precision:
          price: 8
          amount: 8
        fee:
          maker: 0.0004
          taker: 0.0007
  simulationBalance:
    - assetName: BTC
      balance: 0
    - assetName: ETH
      balance: 0
    - assetName: USDT
      balance: 1000

storage:
  type: sqlite
  database: ./db/binance-BTC_ETH_USDT.sql

# The thresholds are in USDT and apply to both pairs: values that suit BTC/USDT are wide for ETH/USDT, priced some twenty times less
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
    portfolioUpdates:
      threshold: 1 # in percentage
      dust: 10 # in currency

  # Without enableConsoleTable: an analyzer prints its table whatever the log level, and each variant would print its own
  - name: PortfolioAnalyzer

  # Each variant adds its row to this file, in the directory Fox runs in
  - name: PerformanceReporter
    fileName: DEMA_performance_reports.csv
```

Leave `enableConsoleTable` out of the analyzer of a template, as its comment says: an analyzer prints its table whatever the log level, so each variant would print its own, one after the other.

---

## Options

| Option                       | Environment variable | Default                    | Description                                                                                                                              |
|------------------------------|----------------------|----------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `-t, --template-path <path>` | `FOX_TEMPLATE_PATH`  | none: required             | The template, a backtest configuration (`.yml`, `.yaml`, `.json` or `.json5`), absolute or relative to the directory Fox is started from |
| `-w, --max-workers <count>`  | `FOX_MAX_WORKERS`    | the threads of the machine | How many variants are backtested at once, a whole number of at least 1 (`os.availableParallelism()` by default)                          |
| `--<key> <values>`           |                      |                            | The values to try at that key of the template, its path written with dots (`--strategy.thresholds.up 50,100`), or `--<key>=<values>`     |
| `-h, --help`                 |                      |                            | Prints the usage, the options and how values are written, then exits with code 0                                                         |

An option given on the command line wins over its environment variable, and an empty variable counts as unset. The overrides may come before or after Fox's own options. Fox reads `GEKKO_LOG_LEVEL` as Gekko does (see [Logs and Exit Code](#logs-and-exit-code)), and Bun loads `.env` and `.env.local` from the directory Fox runs in, as for Gekko.

Fox's own options are read wherever they are, a value that starts like one of them included: `--strategy.src -tma` sets the template to `ma`, then finds `--strategy.src` without a value. Write such a value in the `=` form, `--strategy.src=-tma`, or after a bare `--`, which ends Fox's own options: `-t dema.yml -- --strategy.src -tma`. Fox skips a `--` among the overrides, wherever it is.

---

## Values: Lists and Ranges

| Written         | Values tried                                                          |
|-----------------|-----------------------------------------------------------------------|
| `14`            | 14 alone, in every variant                                            |
| `12,24`         | 12 and 24, a variant each                                             |
| `12..24`        | every number from 12 to 24, both included, a step of 1                |
| `12..24:4`      | 12, 16, 20 and 24, a step of 4                                        |
| `12..24:5`      | 12, 17, 22 and 24: the end is always tried                            |
| `0.5..0.75`     | 0.5, 0.51, … 0.75: without a step, a unit of the bounds' last decimal |
| `12..12`        | 12 alone                                                              |
| `10,20..30:5`   | a list holding a range: 10, 20, 25 and 30                             |
| `close,ohlc4`   | two texts                                                             |
| `true`, `false` | the booleans `true` and `false`                                       |

A value that reads as a number (digits, a minus sign before them, a decimal point between them) is a number, `true` and `false` are booleans, and anything else is a text, `1e3` and `.5` included. A value holding a `/` or a `\` is a text whatever its dots, so that a path such as `../db/x.sql` is not read as a range. The values of a range are added up in decimal: `0.1..0.3` holds 0.3.

Fox refuses before anything runs, with a line saying why:

- a value written after the first, `--strategy.period 12 24` (write `12,24`): `Unexpected argument "24": an override is written --<key> <values> (--strategy.period 12,24)`;
- an option without a value, or a list with an empty item (`1,,2`);
- a key given twice, or one inside another (`--strategy.thresholds` and `--strategy.thresholds.up`): give one of them;
- a key named `__proto__`, `constructor` or `prototype`, which names no key of a configuration;
- a key that names an item of a list of the template otherwise than by its index (`--plugins.Trader.portfolioUpdates.threshold`, see [Variants](#variants));
- a range without both bounds (`12..`), whose start is above its end (`24..12`), or whose step is not a number above 0 (`12..24:0`);
- a range whose step leaves a value as it is, which would never reach its end: bounds of 17 significant digits (`0.30000000000000004..0.5`, whose step by default is 0.00000000000000001), a step below what its start can change by (`1..2:0.0000000000000001`), bounds at 9007199254740992 and above, where a number no longer changes by 1: `Invalid range "0.30000000000000004..0.5" of --x: its step of 0.00000000000000001 leaves 0.30000000000000004 as it is, …`;
- a range of more than 10 000 values, the most variants Fox makes: `Invalid range "2..100001" of --strategy.period: it holds 100000 values, more than the 10000 variants Fox makes at most: narrow it, or give it a larger step`.

---

## Variants

Fox varies every key given several values, and makes one variant of each combination of their values: `--strategy.period 10..30:5 --strategy.thresholds.up 50,100` gives 5 × 2 = 10 variants, and a key given a single value is set in every variant. Each variant is a copy of the template with the values of its combination set at their keys, the rest of the template as it is: a key Fox varies inside a block keeps the block's other keys (`--strategy.thresholds.up 50,100` leaves `thresholds.down` at the template's value).

The variants are numbered from 1, the first option's values changing last: with the two options above, variant 1 has a period of 10 and an up threshold of 50, variant 2 a period of 10 and 100, variant 3 a period of 15 and 50, and so on. The options under one key count together, at the place of the first of them: `--strategy.period … --watch.timeframe … --strategy.thresholds.up …` takes them in the order period, up threshold, timeframe, the timeframe's values changing first. Under one key, the keys that are whole numbers, the indexes of a list such as `plugins`, come first and in ascending order, whatever their order on the command line: `--plugins.2.riskFreeReturn 0,5 --plugins.1.portfolioUpdates.threshold 1,5` takes the Trader's threshold before the analyzer's risk-free return, whose values change first: variant 1 is `--plugins.1.portfolioUpdates.threshold 1 --plugins.2.riskFreeReturn 0`, variant 2 `… threshold 1 … riskFreeReturn 5`. Fox names a variant by its number and its options of several values, in that order, as the command line writes them, a number with every decimal (`0.0000001`, which the command line reads back as that number, not `1e-7`, which it reads as a text): `Variant 3 of 10 (--strategy.period 15 --strategy.thresholds.up 50)`.

Fox makes 10 000 variants at most: options whose values would make more are refused before any variant is made, naming the values of each (`The overrides make 10100 variants (100 values of --strategy.period × 101 values of --strategy.thresholds.up), more than the 10000 Fox makes at most: give them fewer values`).

Any key of the template can vary, not only those of the strategy: `--watch.warmup.candleCount 50,100` backtests each combination after a warmup of 50 candles and after one of 100, and a single value sets that key in every variant (`--watch.timeframe 4h`, `--watch.daterange.start 2024-06-01`, a range that must be in the database too).

An item of a list of the template, `plugins`, `watch.assets`, `exchange.marketData` or `exchange.simulationBalance`, is named by its index, from 0, in the order of the list: `--exchange.marketData.0.marketData.fee.maker 0.0004,0.01` sets the maker fee of BTC/USDT, the first entry of the shipped templates' `marketData`, and `--exchange.simulationBalance.2.balance 1000,5000` the balance of USDT, their third. An index one past the last item adds an item, which the variant's configuration must then accept as a whole. Any other key of a list, the symbol of a pair, the name of an asset or of a plugin, `01`, `-1` or `length`, would set nothing a backtest reads, so Fox refuses it before any variant is made, naming the list and its indexes: `--exchange.marketData.BTC/USDT.marketData.fee.maker: exchange.marketData is a list, name its item by its index (0 or 1)`.

---

## Checked Before the First Backtest

Before any worker starts, Fox checks every variant as Gekko would check its configuration file: the configuration as a whole, its `watch.mode`, which must be `backtest` (a realtime variant would trade until stopped, an importer one would write candles), the strategy its TradingAdvisor names, which must be one of Gekko's, and its `strategy` block against that strategy's parameters (a strategy loaded through a `strategyPath` is checked as each worker starts), and each entry of `plugins`, whose name must be a plugin's (`No plugin is named "trader" (did you mean "Trader"?): the plugins are …`), against the options of its plugin, an analyzer's `benchmarkAsset` included, which must be one of `watch.assets` (`benchmarkAsset must be one of the watched assets (BTC and ETH), got "SOL"`, at `plugins[2].benchmarkAsset`). Each plugin must run in backtest mode (`Plugin CandleWriter does not support backtest mode, only realtime and importer`), and no two may send the same event: the PortfolioAnalyzer and the RoundTripAnalyzer both send the performance report (`Plugins PortfolioAnalyzer (plugins[2]) and RoundTripAnalyzer are broadcasting the same event: performanceReport. This behavior is unsupported.`, at the second of them), so keep one. Fox refuses a plugin entry in Gekko's own words, at the path of the entry, the index of the earlier of two plugins sending one event added. The first variant refused stops Fox with exit code 1, before any backtest, naming the variant, its values and every problem, each with its path from the root of the configuration; with `--strategy.period 1..3` on the DEMA template:

```
[FOX] Variant 1 (--strategy.period 1) is invalid:
✖ period must be at least 2 (the DEMA and the SMA of a single candle are both its close, so they never differ)
  → at strategy.period
```

So a sweep that would fail on its last variant fails at once, rather than after hours of the others.

A template without a PerformanceReporter is not refused, its backtests run, but Fox warns as it starts, at `warn` level, that no CSV row will record their figures: `The template has no PerformanceReporter: no CSV row will record the figures of its variants`. The analyzer of each variant still logs its report at `info` level in the output of its worker, and prints it as a table with `enableConsoleTable`, whatever the level.

---

## Workers

Fox runs the variants in worker threads of its own process, `--max-workers` of them at once, the next variant starting as soon as one ends. Each worker loads Gekko's modules anew (about a second from source) and runs one backtest exactly as `dist/gekko` would run its configuration: it reads the candles from the template's database (the workers read one database side by side, each through a read-only connection), runs the strategy, the Trader and the analyzer on Gekko's simulated exchange, and the PerformanceReporter adds its row. A variant that fails (a missing minute in the database, an exception in the strategy) is reported as failed, and the others go on.

Each worker holds its backtest in memory, its modules, its candles and its orders: lower `--max-workers` when the machine runs short of memory, or when the backtests leave it too little to do anything else.

---

## Results

The PerformanceReporter of the template writes the results: each variant adds its row to the file its `fileName` names, in the directory of its `filePath` (the directory Fox runs in by default), with the columns described under [PerformanceReporter](./plugins.md#-performancereporter). A row's `id` is the values of the variant's `strategy` block joined by `-`, then, in parentheses, the variant's label: its options of several values, as Fox names the variant in its log. Fox gives that label to every PerformanceReporter of each variant, as the reporter's `label` option, so that variants whose `strategy` blocks are the same, a sweep of a fee or of a balance, are told apart; its `status` column says whether the backtest completed. Two maker fees of BTC/USDT over the first 10 days of the DEMA template, `--watch.daterange.end 2024-01-10T23:59:00Z --exchange.marketData.0.marketData.fee.maker 0.0004,0.01`, write:

```
id;report type;pair;timeframe;net profit;total return;…;status
DEMA-12-100--150 (--exchange.marketData.0.marketData.fee.maker 0.0004);Portfolio;BTC/USDT ETH/USDT;1h;37.683173;3.76%;…;completed
DEMA-12-100--150 (--exchange.marketData.0.marketData.fee.maker 0.01);Portfolio;BTC/USDT ETH/USDT;1h;0.3106285;0.03%;…;completed
```

A sweep of a single variant writes the `id` without a label, as Gekko does. A PerformanceReporter that has a `label` of its own, in the template or set by an option (`--plugins.3.label baseline`), keeps it, followed by the variant's: `DEMA-12-100--150 (baseline --exchange.marketData.0.marketData.fee.maker 0.01)`, and its label alone in a sweep of a single variant. The rows come in the order the variants end, not in the order of their numbers: each names its variant by its `id`.

Variants ending together take turns: the PerformanceReporter writes a row while holding the lock file `<fileName>.lock`, trying for up to a minute, 25 to 75 ms between two attempts, so that no two rows mix. A row that still does not get the lock is lost, with an error line naming the lock file (`report lost: <id> not written, <file> could not be locked (…)`), and its variant fails, as does a variant whose row the reporter could not write for another reason, a file whose first line is not its header or a write error (see [PerformanceReporter](./plugins.md#-performancereporter)): `Variant 3 of 12 (--strategy.period 14) failed after 12 seconds: PerformanceReporter failed to finalize: The TRADING REPORT row was not written: <file> could not be locked (see the error logged above)`, the summary names it and Fox exits with code 1, so that a row missing from the file never goes unnoticed. Run the variant again on its own (give each of its keys its one value, and its PerformanceReporter the label of the row's `id`, the part in parentheses, in the `=` form, which a value starting with `--` takes: `--plugins.3.label='--strategy.period 14'`, or `--plugins.3.label='baseline --strategy.period 14'` after a label of the template's own) to get its row.

A file that already holds rows keeps them: the rows of a new sweep are added after those of the earlier ones. Give each sweep a `fileName` of its own (`--plugins.3.fileName DEMA_periods.csv` on the shipped templates, whose PerformanceReporter is their fourth plugin), or move the file aside, to compare one sweep's rows only.

---

## Logs and Exit Code

Fox logs its own lines, tagged `fox`, at the level `GEKKO_LOG_LEVEL` sets, `error` by default, so that a sweep that succeeds prints nothing; set `info` to follow the variants:

```bash
GEKKO_LOG_LEVEL=info ./dist/fox --template-path apps/fox/templates/tma.yml --strategy.short 5..10 --strategy.long 50,100
```

It logs Gekko's version, then `Backtesting 12 variants of apps/fox/templates/tma.yml, 8 at a time`, a line as each variant starts, `Variant 3 of 12 (--strategy.short 6 --strategy.long 50) started`, and as it ends, `… done in 10 seconds` (the backtest's own duration), or, at `error` level, `… failed after 15 seconds: <reason>`, and at the end the summary: `12 variants, 0 failed` at `info`, `12 variants, 2 failed: variants 2 and 4` at `error`. A failure that is not one of Gekko's own refusals, an exception in a strategy for one, is followed at `debug` level by its stack and causes, which say where it was thrown: `Variant 3 of 12 (…): TypeError: … at onTimeframeCandleAfterWarmup (…/my.strategy.ts:5:20) …`. Each worker logs its backtest at the same level, on the same output, its lines among Fox's and the other workers': at `info`, every variant's start-up and report too, and at `warn` and below the warning each backtest gives as it starts.

Fox exits with code 0 when every variant completed, and after `--help`; with code 1 when a variant failed (its backtest, or the writing of its row, see [Results](#results)), when a variant or an option is refused, when the template cannot be read, or when anything else throws. Ctrl-C (SIGINT) and SIGTERM stop Fox and every worker at once, with the codes a shell reports for them (130 and 143): the variants in progress write no row, and the rows written stay. The lines of Fox and of its workers are written before the call that logs them returns, so that none is lost when a worker or Fox exits: piped into a pager that is not scrolled, Fox waits.

---

## Troubleshooting

### "[FOX] No template: give its path with --template-path <path> or FOX_TEMPLATE_PATH"

Fox needs the template: give `--template-path` (`-t`), or set `FOX_TEMPLATE_PATH`. Written last without its value, `-t` or `-w` is refused by the command line's own reader: `[FOX] option '-t, --template-path <path>' argument missing`.

### "[FOX] Variant … is invalid"

A variant was refused before any backtest (see [Checked Before the First Backtest](#checked-before-the-first-backtest)): the line under each `✖` names the key, and the problem is either in the template, which every variant shares, or in a value Fox set. Check the template alone first, with Gekko (`GEKKO_CONFIG_FILE_PATH=<template> ./dist/gekko`, which runs its whole backtest and adds its row to the CSV file), then the values: a period below the strategy's minimum, a key misspelt on the command line (`--strategy.perod`), which the strategy refuses as an unknown parameter.

### "Unexpected argument …", "… has no value" or "Invalid range …"

The command line itself was refused (see [Values: Lists and Ranges](#values-lists-and-ranges)): a value written after the first (`--strategy.period 12 24`, write `12,24`), an option without its value (a value that starts with `-t`, `-w` or `-h` is taken for one of Fox's options: write it `--strategy.src=-tma`), or a range that is not `<from>..<to>` or `<from>..<to>:<step>`, of numbers, its start at most its end and its step above 0, a step that changes its values and 10 000 values at most.

### "… is a list, name its item by its index"

An option names an item of a list of the template by its symbol, its asset, its plugin's name or a number written otherwise than as an index (`01`, `-1`): count the items of the list in the template, from 0, and write that index in the key (see [Variants](#variants)), `--plugins.3.fileName` for the fourth plugin.

### "The overrides make … variants, more than the 10000 Fox makes at most"

The values of the options multiply: give them fewer values, a larger step to a range, or split the sweep into several runs, each writing its rows to the same file (see [Results](#results)).

### A variant failed with "Missing candles in database" or "Cannot open the database"

The backtest of that variant found no database at `storage.database`, or a minute of its range missing there: import the range first, from the directory Fox runs in (see [Modes](./modes.md#-importer-mode)). A relative `storage.database` is read from the directory Fox is started from, not from the template's. A variant whose range starts before the first candle of a large database fails once the check has read it, which can take some seconds.

### A variant failed with "PerformanceReporter failed to finalize: The … row was not written"

The backtest of that variant completed, but its row did not reach the CSV file, and the error logged before the failure says why: the lock file `<fileName>.lock` could not be taken within a minute (something else holds it, or the directory refuses it: delete it if no run is writing the file), the first line of the file is not the reporter's header (a file written by an older version: move or rename it), or the write failed (a full disk, a permission). Fix the cause, then run the variant again on its own (see [Results](#results)).

### The machine slows down or runs out of memory

Each worker holds a whole backtest: lower `--max-workers` (see [Workers](#workers)).
