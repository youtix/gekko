// Type imports, here and in indicator.ts that imports this file: the map's file loads the moving averages, which extend Indicator, so
// a value import would close a cycle
import type { MOVING_AVERAGES } from './movingAverages/movingAverages.const';
// Each indicator declares its entry of IndicatorRegistry in its <name>.types.ts, a global declaration that importing the indicator
// does not bring: imported here, where the indicators, the moving averages and the strategies' types all lead, every program that
// reaches an indicator sees every entry. A workspace above the indicators no longer includes their *.types.ts in its tsconfig, without
// which its type:check failed on every name addIndicator takes (`Type '"SMA"' does not satisfy the constraint 'never'`). A new
// indicator adds its line, which scripts/tooling/typeCheck.test.ts holds to the files that declare an entry
import type {} from './directionalMovement/adx/adx.types';
import type {} from './directionalMovement/adxRibbon/adxRibbon.types';
import type {} from './directionalMovement/dx/dx.types';
import type {} from './directionalMovement/minusDI/minusDI.types';
import type {} from './directionalMovement/minusDM/minusDM.types';
import type {} from './directionalMovement/plusDI/plusDI.types';
import type {} from './directionalMovement/plusDM/plusDM.types';
import type {} from './momentum/macd/macd.types';
import type {} from './momentum/psar/psar.types';
import type {} from './momentum/roc/roc.types';
import type {} from './momentum/stochastic/stochastic.types';
import type {} from './momentum/stochasticRSI/stochasticRSI.types';
import type {} from './momentum/trix/trix.types';
import type {} from './momentum/williamsR/williamsR.types';
import type {} from './movingAverages/dema/dema.types';
import type {} from './movingAverages/ema/ema.types';
import type {} from './movingAverages/emaRibbon/emaRibbon.types';
import type {} from './movingAverages/sma/sma.types';
import type {} from './movingAverages/smma/smma.types';
import type {} from './movingAverages/tema/tema.types';
import type {} from './movingAverages/wilderSmoothing/wilderSmoothing.types';
import type {} from './movingAverages/wma/wma.types';
import type {} from './oscillators/ao/ao.types';
import type {} from './oscillators/cci/cci.types';
import type {} from './oscillators/rsi/rsi.types';
import type {} from './volatility/atr/atr.types';
import type {} from './volatility/atrcd/atrcd.types';
import type {} from './volatility/bollingerBands/bollingerBands.types';
import type {} from './volatility/trueRange/trueRange.types';
import type {} from './volume/efi/efi.types';
import type {} from './volume/obv/obv.types';

export type IndicatorNames = keyof IndicatorRegistry;
export type IndicatorParameters<T extends IndicatorNames> = IndicatorRegistry[T]['input'];
export type MovingAverageClasses = InstanceType<(typeof MOVING_AVERAGES)[MovingAverageTypes]>;
export type MovingAverageTypes = keyof typeof MOVING_AVERAGES;
