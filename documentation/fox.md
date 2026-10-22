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

Each variant adds a row to the CSV file of the template's PerformanceReporter, `DEMA_performance_reports.csv` in the working directory for `dema.yml`, its `id` column the values of its `strategy` block joined by `-` (`DEMA-15-100--150` for a period of 15 and an up threshold of 100), so that each row names its parameters. At the default log level a sweep that succeeds prints nothing: set `GEKKO_LOG_LEVEL=info` to follow the variants, and mind the exit code, 1 when a variant failed (see [Logs and Exit Code](#logs-and-exit-code)).

---

## The Template

A template is a whole configuration, written as for Gekko (YAML, JSON or JSON5, see [Modes](./modes.md#-backtest-mode)), that runs a backtest:

- `watch.mode` is `backtest`, the exchange `dummy-cex` with its `marketData` and `simulationBalance`, and `storage.database` the database the candles were imported into;
- its `strategy` block holds every parameter of the strategy, the values Fox does not vary included: each variant starts from it;
- its plugins are `TradingAdvisor`, `Trader`, an analyzer (`PortfolioAnalyzer` or `RoundTripAnalyzer`) and a `PerformanceReporter`, which writes the results: without one, a variant's figures go to its log alone.

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
- a range without both bounds (`12..`), whose start is above its end (`24..12`), or whose step is not a number above 0 (`12..24:0`).

---

## Variants

Fox varies every key given several values, and makes one variant of each combination of their values: `--strategy.period 10..30:5 --strategy.thresholds.up 50,100` gives 5 × 2 = 10 variants, and a key given a single value is set in every variant. Each variant is a copy of the template with the values of its combination set at their keys, the rest of the template as it is: a key Fox varies inside a block keeps the block's other keys (`--strategy.thresholds.up 50,100` leaves `thresholds.down` at the template's value).

The variants are numbered from 1, the first option's values changing last: with the two options above, variant 1 has a period of 10 and an up threshold of 50, variant 2 a period of 10 and 100, variant 3 a period of 15 and 50, and so on. The options under one key count together, at the place of the first of them: `--strategy.period … --watch.timeframe … --strategy.thresholds.up …` takes them in the order period, up threshold, timeframe, the timeframe's values changing first. Fox names a variant by its number and its options of several values, as the command line writes them: `Variant 3 of 10 (--strategy.period 15 --strategy.thresholds.up 50)`.

Any key of the template can vary, not only those of the strategy: `--watch.warmup.candleCount 50,100` backtests each combination after a warmup of 50 candles and after one of 100, and a single value sets that key in every variant (`--watch.timeframe 4h`, `--watch.daterange.start 2024-06-01`, a range that must be in the database too).

---

## Checked Before the First Backtest

Before any worker starts, Fox checks every variant as Gekko would check its configuration file: the configuration as a whole, its `watch.mode`, which must be `backtest` (a realtime variant would trade until stopped, an importer one would write candles), the strategy its TradingAdvisor names, which must be one of Gekko's, and its `strategy` block against that strategy's parameters (a strategy loaded through a `strategyPath` is checked as each worker starts), and each entry of `plugins`, whose name must be a plugin's, against the options of its plugin. The first variant refused stops Fox with exit code 1, before any backtest, naming the variant, its values and every problem, each with its path from the root of the configuration; with `--strategy.period 1..3` on the DEMA template:

```
[FOX] Variant 1 (--strategy.period 1) is invalid:
✖ period must be at least 2 (the DEMA and the SMA of a single candle are both its close, so they never differ)
  → at strategy.period
```

So a sweep that would fail on its last variant fails at once, rather than after hours of the others.

---

## Workers

Fox runs the variants in worker threads of its own process, `--max-workers` of them at once, the next variant starting as soon as one ends. Each worker loads Gekko's modules anew (about a second from source) and runs one backtest exactly as `dist/gekko` would run its configuration: it reads the candles from the template's database (the workers read one database side by side, each through a read-only connection), runs the strategy, the Trader and the analyzer on Gekko's simulated exchange, and the PerformanceReporter adds its row. A variant that fails (a missing minute in the database, an exception in the strategy) is reported as failed, and the others go on.

Each worker holds its backtest in memory, its modules, its candles and its orders: lower `--max-workers` when the machine runs short of memory, or when the backtests leave it too little to do anything else.

---

## Results

The PerformanceReporter of the template writes the results: each variant adds its row to the file its `fileName` names, in the directory of its `filePath` (the directory Fox runs in by default), with the columns described under [PerformanceReporter](./plugins.md#-performancereporter). A row's `id` is the values of the variant's `strategy` block joined by `-`, which tells the variants apart, and its `status` column says whether the backtest completed.

Variants ending together take turns: the PerformanceReporter writes a row while holding the lock file `<fileName>.lock`, in up to 6 attempts 25 to 75 ms apart, so that no two rows mix. A row that still does not get the lock is lost, with an error line naming the lock file (`report lost: <id> not written, <file> could not be locked (…)`): run the variant again on its own (give each of its keys its one value) to get it.

A file that already holds rows keeps them: the rows of a new sweep are added after those of the earlier ones. Give each sweep a `fileName` of its own (`--plugins.3.fileName DEMA_periods.csv` on the shipped templates, whose PerformanceReporter is their fourth plugin), or move the file aside, to compare one sweep's rows only.

---

## Logs and Exit Code

Fox logs its own lines, tagged `fox`, at the level `GEKKO_LOG_LEVEL` sets, `error` by default, so that a sweep that succeeds prints nothing; set `info` to follow the variants:

```bash
GEKKO_LOG_LEVEL=info ./dist/fox --template-path apps/fox/templates/tma.yml --strategy.short 5..10 --strategy.long 50,100
```

It logs Gekko's version, then `Backtesting 12 variants of apps/fox/templates/tma.yml, 8 at a time`, a line as each variant starts, `Variant 3 of 12 (--strategy.short 6 --strategy.long 50) started`, and as it ends, `… done in 10 seconds` (the backtest's own duration), or, at `error` level, `… failed after 15 seconds: <reason>`, and at the end the summary: `12 variants, 0 failed` at `info`, `12 variants, 2 failed: variants 2 and 4` at `error`. Each worker logs its backtest at the same level, on the same output, its lines among Fox's and the other workers': at `info`, every variant's start-up and report too, and at `warn` and below the warning each backtest gives as it starts.

Fox exits with code 0 when every variant completed, and after `--help`; with code 1 when a variant failed, when a variant or an option is refused, when the template cannot be read, or when anything else throws. Ctrl-C (SIGINT) and SIGTERM stop Fox and every worker at once, with the codes a shell reports for them (130 and 143): the variants in progress write no row, and the rows written stay.

---

## Troubleshooting

### "[FOX] No template: give its path with --template-path <path> or FOX_TEMPLATE_PATH"

Fox needs the template: give `--template-path` (`-t`), or set `FOX_TEMPLATE_PATH`. Written last without its value, `-t` or `-w` is refused by the command line's own reader: `[FOX] option '-t, --template-path <path>' argument missing`.

### "[FOX] Variant … is invalid"

A variant was refused before any backtest (see [Checked Before the First Backtest](#checked-before-the-first-backtest)): the line under each `✖` names the key, and the problem is either in the template, which every variant shares, or in a value Fox set. Check the template alone first, with Gekko (`GEKKO_CONFIG_FILE_PATH=<template> ./dist/gekko`), then the values: a period below the strategy's minimum, a key misspelt on the command line (`--strategy.perod`), which the strategy refuses as an unknown parameter.

### "Unexpected argument …", "… has no value" or "Invalid range …"

The command line itself was refused (see [Values: Lists and Ranges](#values-lists-and-ranges)): a value written after the first (`--strategy.period 12 24`, write `12,24`), an option without its value, or a range that is not `<from>..<to>` or `<from>..<to>:<step>`, of numbers, its start at most its end and its step above 0.

### A variant failed with "Missing candles in database" or "Cannot open the database"

The backtest of that variant found no database at `storage.database`, or a minute of its range missing there: import the range first, from the directory Fox runs in (see [Modes](./modes.md#-importer-mode)). A relative `storage.database` is read from the directory Fox is started from, not from the template's. A variant whose range starts before the first candle of a large database fails once the check has read it, which can take some seconds.

### The machine slows down or runs out of memory

Each worker holds a whole backtest: lower `--max-workers` (see [Workers](#workers)).
