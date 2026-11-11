import { TradingPair } from '@gekko/shared/models/utility.types';
import { IndicatorResults, InitParams, OnCandleEventParams, Strategy } from '../strategy.types';
import { isFiniteNumber } from '@gekko/shared/utils/math/math.utils';
import { demaStrategySchema } from '@gekko/schemas/strategies/dema.schema';
import { DEMAStrategyParams, PairTrend } from './dema.types';

/**
 * Trades every watched pair, each with its own DEMA and SMA, its own trend and its own position, through tools.positions, the position
 * book the StrategyManager keeps for it (see Positions). Its orders carry no amount: a BUY takes an equal share of the free currency
 * among the pairs not invested (all of it on one pair, see Positions.buy), a SELL all of the pair's asset. On each pair, the strategy
 * buys only when flat and sells only when long, never while its order is pending there. Advised on each change of trend, its first
 * SELL had nothing to sell, and it switched side while its STICKY order was still open. The trend of an order canceled or errored stays
 * adviced, as does that of a BUY the position book skips: the next order waits for the next trend.
 */
export class DEMA implements Strategy<DEMAStrategyParams> {
  static schema = demaStrategySchema;

  // The trend of each pair, set at init
  private readonly trends = new Map<TradingPair, PairTrend>();

  init({ tools, addIndicator }: InitParams<DEMAStrategyParams>): void {
    tools.positions.track();
    for (const pair of tools.positions.pairs) {
      this.trends.set(pair, { isTrendAdviced: false });
      addIndicator('DEMA', pair, { period: tools.strategyParams.period });
      addIndicator('SMA', pair, { period: tools.strategyParams.period });
    }
  }

  onTimeframeCandleAfterWarmup(params: OnCandleEventParams<DEMAStrategyParams>, ...indicators: IndicatorResults[]) {
    const { tools } = params;
    const bySymbol = tools.indicatorsBySymbol(indicators);
    for (const pair of tools.positions.pairs) this.adviseOn(pair, params, bySymbol.get(pair) ?? []);
  }

  log({ tools }: OnCandleEventParams<DEMAStrategyParams>, ...indicators: IndicatorResults[]): void {
    const { log } = tools;
    const bySymbol = tools.indicatorsBySymbol(indicators);
    for (const pair of tools.positions.pairs) {
      const [dema, sma] = bySymbol.get(pair) ?? [];
      if (!isFiniteNumber(sma?.results) || !isFiniteNumber(dema?.results)) continue;

      log(
        'debug',
        [
          `[${pair}] Calculated DEMA and SMA properties for candle:`,
          `DEMA: ${dema.results.toFixed(5)}`,
          `SMA: ${sma.results.toFixed(5)}`,
        ].join(' '),
      );
    }
  }

  /** Advises on `pair` from its DEMA and SMA, unless its candle is missing or either average is not ready */
  private adviseOn(pair: TradingPair, params: OnCandleEventParams<DEMAStrategyParams>, [dema, sma]: IndicatorResults[]) {
    const { candle, tools } = params;
    const { strategyParams, log, positions } = tools;
    const currentCandle = candle.get(pair);
    if (!currentCandle) return;
    const price = currentCandle.close;
    if (!isFiniteNumber(sma?.results) || !isFiniteNumber(dema?.results)) return;
    const trend = this.trends.get(pair)!;

    const diff = sma.results - dema.results;

    const message = '@ ' + price.toFixed(8) + ' (' + dema.results.toFixed(5) + '/' + diff.toFixed(5) + ')';

    if (diff > strategyParams.thresholds.up) {
      log('debug', `[${pair}] We are currently in uptrend: ${message}`);

      if (trend.currentTrend !== 'up') {
        trend.currentTrend = 'up';
        trend.isTrendAdviced = false;
      }
      if (!trend.isTrendAdviced && positions.canBuy(pair)) {
        trend.isTrendAdviced = true;
        // Logged once the BUY is placed: one the position book skips as too small for the market (see Positions.buy) is told by the
        // book's own line alone. Logged before it, this line, relayed to the strat_info subscribers, told of a long advice executed while
        // nothing was sent.
        const id = positions.buy({ type: 'STICKY', symbol: pair });
        if (id) log('info', `[${pair}] Executing long advice due to detected uptrend: ${message}`);
      }
    } else if (diff < strategyParams.thresholds.down) {
      log('debug', `[${pair}] We are currently in a downtrend: ${message}`);

      if (trend.currentTrend !== 'down') {
        trend.currentTrend = 'down';
        trend.isTrendAdviced = false;
      }
      if (!trend.isTrendAdviced && positions.canSell(pair)) {
        trend.isTrendAdviced = true;
        log('info', `[${pair}] Executing short advice due to detected downtrend: ${message}`);
        positions.sell({ type: 'STICKY', symbol: pair });
      }
    } else {
      log('debug', `[${pair}] We are currently not in an up or down trend: ${message}`);
    }
  }
}
