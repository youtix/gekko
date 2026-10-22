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
    /** Informative: what the fee cost, in its currency, as the exchange reports it */
    cost?: number;
    /**
     * The currency the fee was paid in: the asset or the currency of the pair, as Gekko names them, when it is one of them (ccxt's
     * hyperliquid names a fee by its token, UBTC for the BTC of BTC/USDC: see mapCcxtTradeToTrade), any other as the exchange names it
     * (BNB with Binance's fee discount); undefined when the exchange names none. The summary of an order reads it as the asset the
     * fee was taken in (see OrderSummary.feeAsset). The simulator names the currency of the pair, which it takes every fee in.
     */
    currency?: string;
  };
};
