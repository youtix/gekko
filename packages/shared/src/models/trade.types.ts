export type Trade = {
  /**
   * The id of the exchange order the trade executed for (OrderState.id), not an id of the trade: the trades of an order filled in
   * several parts share it, and the summary of an order picks its trades by it (see createOrderSummary). ccxt's own id of the trade is
   * not kept, and a trade ccxt gives without the id of its order gets '', which no order has.
   */
  id: string;
  amount: number;
  timestamp: EpochTimeStamp;
  price: number;
  fee: {
    /** Rate in % (0.1 for 0.1 %), undefined when unknown. Never 0 by default: 0 is a trade without fees */
    rate?: number;
    /**
     * What the fee cost, in its currency, as the exchange reports it: the summary of an order takes it for the fee of its trade when it
     * was taken in the currency of the pair, as it is, or in the asset, at the price of the trade (see OrderSummary.fee), and adds up
     * those taken in the asset (see OrderSummary.feeTakenInAsset)
     */
    cost?: number;
    /**
     * The currency the fee was paid in: the asset or the currency of the pair, as the symbol configured writes them, when it is one of
     * them (Hyperliquid names a fee by its token and ccxt the market by the coin the token wraps: a fee taken in UBTC on a pair written
     * UBTC/USDC, which ccxt lists as BTC/USDC, is UBTC, and BTC on a pair written BTC/USDC: see mapCcxtTradeToTrade), any other as the
     * exchange names it (BNB with Binance's fee discount); undefined when the exchange names none. The summary of an order reads it as
     * the asset the fee was taken in (see OrderSummary.feeAsset). The simulator, which takes every fee in the currency of the pair,
     * names that currency.
     */
    currency?: string;
  };
};
