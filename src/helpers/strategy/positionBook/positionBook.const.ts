import { DEFAULT_FEE_BUFFER } from '@constants/order.const';
import { addPrecise } from '@utils/math/math.utils';
import { shiftDecimalPoint } from '@utils/math/round.utils';

/** The decimals the share of the currency a BUY is allocated, in percent, is rounded down to (see PositionBook.buy) */
export const SHARE_DECIMALS = 6;
/** What a BUY sized from a budget costs of it before the amount step, the rest kept back for its fee (DEFAULT_FEE_BUFFER), in decimal */
export const BUY_COST_SHARE = addPrecise(1, -DEFAULT_FEE_BUFFER);
/** The share DEFAULT_FEE_BUFFER keeps back for the fee, in %, as the lines of the Trader write it */
export const FEE_BUFFER_PERCENT = shiftDecimalPoint(DEFAULT_FEE_BUFFER, 2);
