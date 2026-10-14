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
    /** Informative: the currency the fee was paid in, as the exchange names it */
    currency?: string;
  };
};
