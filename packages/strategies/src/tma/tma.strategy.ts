import { TradingPair } from '@gekko/shared/models/utility.types';
import { IndicatorResults, InitParams, OnCandleEventParams, Strategy, Tools } from '../strategy.types';
import { compareWithTolerance, isFiniteNumber } from '@gekko/shared/utils/math/math.utils';
import { tmaStrategySchema } from '@gekko/schemas/strategies/tma.schema';
import { TMAStrategyParams } from './tma.types';

/**
 * Trades every watched pair, each with its own short, medium and long SMAs and its own position, through tools.positions, the position
 * book the StrategyManager keeps for it (see Positions). An alignment holds for many candles in a row, and every order is all-in or, for
 * a BUY, an equal share of the currency among the pairs not invested (see Positions.buy): on each pair, the strategy buys once when flat
 * and sells once when long, never while an order of that pair is pending. Advised on every candle, each order after the first was sized
 * from what the previous one left, then refused once nothing was left, until maxConsecutiveErrors stopped the bot. An order canceled or
 * errored is placed again by the next candle of its signal, unless what it executed before it ended changed the position (see
 * Positions.isLong), and a BUY the position book skipped as too small for the market is asked for again on the next one, unless the book
 * took the asset of the pair held for the position (see Positions.buy). The position book settles each of its orders before the order
 * hooks run: the strategy has no order hook.
 */
export class TMA implements Strategy<TMAStrategyParams> {
  static schema = tmaStrategySchema;

  init({ tools, addIndicator }: InitParams<TMAStrategyParams>): void {
    const { long, medium, short, src } = tools.strategyParams;
    tools.positions.track();
    for (const pair of tools.positions.pairs) {
      addIndicator('SMA', pair, { period: short, src });
      addIndicator('SMA', pair, { period: medium, src });
      addIndicator('SMA', pair, { period: long, src });
    }
  }

  onTimeframeCandleAfterWarmup({ tools }: OnCandleEventParams<TMAStrategyParams>, ...indicators: IndicatorResults<number | null>[]): void {
    const bySymbol = tools.indicatorsBySymbol(indicators);
    for (const pair of tools.positions.pairs) {
      const indicatorsOfPair = bySymbol.get(pair);
      if (indicatorsOfPair) this.adviseOn(pair, tools, indicatorsOfPair);
    }
  }

  /** Advises on `pair` from its short, medium and long SMAs (`indicators`, in the order init added them), once all three are ready */
  private adviseOn(pair: TradingPair, tools: Tools<TMAStrategyParams>, indicators: IndicatorResults<number | null>[]): void {
    const { log, positions } = tools;
    const [short, medium, long] = indicators;
    if (!isFiniteNumber(short.results) || !isFiniteNumber(medium.results) || !isFiniteNumber(long.results)) return;

    const smas = `${short.results}/${medium.results}/${long.results}`;
    // On a flat stretch the SMAs that hold only its price are equal in exact arithmetic, but their running sums leave them a few ulps
    // apart, on either side: compared strictly, that noise made trends, several round trips of fees on a market that had not moved.
    // Within the tolerance two SMAs are equal, neither above nor below each other: a medium SMA equal to either other one is no trend.
    const shortToMedium = compareWithTolerance(short.results, medium.results);
    const mediumToLong = compareWithTolerance(medium.results, long.results);
    const isUptrend = shortToMedium > 0 && mediumToLong > 0;
    // A mixed alignment: the medium SMA above both others, or below both. A fully bearish one (short < medium < long) gives no signal.
    const isDowntrend = (shortToMedium < 0 && mediumToLong > 0) || (shortToMedium > 0 && mediumToLong < 0);

    if (isUptrend && positions.canBuy(pair)) {
      // Logged once the BUY is placed: one the position book skips as too small for the market (see Positions.buy) is told by the book's
      // own line alone, at debug level from its second skip on. Logged before it, this line, relayed to the strat_info subscribers, told
      // on every candle of the uptrend of a long advice executed while nothing was sent.
      const id = positions.buy({ type: 'STICKY', symbol: pair });
      if (id) log('info', `[${pair}] Executing long advice due to detected uptrend: ${smas}`);
    } else if (isDowntrend && positions.canSell(pair)) {
      log('info', `[${pair}] Executing short advice due to detected downtrend: ${smas}`);
      positions.sell({ type: 'STICKY', symbol: pair });
    } else if (!isUptrend && !isDowntrend) {
      log('debug', `[${pair}] No clear trend detected: ${smas}`);
    }
  }
}
