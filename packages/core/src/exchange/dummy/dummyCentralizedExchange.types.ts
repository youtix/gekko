import { OrderSide, OrderState } from '@gekko/shared/models/order.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import z from 'zod';
import type { dummyExchangeSchema } from '@gekko/schemas/exchange/dummyCentralizedExchange.schema';

export type DummyCentralizedExchangeConfig = z.infer<typeof dummyExchangeSchema>;

export type DummyInternalOrder = OrderState & {
  side: OrderSide;
  amount: number;
  type: 'MARKET' | 'LIMIT';
  symbol: TradingPair;
};
