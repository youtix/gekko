import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { formatAmount } from '@gekko/shared/utils/string/string.utils';

/**
 * The balances of a portfolio for a person to read, in its order: 1 BTC, 10,000 USDT. The simulator's, read once it is built: every
 * asset and currency of the watched pairs, at 0 without a simulationBalance, and nothing else. A new simulator holds everything free.
 * The configured simulationBalance used to be written with JSON.stringify, which writes a Map as {}: "Initial portfolio: {}".
 */
export const describePortfolio = (portfolio: Portfolio) =>
  [...portfolio].map(([asset, { total }]) => `${formatAmount(total)} ${asset}`).join(', ');
