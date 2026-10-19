# 📊 Technical Indicators

Gekko provides **31 built-in technical indicators** organized into six categories. A strategy registers the ones it needs in `init`, by name, with `addIndicator(name, symbol, params)`: Gekko then feeds each one the timeframe candles of its pair and hands its result to the strategy's hooks (see [Using Indicators in Strategies](#-using-indicators-in-strategies)).

Where TA-Lib has the indicator, Gekko follows its definition and its first candle, and the section says where Gekko departs from it. Each section gives:

- the indicator's **name**, the one `addIndicator` takes (it is case-sensitive);
- its **parameters**, with their constraint and default: Gekko refuses a parameter outside its constraint at start-up (see [Parameter Checks](#parameter-checks));
- its **output**, and the candle of its **first value**: before it the result is `null`, from it a complete value on every candle (see [Reading Results](#reading-results));
- an `addIndicator` call, `pair` being one of the watched pairs (see [Basic Usage](#basic-usage)).

Candles are counted from the first one the indicator gets: in a strategy, the first timeframe candle of the run, warmup included.

---

## Table of Contents

- [Indicators at a Glance](#-indicators-at-a-glance)
- [Moving Averages](#-moving-averages)
- [Momentum Indicators](#-momentum-indicators)
- [Directional Movement](#-directional-movement)
- [Oscillators](#-oscillators)
- [Volatility Indicators](#-volatility-indicators)
- [Volume Indicators](#-volume-indicators)
- [Common Parameters](#-common-parameters)
- [Using Indicators in Strategies](#-using-indicators-in-strategies)

---

## 📋 Indicators at a Glance

L(p) is the lookback of a p-candle moving average, the candles before its first value: p − 1 for an `sma`, `ema` or `wma`, 2 × (p − 1) for a `dema` (see [Moving Average Types](#moving-average-types)).

| Name                                                       | Output                      | First value at candle                               | With the defaults |
|------------------------------------------------------------|-----------------------------|-----------------------------------------------------|-------------------|
| [`SMA`](#sma--simple-moving-average)                       | number                      | `period`                                            | 30                |
| [`EMA`](#ema--exponential-moving-average)                  | number                      | `period`                                            | 30                |
| [`DEMA`](#dema--double-exponential-moving-average)         | number                      | 2 × `period` − 1                                    | `period` required |
| [`WMA`](#wma--weighted-moving-average)                     | number                      | `period`                                            | `period` required |
| [`TEMA`](#tema--triple-exponential-moving-average)         | number                      | 3 × `period` − 2                                    | `period` required |
| [`SMMA`](#smma--smoothed-moving-average)                   | number                      | `period`                                            | `period` required |
| [`WilderSmoothing`](#wilder-smoothing)                     | number                      | `period`                                            | 14                |
| [`EMARibbon`](#ema-ribbon)                                 | `{ results, spread }`       | `start` + (`count` − 1) × `step`                    | 66                |
| [`MACD`](#macd--moving-average-convergence-divergence)     | `{ macd, signal, hist }`    | `long` + `signal` − 1                               | 34                |
| [`Stochastic`](#stochastic-oscillator)                     | `{ k, d }`                  | `fastKPeriod` + L(`slowKPeriod`) + L(`slowDPeriod`) | 9                 |
| [`StochasticRSI`](#stochastic-rsi)                         | `{ fastK, fastD }`          | `period` + `fastKPeriod` + L(`fastDPeriod`)         | 21                |
| [`PSAR`](#psar--parabolic-stop-and-reverse)                | number                      | 2                                                   | 2                 |
| [`ROC`](#roc--rate-of-change)                              | number                      | `period` + 1                                        | `period` required |
| [`TRIX`](#trix)                                            | number                      | 3 × `period` − 1                                    | 89                |
| [`WilliamsR`](#williams-r)                                 | number                      | `period`                                            | 14                |
| [`ADX`](#adx--average-directional-index)                   | number                      | 2 × `period`                                        | `period` required |
| [`ADXRibbon`](#adx-ribbon)                                 | `{ results, spread }`       | 2 × (`start` + (`count` − 1) × `step`)              | 132               |
| [`DX`](#dx--directional-movement-index)                    | number                      | `period` + 1                                        | `period` required |
| [`PlusDI`, `MinusDI`](#di-and--di--directional-indicators) | number                      | `period` + 1                                        | `period` required |
| [`PlusDM`, `MinusDM`](#dm-and--dm--directional-movement)   | number                      | `period`, or 2 when `period` is 1                   | `period` required |
| [`RSI`](#rsi--relative-strength-index)                     | number                      | `period` + 1                                        | 15                |
| [`CCI`](#cci--commodity-channel-index)                     | number                      | `period`                                            | 14                |
| [`AO`](#ao--awesome-oscillator)                            | number                      | `long`                                              | 34                |
| [`ATR`](#atr--average-true-range)                          | number                      | `period` + 1                                        | `period` required |
| [`ATRCD`](#atrcd--atr-convergence-divergence)              | `{ atrcd, signal, hist }`   | `long` + `signal`                                   | 35                |
| [`BollingerBands`](#bollinger-bands)                       | `{ upper, middle, lower }`  | `period`, or 2 × `period` − 1 with a `dema`         | 5                 |
| [`TrueRange`](#true-range)                                 | number                      | 2                                                   | 2                 |
| [`OBV`](#obv--on-balance-volume)                           | `{ obv, ma, upper, lower }` | `period`, or 2 × `period` − 1 with a `dema`         | 14                |
| [`EFI`](#efi--elders-force-index)                          | `{ fi, smoothed }`          | `period` + 1, or 2 × `period` with a `dema`         | 14                |

---

## 📈 Moving Averages

Moving averages smooth price data to identify trends and potential support/resistance levels. Each one reads one price per candle, the close unless its `src` names another (see [Price Sources](#price-sources)), and gives a number, EMA Ribbon one per EMA with their spread (`{ results, spread }`). SMA, EMA, DEMA and WMA are also the four kinds a `maType` parameter takes (see [Moving Average Types](#moving-average-types)).

### SMA — Simple Moving Average

The **Simple Moving Average** calculates the arithmetic mean of prices over a specified period. All data points are weighted equally.

| Parameter | Type   | Default | Constraint                       | Description                  |
|-----------|--------|---------|----------------------------------|------------------------------|
| `period`  | number | 30      | whole number ≥ 1                 | Number of candles to average |
| `src`     | string | 'close' | a [price source](#price-sources) | Price read from each candle  |

- **Name:** `SMA`
- **Output:** a number
- **First value:** candle `period`

**Formula:** `SMA = Sum(Price, n) / n`

```typescript
addIndicator('SMA', pair, { period: 20 });
```

**Use Cases:**
- Identifying long-term trends
- Dynamic support and resistance levels
- Baseline for other indicators

---

### EMA — Exponential Moving Average

The **Exponential Moving Average** gives more weight to recent prices, making it more responsive to new information than the SMA.

| Parameter | Type   | Default | Constraint                       | Description                 |
|-----------|--------|---------|----------------------------------|-----------------------------|
| `period`  | number | 30      | whole number ≥ 1                 | Smoothing period            |
| `src`     | string | 'close' | a [price source](#price-sources) | Price read from each candle |

- **Name:** `EMA`
- **Output:** a number
- **First value:** candle `period`: the SMA of the first `period` prices, which seeds the EMA, as in TA-Lib

**Formula:** `EMA = (Price - Previous EMA) × Multiplier + Previous EMA`  
Where Multiplier = `2 / (period + 1)`

```typescript
addIndicator('EMA', pair, { period: 12, src: 'hl2' });
```

**Use Cases:**
- Faster trend identification
- Crossover strategies
- MACD calculation base

---

### DEMA — Double Exponential Moving Average

**DEMA** reduces the lag inherent in traditional moving averages by applying EMA twice and using a specific formula.

| Parameter | Type   | Default    | Constraint                       | Description                 |
|-----------|--------|------------|----------------------------------|-----------------------------|
| `period`  | number | *required* | whole number ≥ 1                 | Period of both EMAs         |
| `src`     | string | 'close'    | a [price source](#price-sources) | Price read from each candle |

- **Name:** `DEMA`
- **Output:** a number
- **First value:** candle 2 × `period` − 1: the second EMA, fed the values of the first, has its own first value `period` − 1 candles after the first one's

**Formula:** `DEMA = 2 × EMA(Price) - EMA(EMA(Price))`

```typescript
addIndicator('DEMA', pair, { period: 21 }); // First value at candle 41
```

**Use Cases:**
- Reduced-lag trend following
- Faster signal generation
- Smoother price representation

---

### WMA — Weighted Moving Average

The **Weighted Moving Average** assigns linearly increasing weights to more recent prices.

| Parameter | Type   | Default    | Constraint                       | Description                                                          |
|-----------|--------|------------|----------------------------------|----------------------------------------------------------------------|
| `period`  | number | *required* | whole number ≥ 1                 | Candles averaged, weighted 1 for the oldest to `period` for the last |
| `src`     | string | 'close'    | a [price source](#price-sources) | Price read from each candle                                          |

- **Name:** `WMA`
- **Output:** a number
- **First value:** candle `period`

**Formula:** `WMA = (P₁×1 + P₂×2 + ... + Pₙ×n) / (1+2+...+n)`, P₁ being the oldest price and Pₙ the last

Gekko computes it in constant time per candle: the weighted and plain sums slide, and the window is summed afresh every `period` candles, so the result stays within about 1e-14 of the formula. A flat window gives a constant value.

```typescript
addIndicator('WMA', pair, { period: 10 });
```

**Use Cases:**
- Medium responsiveness between SMA and EMA
- Trend identification with moderate lag

---

### TEMA — Triple Exponential Moving Average

**TEMA** applies exponential smoothing three times, further reducing lag compared to DEMA.

| Parameter | Type   | Default    | Constraint                       | Description                 |
|-----------|--------|------------|----------------------------------|-----------------------------|
| `period`  | number | *required* | whole number ≥ 1                 | Period of the three EMAs    |
| `src`     | string | 'close'    | a [price source](#price-sources) | Price read from each candle |

- **Name:** `TEMA`
- **Output:** a number
- **First value:** candle 3 × `period` − 2

**Formula:** `TEMA = 3×EMA₁ - 3×EMA₂ + EMA₃`, where EMA₁ is the EMA of the price, EMA₂ the EMA of EMA₁ and EMA₃ the EMA of EMA₂

```typescript
addIndicator('TEMA', pair, { period: 10 }); // First value at candle 28
```

**Use Cases:**
- Minimal-lag trend following
- High-frequency trading signals
- Aggressive entry/exit timing

---

### SMMA — Smoothed Moving Average

The **Smoothed Moving Average** is a variation of EMA with a longer lookback effect, providing very smooth curves. It is [Wilder Smoothing](#wilder-smoothing) under another name: the same series, except that its `period` has no default.

| Parameter | Type   | Default    | Constraint                       | Description                 |
|-----------|--------|------------|----------------------------------|-----------------------------|
| `period`  | number | *required* | whole number ≥ 1                 | Smoothing period            |
| `src`     | string | 'close'    | a [price source](#price-sources) | Price read from each candle |

- **Name:** `SMMA`
- **Output:** a number
- **First value:** candle `period`

**Formula:** the mean of the first `period` prices, then `SMMA = ((period - 1) × Previous SMMA + Price) / period`: an EMA whose multiplier is `1 / period`, seeded with the SMA

```typescript
addIndicator('SMMA', pair, { period: 14 });
```

**Use Cases:**
- Long-term trend analysis
- Reducing noise in volatile markets

---

### Wilder Smoothing

**Wilder Smoothing** (also known as Wilder's Smoothing Method) is used in indicators like RSI and ATR. It's similar to EMA but with a different smoothing factor.

| Parameter | Type   | Default | Constraint                       | Description                 |
|-----------|--------|---------|----------------------------------|-----------------------------|
| `period`  | number | 14      | whole number ≥ 1                 | Smoothing period            |
| `src`     | string | 'close' | a [price source](#price-sources) | Price read from each candle |

- **Name:** `WilderSmoothing`
- **Output:** a number
- **First value:** candle `period`

**Formula:** the mean of the first `period` prices, then `((period - 1) × Previous + Price) / period`, as [SMMA](#smma--smoothed-moving-average)

```typescript
addIndicator('WilderSmoothing', pair, { period: 14 });
```

**Use Cases:**
- Internal calculation for RSI, ATR and ADX, which smooth with this very indicator
- Custom indicator development

---

### EMA Ribbon

The **EMA Ribbon** displays multiple EMAs with different periods simultaneously, creating a "ribbon" effect that shows trend strength and potential reversal zones.

| Parameter | Type   | Default | Constraint                       | Description                           |
|-----------|--------|---------|----------------------------------|---------------------------------------|
| `count`   | number | 22      | whole number ≥ 1                 | Number of EMAs                        |
| `start`   | number | 3       | whole number ≥ 1                 | Period of the first EMA               |
| `step`    | number | 3       | whole number ≥ 1                 | Period added from one EMA to the next |
| `src`     | string | 'close' | a [price source](#price-sources) | Price every EMA reads                 |

The EMAs have the periods `start`, `start + step`, …, `start + (count − 1) × step`: by default 22 EMAs, from 3 to 66.

- **Name:** `EMARibbon`
- **Output:** `{ results, spread }`
  - `results` — the values of the EMAs, from the shortest period to the longest
  - `spread` — the highest of them minus the lowest
- **First value:** candle `start` + (`count` − 1) × `step`, once the longest EMA has its value: 66 by default

```typescript
addIndicator('EMARibbon', pair, { count: 8, start: 10, step: 5 }); // EMAs of 10 to 45: first value at candle 45
```

**Use Cases:**
- Visual trend strength analysis
- Identifying trend reversals when ribbons cross
- Multi-timeframe momentum confirmation

---

## 🚀 Momentum Indicators

Momentum indicators measure the speed and strength of price movements.

### MACD — Moving Average Convergence Divergence

**MACD** is a trend-following momentum indicator showing the relationship between two EMAs. It consists of the MACD line, signal line, and histogram.

| Parameter | Type   | Default | Constraint                       | Description            |
|-----------|--------|---------|----------------------------------|------------------------|
| `short`   | number | 12      | whole number ≥ 1, below `long`   | Fast EMA period        |
| `long`    | number | 26      | whole number, above `short`      | Slow EMA period        |
| `signal`  | number | 9       | whole number ≥ 1                 | Signal line EMA period |
| `src`     | string | 'close' | a [price source](#price-sources) | Price both EMAs read   |

- **Name:** `MACD`
- **Output:** `{ macd, signal, hist }`
  - `macd` — MACD line (Fast EMA - Slow EMA)
  - `signal` — Signal line (EMA of MACD)
  - `hist` — Histogram (MACD - Signal)
- **First value:** candle `long` + `signal` − 1: 34 by default

As in TA-Lib, the fast EMA starts `long` − `short` candles after the slow one, so that both have their first value on candle `long`, and the signal line is an EMA seeded with the mean of the first `signal` MACD values. Where TA-Lib swaps a `short` above `long` back, Gekko refuses it, and an equal one too: swapped periods give the opposite line, equal ones a line of 0. With `signal: 1` the signal line is the MACD line itself, and `hist` is 0 on every candle, exactly on real prices: only candles that jump more than twofold leave rounding noise, under 4e-16 of the larger of the MACD line and its previous value, and so without bound relative to a line that lands near 0 after such a jump. The [MACD strategy](./built-in-strategies.md#macd--moving-average-convergence-divergence) refuses `signal: 1` with `macdSrc: hist`, a histogram that never moves.

```typescript
addIndicator('MACD', pair, { short: 12, long: 26, signal: 9 });
```

**Trading Signals:**
- **Bullish:** MACD crosses above signal line
- **Bearish:** MACD crosses below signal line
- **Divergence:** Price making new highs/lows while MACD isn't

---

### Stochastic Oscillator

The **Stochastic Oscillator** compares a closing price to its price range over a period, showing overbought/oversold conditions. It is TA-Lib's STOCH, with its defaults.

| Parameter     | Type   | Default | Constraint                    | Description                                                         |
|---------------|--------|---------|-------------------------------|---------------------------------------------------------------------|
| `fastKPeriod` | number | 5       | whole number ≥ 1              | Raw %K lookback period: candles of the range the close is placed in |
| `slowKPeriod` | number | 3       | whole number ≥ 1              | %K smoothing period                                                 |
| `slowKMaType` | string | 'sma'   | `sma`, `ema`, `dema` or `wma` | %K MA type                                                          |
| `slowDPeriod` | number | 3       | whole number ≥ 1              | %D smoothing period                                                 |
| `slowDMaType` | string | 'sma'   | `sma`, `ema`, `dema` or `wma` | %D MA type                                                          |

- **Name:** `Stochastic`
- **Output:** `{ k, d }`
  - `k` — the slow %K: the `slowKMaType` average of the raw %K over `slowKPeriod` candles
  - `d` — %D: the `slowDMaType` average of `k` over `slowDPeriod` candles
- **First value:** candle `fastKPeriod` + L(`slowKPeriod`) + L(`slowDPeriod`): 9 by default, 11 with one 3-candle `dema`, 13 with two

**Formula:** `Raw %K = (Close - Lowest Low) / (Highest High - Lowest Low) × 100` over the last `fastKPeriod` candles, 0 when that range is flat (see [Flat Markets and Zero Ranges](#flat-markets-and-zero-ranges))

With `slowKPeriod: 1`, `k` is the raw %K itself: the fast stochastic, TA-Lib's STOCHF. A `dema` overshoots its input, so a `k` or a `d` smoothed by one can leave [0, 100], as in TA-Lib.

```typescript
addIndicator('Stochastic', pair, { fastKPeriod: 14, slowKPeriod: 3, slowDPeriod: 3 }); // First value at candle 18
```

**Interpretation:**
- **Above 80:** Overbought — potential sell signal
- **Below 20:** Oversold — potential buy signal
- **`k` crossing `d`:** Momentum shift signal

---

### Stochastic RSI

**Stochastic RSI** applies the Stochastic formula to RSI values instead of price, creating a more sensitive momentum indicator. It is TA-Lib's STOCHRSI, with its defaults.

| Parameter     | Type   | Default | Constraint                    | Description                                                          |
|---------------|--------|---------|-------------------------------|----------------------------------------------------------------------|
| `period`      | number | 14      | whole number ≥ 2              | RSI period                                                           |
| `fastKPeriod` | number | 5       | whole number ≥ 2              | Stochastic period: RSI values of the range `fastK` places the RSI in |
| `fastDPeriod` | number | 3       | whole number ≥ 1              | Period of the average of `fastK` that makes `fastD`                  |
| `slowMaType`  | string | 'sma'   | `sma`, `ema`, `dema` or `wma` | Kind of that average                                                 |

Its RSI reads the close: Stochastic RSI takes no `src`.

- **Name:** `StochasticRSI`
- **Output:** `{ fastK, fastD }`
  - `fastK` — `(RSI - Lowest RSI) / (Highest RSI - Lowest RSI) × 100` over the last `fastKPeriod` RSI values, not smoothed
  - `fastD` — the `slowMaType` average of `fastK` over `fastDPeriod` values
- **First value:** candle `period` + `fastKPeriod` + L(`fastDPeriod`): 21 by default, 23 with a `dema`

`fastK` is 0 whenever the RSI's range is flat: while the RSI holds still over a flat stretch, and while it is pinned at 100, on a market that has risen without falling once since the RSI started (see [Flat Markets and Zero Ranges](#flat-markets-and-zero-ranges)). A %K smoothed over 3 candles, as many charting tools show it, is `fastD` with `fastDPeriod: 3`.

```typescript
addIndicator('StochasticRSI', pair, { period: 14, fastKPeriod: 14, fastDPeriod: 3 }); // First value at candle 30
```

**Use Cases:**
- Identifying extreme overbought/oversold conditions
- Trading range-bound markets
- Confirming trend strength

---

### PSAR — Parabolic Stop and Reverse

**Parabolic SAR** provides potential entry and exit points. The indicator appears as dots above or below the price, indicating trend direction.

| Parameter         | Type   | Default | Constraint                            | Description                                                               |
|-------------------|--------|---------|---------------------------------------|---------------------------------------------------------------------------|
| `acceleration`    | number | 0.02    | number > 0, at most `maxAcceleration` | Initial acceleration factor, and its increase at each new extreme point   |
| `maxAcceleration` | number | 0.2     | number > 0, at least `acceleration`   | Maximum acceleration factor: equal to `acceleration`, the factor is fixed |

- **Name:** `PSAR`
- **Output:** a number, the SAR of the candle: below its low in an uptrend, above its high in a downtrend
- **First value:** candle 2

It is TA-Lib's SAR, value for value. The trend starts on the second candle: down when its low fell from the first candle's by more than its high rose, up otherwise, the SAR starting at the first candle's low (up) or high (down). The factor grows by `acceleration` at each new extreme point, a high above the trend's highest (up) or a low below its lowest (down), an equal one not counting, up to `maxAcceleration`. A low at or below the SAR (up), or a high at or above it (down), reverses the trend: the result of that candle is the extreme point of the trend that ended, and the factor starts again from `acceleration`. TA-Lib lowers an `acceleration` above `maxAcceleration` to the maximum; Gekko refuses it.

```typescript
addIndicator('PSAR', pair, { acceleration: 0.02, maxAcceleration: 0.2 });
```

**Interpretation:**
- **Dots below price:** Uptrend — hold long positions
- **Dots above price:** Downtrend — stay out
- **Dot flip:** Potential trend reversal

**Use Cases:**
- Trailing stop placement
- Trend reversal identification
- Entry/exit timing

---

### ROC — Rate of Change

**Rate of Change** measures the percentage change in price between the current price and the price n periods ago.

| Parameter | Type   | Default    | Constraint       | Description     |
|-----------|--------|------------|------------------|-----------------|
| `period`  | number | *required* | whole number ≥ 1 | Lookback period |

ROC reads the close: it takes no `src`.

- **Name:** `ROC`
- **Output:** a number, in percent
- **First value:** candle `period` + 1, as in TA-Lib

**Formula:** `ROC = (Close / Close n candles ago - 1) × 100`

On a candle whose close `period` candles back is 0, the result is `null`, where TA-Lib writes 0: a change from 0 has no value. Prices are never 0, so only values fed through `update` meet it (see [Feeding an Indicator Your Own Values](#feeding-an-indicator-your-own-values)).

```typescript
addIndicator('ROC', pair, { period: 10 }); // First value at candle 11
```

**Interpretation:**
- **Positive values:** Upward momentum
- **Negative values:** Downward momentum
- **Zero line crossings:** Momentum shifts

---

### TRIX

**TRIX** is a momentum oscillator that shows the percentage rate of change of a triple exponentially smoothed moving average.

| Parameter | Type   | Default | Constraint       | Description              |
|-----------|--------|---------|------------------|--------------------------|
| `period`  | number | 30      | whole number ≥ 1 | Period of the three EMAs |

- **Name:** `TRIX`
- **Output:** a number, in percent: TRIX has no signal line
- **First value:** candle 3 × (`period` − 1) + 2, that is 3 × `period` − 1: 89 by default, as in TA-Lib

**Formula:** `TRIX = (EMA₃ / Previous EMA₃ - 1) × 100`, EMA₃ being the EMA of the EMA of the EMA of the close: the one-candle [ROC](#roc--rate-of-change) of a triple EMA, `null` like it on a candle whose previous EMA₃ is 0, which prices never give

For a signal line, average TRIX yourself (see [Feeding an Indicator Your Own Values](#feeding-an-indicator-your-own-values)).

```typescript
addIndicator('TRIX', pair, { period: 15 }); // First value at candle 44
```

**Use Cases:**
- Filtering market noise
- Identifying trend reversals
- Overbought/oversold conditions

---

### Williams %R

**Williams %R** is a momentum indicator that measures overbought/oversold levels, similar to the Stochastic oscillator but inverted.

| Parameter | Type   | Default | Constraint       | Description     |
|-----------|--------|---------|------------------|-----------------|
| `period`  | number | 14      | whole number ≥ 1 | Lookback period |

- **Name:** `WilliamsR`
- **Output:** a number, from -100 (the close at the lowest low) to 0 (the close at the highest high)
- **First value:** candle `period`

**Formula:** `%R = (Highest High - Close) / (Highest High - Lowest Low) × -100`

On a window whose range is flat, %R is 0, as in TA-Lib: the top of its scale, where the Stochastic reads the same window as 0, the bottom of its own (see [Flat Markets and Zero Ranges](#flat-markets-and-zero-ranges)).

```typescript
addIndicator('WilliamsR', pair, { period: 14 });
```

**Interpretation:**
- **-20 to 0:** Overbought — potential sell signal
- **-100 to -80:** Oversold — potential buy signal

---

## 🧭 Directional Movement

Directional movement indicators measure trend strength and direction. They follow TA-Lib's PLUS_DM, MINUS_DM, PLUS_DI, MINUS_DI, DX and ADX: from the second candle, each candle gives a true range and a move up and down from the previous candle, which Wilder's running sums smooth.

### ADX — Average Directional Index

**ADX** measures trend strength regardless of direction. Higher values indicate stronger trends.

| Parameter | Type   | Default    | Constraint       | Description                           |
|-----------|--------|------------|------------------|---------------------------------------|
| `period`  | number | *required* | whole number ≥ 2 | Period of the DX and of its smoothing |

- **Name:** `ADX`
- **Output:** a number, from 0 to 100
- **First value:** candle 2 × `period`: the DX has its first value at candle `period` + 1, then the smoothing takes `period` of them

ADX is the [Wilder Smoothing](#wilder-smoothing) of the [DX](#dx--directional-movement-index) over `period`. A `period` of 1, which TA-Lib refuses too, is refused: one of the two DIs of a single candle is always 0, so its DX would be 100, or 0/0 on a candle without directional movement.

```typescript
addIndicator('ADX', pair, { period: 14 }); // First value at candle 28
```

**Interpretation:**
- **0-25:** Weak or no trend
- **25-50:** Strong trend
- **50-75:** Very strong trend
- **75-100:** Extremely strong trend

**Use Cases:**
- Determining if market is trending
- Filtering signals in choppy markets
- Position sizing based on trend strength

---

### ADX Ribbon

**ADX Ribbon** displays multiple ADX values across different periods, similar to an EMA ribbon but for trend strength.

| Parameter | Type   | Default | Constraint       | Description                           |
|-----------|--------|---------|------------------|---------------------------------------|
| `count`   | number | 19      | whole number ≥ 1 | Number of ADXs                        |
| `start`   | number | 12      | whole number ≥ 2 | Period of the first ADX               |
| `step`    | number | 3       | whole number ≥ 1 | Period added from one ADX to the next |

The ADXs have the periods `start`, `start + step`, …, `start + (count − 1) × step`: by default 19 ADXs, from 12 to 66.

- **Name:** `ADXRibbon`
- **Output:** `{ results, spread }`
  - `results` — the values of the ADXs, from the shortest period to the longest
  - `spread` — the highest of them minus the lowest
- **First value:** candle 2 × (`start` + (`count` − 1) × `step`), once the longest ADX has its value: 132 by default

```typescript
addIndicator('ADXRibbon', pair, { count: 5, start: 10, step: 5 }); // ADXs of 10 to 30: first value at candle 60
```

**Use Cases:**
- Multi-timeframe trend strength analysis
- Identifying trend strength divergences

---

### DX — Directional Movement Index

**DX** is the base calculation for ADX, measuring the difference between +DI and -DI.

| Parameter | Type   | Default    | Constraint       | Description                              |
|-----------|--------|------------|------------------|------------------------------------------|
| `period`  | number | *required* | whole number ≥ 2 | Period of the two directional indicators |

- **Name:** `DX`
- **Output:** a number, from 0 to 100
- **First value:** candle `period` + 1

**Formula:** `DX = |+DI - -DI| / (+DI + -DI) × 100`, 0 when both DIs are 0

On a candle without directional movement DX keeps its value: both smoothed DMs shrink by the same factor, and the true range cancels out. A `period` of 1 is refused, as for [ADX](#adx--average-directional-index).

```typescript
addIndicator('DX', pair, { period: 14 }); // First value at candle 15
```

---

### +DI and -DI — Directional Indicators

**+DI** measures upward price movement strength, **-DI** downward price movement strength.

| Parameter | Type   | Default    | Constraint       | Description      |
|-----------|--------|------------|------------------|------------------|
| `period`  | number | *required* | whole number ≥ 1 | Smoothing period |

- **Names:** `PlusDI` and `MinusDI`
- **Output:** a number, from 0 to 100
- **First value:** candle `period` + 1

**Formula:** `+DI = Smoothed +DM / Smoothed True Range × 100` (and `-DI` with -DM), both smoothed as [+DM and -DM](#dm-and--dm--directional-movement) are, and 0 while the smoothed true range is 0. With `period: 1`, each candle's own DM over its own true range, from the second candle.

```typescript
addIndicator('PlusDI', pair, { period: 14 });
addIndicator('MinusDI', pair, { period: 14 });
```

**Trading with +DI/-DI:**
- **+DI above -DI:** Bullish trend
- **-DI above +DI:** Bearish trend
- **DI crossovers:** Potential trend changes

---

### +DM and -DM — Directional Movement

**+DM** and **-DM** measure the positive and negative directional movement respectively. These are the raw building blocks for DI calculations.

| Parameter | Type   | Default    | Constraint       | Description                                                |
|-----------|--------|------------|------------------|------------------------------------------------------------|
| `period`  | number | *required* | whole number ≥ 1 | Candles of the first sum, and the divisor of the smoothing |

- **Names:** `PlusDM` and `MinusDM`
- **Output:** a number, 0 or more
- **First value:** candle `period`, or candle 2 with `period: 1`: the first candle has no previous one to move from

Each candle from the second moves up by `High - Previous High` and down by `Previous Low - Low`. Only the larger of the two counts, when it is positive: it is that candle's +DM (up) or -DM (down), the other side's being 0, and a tie counts for neither. The result is the sum of the moves of candles 2 to `period`, then Wilder's running sum `Previous - Previous / period + Move`: `period` times an average, as TA-Lib's PLUS_DM and MINUS_DM give it. With `period: 1`, it is each candle's own move.

```typescript
addIndicator('PlusDM', pair, { period: 14 });
addIndicator('MinusDM', pair, { period: 14 });
```

---

## 🔄 Oscillators

Oscillators are bounded indicators that fluctuate between fixed values, typically indicating overbought/oversold conditions.

### RSI — Relative Strength Index

**RSI** measures the magnitude of recent price changes to evaluate overbought or oversold conditions.

| Parameter | Type   | Default | Constraint                       | Description                                   |
|-----------|--------|---------|----------------------------------|-----------------------------------------------|
| `period`  | number | 14      | whole number ≥ 2                 | Lookback period                               |
| `src`     | string | 'close' | a [price source](#price-sources) | Price whose changes make the gains and losses |

- **Name:** `RSI`
- **Output:** a number, from 0 to 100
- **First value:** candle `period` + 1: the first change takes two candles

**Formula:** `RSI = 100 - (100 / (1 + RS))`  
Where RS = Average Gain / Average Loss, the [Wilder Smoothing](#wilder-smoothing) over `period` of the rises and of the falls of the price, as in TA-Lib. Gekko computes it as `100 × Average Gain / (Average Gain + Average Loss)`, which is 100 when there was no loss.

With neither gain nor loss, on a market flat since the first candle, the RSI is 0: TA-Lib's convention, which Gekko keeps on purpose (see [Flat Markets and Zero Ranges](#flat-markets-and-zero-ranges)). Over candles that do not move after a move, both averages shrink by the same factor, so the RSI holds its value, but for a wobble in its last bits. A `period` of 1, which TA-Lib refuses too, is refused: the averages would be the last gain and the last loss alone, and the RSI 100 on a rise and 0 on any other candle, an unchanged close included.

```typescript
addIndicator('RSI', pair, { period: 14 }); // First value at candle 15
```

**Interpretation:**
- **Above 70:** Overbought — potential reversal down
- **Below 30:** Oversold — potential reversal up
- **50 line:** Trend direction indicator

**Advanced Techniques:**
- **Divergence:** Price vs RSI divergence signals reversals
- **Failure Swings:** RSI makes higher low in oversold territory

---

### CCI — Commodity Channel Index

**CCI** measures the current price level relative to an average price over a given period. It is TA-Lib's CCI.

| Parameter | Type   | Default | Constraint       | Description     |
|-----------|--------|---------|------------------|-----------------|
| `period`  | number | 14      | whole number ≥ 2 | Lookback period |

- **Name:** `CCI`
- **Output:** a number
- **First value:** candle `period`

**Formula:** `CCI = (Typical Price - SMA) / (0.015 × Mean Deviation)`, over the last `period` typical prices `(High + Low + Close) / 3`: the SMA is their mean, the mean deviation their mean distance from it

On a flat window, typical prices equal within 1e-9 of the price, the CCI is 0 (see [Flat Markets and Zero Ranges](#flat-markets-and-zero-ranges)). A `period` of 1 is refused: the CCI of a single candle is always 0.

```typescript
addIndicator('CCI', pair, { period: 20 });
```

**Interpretation:**
- **Above +100:** Overbought or start of uptrend
- **Below -100:** Oversold or start of downtrend
- **Zero line crossings:** Momentum shifts

**Use Cases:**
- Trend identification
- Overbought/oversold detection
- Divergence trading

---

### AO — Awesome Oscillator

**Awesome Oscillator** measures market momentum by comparing a 5-period SMA of the midpoint to a 34-period SMA.

| Parameter | Type   | Default | Constraint                     | Description     |
|-----------|--------|---------|--------------------------------|-----------------|
| `short`   | number | 5       | whole number ≥ 1, below `long` | Fast SMA period |
| `long`    | number | 34      | whole number, above `short`    | Slow SMA period |

- **Name:** `AO`
- **Output:** a number
- **First value:** candle `long`: 34 by default

**Formula:** `AO = SMA(short, Midpoint) - SMA(long, Midpoint)`  
Where Midpoint = (High + Low) / 2

Swapped or equal periods are refused, as for [MACD](#macd--moving-average-convergence-divergence).

```typescript
addIndicator('AO', pair, { short: 5, long: 34 });
```

**Trading Signals:**
- **Zero line cross:** Momentum shift
- **Saucer signal:** Two consecutive bars of same color after opposite color
- **Twin peaks:** Divergence signal

---

## 📉 Volatility Indicators

Volatility indicators measure the rate and magnitude of price changes.

### ATR — Average True Range

**ATR** measures market volatility by calculating the average of true ranges over a period: the [Wilder Smoothing](#wilder-smoothing) of the [True Range](#true-range), as in TA-Lib.

| Parameter | Type   | Default    | Constraint       | Description      |
|-----------|--------|------------|------------------|------------------|
| `period`  | number | *required* | whole number ≥ 1 | Smoothing period |

- **Name:** `ATR`
- **Output:** a number
- **First value:** candle `period` + 1: the true range starts on the second candle

**True Range = Maximum of:**
- Current High - Current Low
- |Current High - Previous Close|
- |Current Low - Previous Close|

```typescript
addIndicator('ATR', pair, { period: 14 }); // First value at candle 15
```

**Use Cases:**
- Stop-loss placement (e.g., 2× ATR)
- Position sizing
- Identifying volatility expansion/contraction
- Breakout confirmation

---

### ATRCD — ATR Convergence Divergence

**ATRCD** applies MACD-style analysis to ATR values, helping identify changes in volatility trends: MACD's line, signal and histogram, with a fast ATR minus a slow one in place of two EMAs of the price.

| Parameter | Type   | Default | Constraint                     | Description                                   |
|-----------|--------|---------|--------------------------------|-----------------------------------------------|
| `short`   | number | 12      | whole number ≥ 1, below `long` | Fast ATR period                               |
| `long`    | number | 26      | whole number, above `short`    | Slow ATR period                               |
| `signal`  | number | 9       | whole number ≥ 1               | Signal line period: the EMA of the ATRCD line |

- **Name:** `ATRCD`
- **Output:** `{ atrcd, signal, hist }`
  - `atrcd` — ATRCD line (Fast ATR - Slow ATR)
  - `signal` — Signal line (EMA of ATRCD)
  - `hist` — Histogram (ATRCD - Signal)
- **First value:** candle `long` + `signal`: 35 by default

As in [MACD](#macd--moving-average-convergence-divergence), the fast ATR starts `long` − `short` candles after the slow one, so that both have their first value on the same candle, and swapped or equal periods are refused.

```typescript
addIndicator('ATRCD', pair, { short: 12, long: 26, signal: 9 });
```

**Use Cases:**
- Volatility trend analysis
- Predicting volatility changes
- Strategy timing based on volatility

---

### Bollinger Bands

**Bollinger Bands** create an envelope around price using standard deviations from a moving average. They are TA-Lib's BBANDS, with its defaults.

| Parameter   | Type   | Default | Constraint                    | Description                                         |
|-------------|--------|---------|-------------------------------|-----------------------------------------------------|
| `period`    | number | 5       | whole number ≥ 2              | Moving average period, and candles of the deviation |
| `stdevUp`   | number | 2       | number ≥ 0                    | Upper band standard deviations                      |
| `stdevDown` | number | 2       | number ≥ 0                    | Lower band standard deviations                      |
| `maType`    | string | 'sma'   | `sma`, `ema`, `dema` or `wma` | MA type of the middle band                          |

- **Name:** `BollingerBands`
- **Output:** `{ upper, middle, lower }`
  - `upper` — Upper band (MA + stdev × `stdevUp`)
  - `middle` — Middle band (the `maType` average of the close)
  - `lower` — Lower band (MA - stdev × `stdevDown`)
- **First value:** candle `period`, or 2 × `period` − 1 with a `dema`

The deviation is the population standard deviation of the last `period` closes around their simple mean, whatever the `maType`. On a flat window, closes equal within 1e-9 of the price, the three bands are equal: they are the close itself once the middle is within 1e-9 of it, which an `sma` or `wma` middle always is, and an `ema` or `dema` one once it has caught up with the price. So on a flat market `close > upper` and `close < lower` are false, `close >= upper` and `close <= lower` true. Just after a move, an `ema` or `dema` middle still lags: the bands are that middle, and the close is off them, as in TA-Lib. A middle of 0, which the bands of [OBV](#obv--on-balance-volume) can have, is a value like any other.

```typescript
addIndicator('BollingerBands', pair, { period: 20, stdevUp: 2, stdevDown: 2, maType: 'sma' });
```

**Trading Strategies:**
- **Squeeze:** Bands narrow before breakouts
- **Bounce:** Price touching bands may reverse
- **Walk the bands:** Strong trends ride upper/lower band

---

### True Range

**True Range** is the raw volatility measure used in ATR calculation. It is TA-Lib's TRANGE, and takes no parameters.

- **Name:** `TrueRange`
- **Output:** a number
- **First value:** candle 2: the first candle has no previous close

**Formula:** Maximum of:
- High - Low
- |High - Previous Close|
- |Low - Previous Close|

```typescript
addIndicator('TrueRange', pair, undefined); // It takes no parameters
```

---

## 📊 Volume Indicators

Volume indicators analyze trading activity to confirm trends and predict reversals.

### OBV — On-Balance Volume

**OBV** uses volume flow to predict changes in price by adding volume on up candles and subtracting it on down candles. Gekko gives it with Bollinger Bands around it.

| Parameter   | Type   | Default | Constraint                    | Description            |
|-------------|--------|---------|-------------------------------|------------------------|
| `period`    | number | 14      | whole number ≥ 2              | Bollinger Bands period |
| `stdevUp`   | number | 2       | number ≥ 0                    | Upper band multiplier  |
| `stdevDown` | number | 2       | number ≥ 0                    | Lower band multiplier  |
| `maType`    | string | 'sma'   | `sma`, `ema`, `dema` or `wma` | MA type for bands      |

- **Name:** `OBV`
- **Output:** `{ obv, ma, upper, lower }`
  - `obv` — Cumulative OBV value
  - `ma` — Moving average of OBV, the middle of its bands
  - `upper` — Upper Bollinger Band
  - `lower` — Lower Bollinger Band
- **First value:** candle `period`, or 2 × `period` − 1 with a `dema`: 14 by default

`obv` is TA-Lib's OBV: the volume of the first candle, then each candle's volume added when its close rose, subtracted when it fell, and nothing when it held. `ma`, `upper` and `lower` are the [Bollinger Bands](#bollinger-bands) of the OBV. Its level is arbitrary: it starts from the first candle the indicator gets, the first timeframe candle of the run, so it depends on where the run starts. Compare `obv` with its `ma`, its bands or its own past, not with a fixed threshold. While the closes hold for `period` candles, the bands are the OBV itself with an `sma` or `wma` middle, and with an `ema` or `dema` one once it has caught up with the OBV, which can take over a hundred candles after a move: until then the three bands are that middle, and the OBV lies outside them. An OBV that comes back to exactly 0 and holds there is caught up with by a `dema` middle only after hundreds of candles or more, and never by an `ema` one of `period` 3 or more, which stalls just above 0.

```typescript
addIndicator('OBV', pair, { period: 20 });
```

**Interpretation:**
- **Rising OBV:** Buying pressure (bullish)
- **Falling OBV:** Selling pressure (bearish)
- **OBV divergence:** Potential reversal signal

---

### EFI — Elder's Force Index

**Elder's Force Index** measures the force of bulls during upward movements and bears during downward movements.

| Parameter | Type   | Default | Constraint                       | Description                        |
|-----------|--------|---------|----------------------------------|------------------------------------|
| `period`  | number | 13      | whole number ≥ 1                 | Smoothing period                   |
| `maType`  | string | 'ema'   | `sma`, `ema`, `dema` or `wma`    | MA type of the smoothing           |
| `src`     | string | 'close' | a [price source](#price-sources) | Price whose change makes the force |

- **Name:** `EFI`
- **Output:** `{ fi, smoothed }`
  - `fi` — the force of the candle
  - `smoothed` — the `maType` average of `fi` over `period` candles
- **First value:** candle `period` + 1, or 2 × `period` with a `dema`: 14 by default

**Formula:** `EFI = (Close - Previous Close) × Volume`, with the price `src` names in place of the close

```typescript
addIndicator('EFI', pair, { period: 13, maType: 'ema' });
```

**Use Cases:**
- Trend confirmation
- Identifying potential reversals
- Measuring buying/selling pressure

---

## 🔩 Common Parameters

### Price Sources

Eleven indicators take a `src` parameter to specify which price to use: SMA, EMA, DEMA, TEMA, WMA, SMMA, Wilder Smoothing, EMA Ribbon (for every EMA), MACD (for both EMAs), RSI (for the changes that make its gains and losses) and EFI (for the change that makes its force). Each one reads that price where it would read the close:

| Source  | Description             | Formula                         |
|---------|-------------------------|---------------------------------|
| `open`  | Opening price           | —                               |
| `high`  | Highest price           | —                               |
| `low`   | Lowest price            | —                               |
| `close` | Closing price (default) | —                               |
| `hl2`   | Midpoint                | (High + Low) / 2                |
| `hlc3`  | Typical Price           | (High + Low + Close) / 3        |
| `ohlc4` | Average Price           | (Open + High + Low + Close) / 4 |

The other indicators read fixed prices: ROC, TRIX, Bollinger Bands, OBV and Stochastic RSI (through its RSI) the close, CCI the typical price, AO the midpoint, and Stochastic, Williams %R, PSAR, True Range and the indicators built on it (ATR, ATRCD and the directional movement) the candle's high and low, and its close where their formula uses it. OBV and EFI also read the volume.

### Moving Average Types

Several indicators support different moving average types: the `maType` of Bollinger Bands, OBV and EFI, the `slowKMaType` and `slowDMaType` of Stochastic, and the `slowMaType` of Stochastic RSI. Each type is the indicator of the same name (see [Moving Averages](#-moving-averages)):

| Type   | Name                       | Characteristics                   | First value of a p-candle average |
|--------|----------------------------|-----------------------------------|-----------------------------------|
| `sma`  | Simple Moving Average      | Equal weight, more lag            | candle p                          |
| `ema`  | Exponential Moving Average | Recent bias, less lag             | candle p                          |
| `dema` | Double EMA                 | Reduced lag, overshoots its input | candle 2 × p − 1                  |
| `wma`  | Weighted Moving Average    | Linear weight increase            | candle p                          |

An average's lookback L(p), the candles before its first value, is therefore p − 1, or 2 × (p − 1) for a `dema`. Any other name is refused, `smma` and `tema` included. A `dema` overshoots its input: smoothing a bounded series, such as the Stochastic's `k` and `d`, it can leave its bounds.

### Parameter Checks

Every indicator checks its parameters when `addIndicator` builds it, in `init`, at start-up. A parameter outside its constraint stops Gekko there, with exit code 1 and an error, logged at `error` level, that names the indicator, the parameter, what it accepts and what it got:

```text
[STRATEGY] Indicator EMA: period must be a whole number, at least 1, got 2.5
[STRATEGY] Indicator MACD: short must be below long, got short 26 and long 12 (swapped periods give the opposite MACD, equal ones a MACD of 0)
[STRATEGY] Indicator BollingerBands: maType must be one of "sma", "ema", "dema", "wma", got "smma"
```

- Periods, counts, starts and steps are whole numbers: 20.5, `'20'` (a string), `null` or `NaN` are refused, and so is a missing one where the indicator has no default (DEMA, WMA, TEMA, SMMA, ROC, ADX, DX, +DI, -DI, +DM, -DM and ATR).
- Some minimums are 2: CCI (the CCI of a single candle is always 0), Bollinger Bands and OBV (the bands of a single candle have no width), the `period` of RSI and of Stochastic RSI (TA-Lib's minimum: the RSI of a single change is 100 on a rise, and 0 on a fall or an unchanged close), the `fastKPeriod` of Stochastic RSI (the range of a single RSI value is 0), DX, ADX and the `start` of ADX Ribbon (TA-Lib's minimum).
- MACD, AO and ATRCD refuse a `short` that is not below `long`, which TA-Lib swaps back: swapped periods would give the opposite line, equal ones a line of 0. PSAR refuses an `acceleration` above `maxAcceleration`, which TA-Lib lowers to the maximum.
- A `src` or a moving average type must be spelt as listed above, in lower case.
- A key an indicator does not take is ignored, whatever its value: TypeScript refuses it in an object literal (`Object literal may only specify known properties`), Gekko does not.

In TypeScript, `addIndicator` takes the parameters as its third argument even when each one has a default: pass `{}` to take the defaults, and `undefined` for True Range, which takes none.

A JavaScript strategy, which Bun loads without type-checking, can leave the third argument out, or pass `null`, and the indicator is then built from `{}`: with its defaults, or, for one whose period has no default, refused as above (`[STRATEGY] Indicator ATR: period must be a whole number, at least 1, got undefined`). Anything but a plain object (a number given for a period, a string, an array, a `Map`, an instance of a class) is refused the same way, before the indicator is built: `[STRATEGY] Impossible to add the RSI indicator on BTC/USDT: parameters must be a plain object of the indicator's parameters by name, {} to take its defaults, got 7`.

---

## 🔧 Using Indicators in Strategies

### Basic Usage

A strategy registers its indicators in `init`, the only hook where `addIndicator` is available, on one of the watched pairs. Gekko builds each indicator there, then feeds it every timeframe candle of its pair, from the first candle of the run, the warmup included, before the hooks of that candle run:

```typescript
import { TradingPair } from '@models/utility.types';
import { IndicatorResults, InitParams, OnCandleEventParams, Strategy } from '@strategies/strategy.types';

type RsiBandsParams = { rsiPeriod: number; bandsPeriod: number };

export class RsiBands implements Strategy<RsiBandsParams> {
  private pair?: TradingPair;

  init({ candle, tools, addIndicator }: InitParams<RsiBandsParams>): void {
    // candle holds one candle per watched pair: follow the first one
    const [pair] = candle.keys();
    this.pair = pair;
    addIndicator('RSI', pair, { period: tools.strategyParams.rsiPeriod });
    addIndicator('BollingerBands', pair, { period: tools.strategyParams.bandsPeriod });
    addIndicator('MACD', pair, {}); // The defaults: 12, 26 and 9
  }

  // Each hook gets one { results, symbol } per indicator, in the order of the addIndicator calls
  onTimeframeCandleAfterWarmup({ candle, tools }: OnCandleEventParams<RsiBandsParams>, ...indicators: IndicatorResults[]): void {
    const [rsi, bands, macd] = indicators;
    const close = this.pair ? candle.get(this.pair)?.close : undefined;
    // Every result is null until the indicator's first value, then complete on every candle
    const bb = bands.results as IndicatorRegistry['BollingerBands']['output'];
    const trend = macd.results as IndicatorRegistry['MACD']['output'];
    if (close === undefined || typeof rsi.results !== 'number' || bb === null || trend === null) return;

    if (rsi.results < 30 && close < bb.lower) {
      tools.log('info', `Oversold below the lower band at ${close}, MACD histogram ${trend.hist.toFixed(2)}`);
    }
  }
}
```

An indicator name that does not exist, a pair that is not watched, or a refused parameter or third argument (see [Parameter Checks](#parameter-checks)) stops Gekko at start-up, with an error that names the problem, and so does an `addIndicator` kept and called after `init`, when it is called. To act on the signals, see [Creating Orders](./custom-strategies.md#creating-orders) and [Tracking Your Position](./custom-strategies.md#tracking-your-position) in the custom strategies guide.

### Reading Results

`onEachTimeframeCandle`, `log` and `onTimeframeCandleAfterWarmup`, and after them the order hooks, get one `{ results, symbol }` argument per indicator after their parameters, in the order of the `addIndicator` calls: `symbol` is the indicator's pair, and `results` its result, typed `unknown`. That result follows one contract, the same for every indicator:

- it is `null` until the indicator's first value, at the candle its section gives, whatever the warmup;
- from then on it is a complete value on every candle: a number, or an object whose fields are all numbers (an array of numbers for the `results` of a ribbon), never an object with a field still `null` and never a placeholder 0;
- the one exception is ROC, and TRIX built on it, which give `null` again on a candle whose base is 0: prices never are.

So one check is enough before using a result. For a number, check its type. For an object, give it the indicator's output type, `IndicatorRegistry['<Name>']['output']`, and check it is not `null`:

```typescript
const [rsi, bands] = indicators; // In the order of the addIndicator calls
if (typeof rsi.results !== 'number') return; // A number, or null before its first value
const bb = bands.results as IndicatorRegistry['BollingerBands']['output']; // The three bands, or null: never some of them
if (bb === null) return;

if (rsi.results < 30 && close < bb.lower) {
  // Oversold below the lower band
}
```

`IndicatorRegistry` is the global interface that each indicator's `<name>.types.ts` augments with its `input` and `output`: it is in scope wherever `addIndicator` type-checks. The `as` only tells TypeScript which indicator you registered there, and nothing checks it against the order of your `addIndicator` calls, no more than a hook whose rest parameter you type, as the built-in MACD strategy does with `...indicators: IndicatorResults<{ macd: number; signal: number; hist: number } | null>[]`.

`results` is your strategy's own copy, made once per candle and shared by the hooks of that candle, then by the order hooks until the next one: writing to it changes nothing in the indicator.

### Warmup Period

`watch.warmup.candleCount` is unrelated to indicator periods: it counts the timeframe candles before `log` and `onTimeframeCandleAfterWarmup` first run, while every indicator is fed from the first candle of the run, the warmup candles included. An indicator whose first value comes at candle K has it on the first candle after the warmup when `candleCount` is K − 1 or more; with a shorter warmup, its first candles after the warmup are `null`, and a strategy that checks its results, as it must, trades later than you expect. The [Indicators at a Glance](#-indicators-at-a-glance) table gives K for every indicator, and [Set Adequate Warmup](./custom-strategies.md#5-set-adequate-warmup) how to choose `candleCount`.

### Flat Markets and Zero Ranges

A window whose candles did not move, on an illiquid pair or over the flat candles Gekko fills a gap with, leaves several formulas dividing 0 by 0. Gekko answers them as TA-Lib does, and the answers read differently from one indicator to the next:

| Indicator       | On a window that did not move                                                                                                                                         |
|-----------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| RSI             | 0 on a market flat since the RSI's first candle, its most oversold reading; after a move, the value it had                                                            |
| Stochastic      | a raw %K of 0, so `k` and `d` fall to 0: the most oversold reading                                                                                                    |
| Williams %R     | 0: the most overbought reading, the opposite end from the Stochastic on the same window                                                                               |
| Stochastic RSI  | a `fastK` of 0 while the RSI holds still, so `fastD` falls to 0: the most oversold reading                                                                            |
| CCI             | 0, a neutral reading                                                                                                                                                  |
| Bollinger Bands | the three bands on the close, once an `ema` or `dema` middle has caught up: `close > upper` and `close < lower` are false, `close >= upper` and `close <= lower` true |
| OBV             | `obv` unchanged, and its bands on it once an `ema` or `dema` middle has caught up                                                                                     |
| DX, ADX         | 0 on a market flat from the start; after a move, DX keeps its value through candles without directional movement, and ADX tends to it                                 |

- The RSI's 0 on a market flat since its first candle is TA-Lib's convention, which Gekko keeps on purpose: no gain and no loss give 0 / 0, which TA-Lib writes 0. The RSI is pinned at 100 on a market that has risen without falling once since the RSI started, and the `fastK` of Stochastic RSI is then 0 too, its range being flat.
- CCI, the Stochastic (and so Stochastic RSI) and Bollinger Bands read a window as flat when its highest and lowest values are within 1e-9 of each other, relative to their size, so that rounding does not turn a flat window into a move: a candle that traded a tick either side of the flat price and closed on it, or an RSI that wobbles in its last bits over a flat stretch. Williams %R compares its window's highest high and lowest low, which are exact.
- Smoothed by an `sma`, the Stochastic's `k` and `d` and Stochastic RSI's `fastD` fall to within a rounding residue of 0, some 1e-14, rather than to 0 exactly: compare them with a threshold, not with `=== 0`.
- Over a very long run of candles that do not move, about 1,000 at period 2 and 10,000 at period 14, the smoothed averages of RSI and of the directional movement underflow: the RSI then drifts, to 0 or 50, and DX to 0.

### Combining Multiple Indicators

For robust trading signals, combine multiple indicators:

```typescript
// Trend + Momentum + Volume confirmation, with an EMA(200), an RSI(14) and an OBV registered in that order
const [ema200, rsi, obv] = indicators;
const volume = obv.results as IndicatorRegistry['OBV']['output'];
if (typeof ema200.results !== 'number' || typeof rsi.results !== 'number' || volume === null) return;

if (close > ema200.results && rsi.results < 30 && volume.obv > volume.ma) {
  // Strong buy signal: uptrend + oversold + buying pressure
}
```

### Feeding an Indicator Your Own Values

The moving averages (SMA, EMA, DEMA, TEMA, WMA, SMMA and Wilder Smoothing), ROC, Bollinger Bands and the Stochastic also take numbers you compute, through `update(value: number)`: the Stochastic takes each value as its own high, low and close. That is how indicators build on each other: TRIX feeds its triple EMA to a ROC, OBV its OBV to Bollinger Bands, and Stochastic RSI its RSI to a Stochastic. The result follows the same contract as through `addIndicator`.

Only code that can import Gekko's classes uses it: a strategy in `src/strategies/custom/`, or a new indicator. A strategy loaded through `strategyPath` from outside the repository can import Gekko's types only (see [Where Your Strategy Lives](./custom-strategies.md#where-your-strategy-lives)). Feed such an indicator in `onEachTimeframeCandle`, which runs on every candle, the warmup included:

```typescript
import { EMA } from '@indicators/movingAverages/ema/ema.indicator';
import { IndicatorResults, InitParams, OnCandleEventParams, Strategy } from '@strategies/strategy.types';

export class TrixSignal implements Strategy<object> {
  // TRIX has no signal line: a 9-candle EMA of its values, fed once per candle
  private readonly signal = new EMA({ period: 9 });

  init({ candle, addIndicator }: InitParams<object>): void {
    const [pair] = candle.keys();
    addIndicator('TRIX', pair, { period: 15 });
  }

  onEachTimeframeCandle(_params: OnCandleEventParams<object>, ...[trix]: IndicatorResults[]): void {
    if (typeof trix.results === 'number') this.signal.update(trix.results);
  }

  onTimeframeCandleAfterWarmup({ tools }: OnCandleEventParams<object>, ...[trix]: IndicatorResults[]): void {
    const signal = this.signal.getResult(); // null until it has 9 TRIX values: from candle 52 here
    if (typeof trix.results !== 'number' || signal === null) return;
    if (trix.results > signal) tools.log('info', 'TRIX above its signal line');
  }
}
```

---
