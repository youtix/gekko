import { EMPTY_ORDER_SUMMARY } from '@gekko/shared/constants/order.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { Trade } from '@gekko/shared/models/trade.types';
import { Exchange } from '@gekko/shared/models/exchange.types';
import { debug } from '../../logger/logger';
import { useTimeZone } from '@gekko/shared/utils/date/date.mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Transaction } from './order.types';
import { createOrderSummary, getWeightedAverage } from './order.helper';

vi.mock('../../logger/logger', () => ({ debug: vi.fn() }));

const fetchMyTrades = vi.fn();
const exchange = { fetchMyTrades } as unknown as Exchange;

const transaction = (id: string, timestamp: EpochTimeStamp): Transaction => ({ id, timestamp, filled: 1, status: 'closed' });
const trade = (id: string, amount: number, price: number, timestamp: EpochTimeStamp, fee?: Trade['fee']) =>
  ({ id, amount, price, timestamp, fee }) as Trade;

const summarize = (transactions: Transaction[]) =>
  createOrderSummary({
    id: 'ee21e130-48bc-405f-be0c-46e9bf17b52e',
    symbol: 'BTC/USDT',
    exchange,
    type: 'STICKY',
    side: 'BUY',
    transactions,
  });

// In binary, the mean of the first three is 104.44000000000001, 100.50000000000001 and 104.44000000000001, and the sums of 'two
// prices whose binary sums go astray' are off far enough that their mean, rounded to 15 significant digits, is 84633.4737320045
describe('getWeightedAverage', () => {
  it.each`
    case                                               | values                      | weights               | expected
    ${'one price, which a binary mean missed'}         | ${[104.44]}                 | ${[2.5]}              | ${104.44}
    ${'one price, for a small weight'}                 | ${[100.5]}                  | ${[0.01]}             | ${100.5}
    ${'one price for two weights'}                     | ${[104.44, 104.44]}         | ${[0.3, 0.6]}         | ${104.44}
    ${'one price for two other weights'}               | ${[104.44, 104.44]}         | ${[0.1, 0.2]}         | ${104.44}
    ${'two prices whose mean is as short as they are'} | ${[104.44, 104.46]}         | ${[0.3, 0.3]}         | ${104.45}
    ${'two prices weighted unevenly'}                  | ${[110, 100]}               | ${[3, 1]}             | ${107.5}
    ${'a mean with no end, to 15 significant digits'}  | ${[100, 101]}               | ${[1, 2]}             | ${100.666666666667}
    ${'a value made in binary, 101.2 + 0.01'}          | ${[101.21000000000001]}     | ${[1]}                | ${101.21}
    ${'a rate made in binary, 0.0007 × 100'}           | ${[0.06999999999999999]}    | ${[1.67428]}          | ${0.07}
    ${'small prices weighed by large amounts'}         | ${[0.00001234, 0.00001236]} | ${[1e9, 1e9]}         | ${0.00001235}
    ${'a value of 0 among others'}                     | ${[0, 0.5]}                 | ${[1, 3]}             | ${0.375}
    ${'two prices whose binary sums go astray'}        | ${[84653.67, 84618.58]}     | ${[0.25296, 0.34302]} | ${84633.4737320044}
    ${'values and weights of different lengths'}       | ${[1, 2]}                   | ${[1]}                | ${NaN}
    ${'no value'}                                      | ${[]}                       | ${[]}                 | ${NaN}
    ${'weights adding up to 0'}                        | ${[100, 101]}               | ${[0, 0]}             | ${NaN}
    ${'a weight that is not a finite number'}          | ${[100, 101]}               | ${[1, NaN]}           | ${NaN}
    ${'a value that is not a finite number'}           | ${[NaN, 101]}               | ${[1, 1]}             | ${NaN}
  `('gives $expected given $case', ({ values, weights, expected }) => {
    expect(getWeightedAverage(values, weights)).toBe(expected);
  });
});

describe('createOrderSummary', () => {
  beforeEach(() => {
    fetchMyTrades.mockResolvedValue([]);
  });

  it('throws a GekkoError when the order has no transaction', async () => {
    await expect(summarize([])).rejects.toThrow(GekkoError);
  });

  // A sticky order places several exchange orders, and an exchange may give an order without a timestamp
  it.each`
    case                                        | timestamps                                     | from
    ${'the oldest transaction comes first'}     | ${[1_000_700, 2_000_500]}                      | ${1_000_000}
    ${'the transactions are not sorted'}        | ${[3_000_000, 2_000_500, 1_000_700]}           | ${1_000_000}
    ${'some timestamps are not finite numbers'} | ${[NaN, 5_000_300, undefined, Infinity, null]} | ${5_000_000}
    ${'no timestamp is a finite number'}        | ${[NaN, undefined, -Infinity]}                 | ${undefined}
  `('fetches the trades from the start of the second of the oldest finite timestamp when $case', async ({ timestamps, from }) => {
    await summarize(timestamps.map((timestamp: EpochTimeStamp, index: number) => transaction(`ex-${index}`, timestamp)));
    expect(fetchMyTrades).toHaveBeenCalledWith('BTC/USDT', from);
  });

  // On 2025-10-26 Paris goes from 03:00 CEST back to 02:00 CET: the hour from 01:00Z to 02:00Z is the second pass of 02:00-03:00.
  // Floored in local time, a timestamp of that second pass fetched the trades from an hour earlier.
  describe('on a host in Europe/Paris', () => {
    useTimeZone('Europe/Paris');

    it.each`
      case                                         | timestamp                     | from
      ${'a transaction of the second pass'}        | ${'2025-10-26T01:30:00.500Z'} | ${'2025-10-26T01:30:00.000Z'}
      ${'the last millisecond of the second pass'} | ${'2025-10-26T01:59:59.999Z'} | ${'2025-10-26T01:59:59.000Z'}
      ${'a transaction of the first pass'}         | ${'2025-10-26T00:30:00.500Z'} | ${'2025-10-26T00:30:00.000Z'}
    `('fetches the trades from $from for $case, at $timestamp', async ({ timestamp, from }) => {
      await summarize([transaction('ex-0', Date.parse(timestamp))]);
      expect(fetchMyTrades).toHaveBeenCalledWith('BTC/USDT', Date.parse(from));
    });
  });

  it('logs an unknown start for the trades fetched when no timestamp is a finite number', async () => {
    await summarize([transaction('ex-0', NaN)]);
    expect(debug).toHaveBeenCalledWith('core', expect.stringContaining('First trade started at: Unknown Date.'));
  });

  it('returns the empty summary of its side when no trade belongs to the order', async () => {
    fetchMyTrades.mockResolvedValue([trade('another-order', 1, 100, 1_100_000, { rate: 0.1 })]);
    expect(await summarize([transaction('ex-0', 1_000_000)])).toEqual({ ...EMPTY_ORDER_SUMMARY, side: 'BUY' });
  });

  // Their fees, 0.5 % of the 330 the second cost and 0.1 % of the 100 the first cost, 1.75, over the 430 both cost: 0.406976744186047 %,
  // which the Trader multiplies by the cost of the order, 4 at 107.5, for the fee of 1.75 they paid. Their rates weighted by their
  // amounts, 0.4 %, made a fee of 1.72.
  it('summarizes the trades of the order, in the order they were made', async () => {
    fetchMyTrades.mockResolvedValue([
      trade('ex-1', 3, 110, 2_500_000, { rate: 0.5 }),
      trade('another-order', 10, 90, 1_200_000, { rate: 0.1 }),
      trade('ex-0', 1, 100, 1_100_000, { rate: 0.1 }),
    ]);
    const summary = await summarize([transaction('ex-1', 2_000_000), transaction('ex-0', 1_000_000)]);
    expect(summary).toEqual({
      amount: 4,
      price: 107.5,
      feePercent: 0.406976744186047,
      feeAsset: undefined,
      feeTakenInAsset: undefined,
      side: 'BUY',
      orderExecutionDate: 2_500_000,
    });
  });

  // Each trade's fee is its rate of its own cost, 100 for the first trade, 1 at 100, and 330 for the second, 3 at 110: the rate of the
  // order is their fees over the 430 both cost. A fee taken in a third asset without a rate (BNB with Binance's discount) counts 0, its
  // trade weighing all the same; a trade that says nothing of its fee is left out, its fee taken at the rate of the other.
  it.each`
    case                                              | fees                                                                      | feePercent
    ${'every trade has a rate'}                       | ${[{ rate: 0.1 }, { rate: 0.5 }]}                                         | ${0.406976744186047}
    ${'the trades share a rate'}                      | ${[{ rate: 0.1 }, { rate: 0.1 }]}                                         | ${0.1}
    ${'a trade was made without fees'}                | ${[{ rate: 0 }, { rate: 0.5 }]}                                           | ${0.383720930232558}
    ${'a trade paid in BNB, its rate unknown'}        | ${[{ cost: 0.001, currency: 'BNB' }, { rate: 0.5 }]}                      | ${0.383720930232558}
    ${'a trade paid in BNB at a rate given'}          | ${[{ rate: 0.075, currency: 'BNB' }, { rate: 0.5 }]}                      | ${0.401162790697674}
    ${'a rate is not a finite number'}                | ${[{ rate: NaN }, { rate: 0.5 }]}                                         | ${0.5}
    ${'a rate is null'}                               | ${[{ rate: null }, { rate: 0.5 }]}                                        | ${0.5}
    ${'a trade has no fee'}                           | ${[undefined, { rate: 0.5 }]}                                             | ${0.5}
    ${'a trade names the currency without a rate'}    | ${[{ cost: 0.1, currency: 'USDT' }, { rate: 0.5 }]}                       | ${0.5}
    ${'a trade names the asset without a rate'}       | ${[{ cost: 0.001, currency: 'BTC' }, { rate: 0.5 }]}                      | ${0.5}
    ${'a currency is empty'}                          | ${[{ cost: 0.001, currency: '' }, { rate: 0.5 }]}                         | ${0.5}
    ${'no trade has a rate'}                          | ${[{ cost: 0.001, currency: 'BNB' }, { rate: NaN }]}                      | ${undefined}
    ${'every trade paid in BNB, their rates unknown'} | ${[{ cost: 0.0001, currency: 'BNB' }, { cost: 0.0003, currency: 'BNB' }]} | ${undefined}
    ${'no trade has a fee'}                           | ${[undefined, undefined]}                                                 | ${undefined}
  `('gives a fee percent of $feePercent when $case', async ({ fees, feePercent }) => {
    fetchMyTrades.mockResolvedValue([trade('ex-0', 1, 100, 1_100_000, fees[0]), trade('ex-1', 3, 110, 2_500_000, fees[1])]);
    const summary = await summarize([transaction('ex-0', 1_000_000), transaction('ex-1', 2_000_000)]);
    expect(summary.feePercent).toBe(feePercent);
  });

  it.each`
    case                                      | fee
    ${'a trade that says nothing of its fee'} | ${{}}
    ${'a trade paid in BNB'}                  | ${{ cost: 0.0003, currency: 'BNB' }}
  `('gives no fee percent when the trades with a rate weigh nothing, beside $case', async ({ fee }) => {
    fetchMyTrades.mockResolvedValue([trade('ex-0', 0, 100, 1_100_000, { rate: 0.1 }), trade('ex-1', 3, 110, 2_500_000, fee)]);
    const summary = await summarize([transaction('ex-0', 1_000_000), transaction('ex-1', 2_000_000)]);
    expect(summary.feePercent).toBeUndefined();
  });

  // Its fee weighs by what it cost: a price that is not a number leaves the rate of the order unknown, as it leaves its price
  it('gives no fee percent when a trade has no price to weigh its fee by', async () => {
    fetchMyTrades.mockResolvedValue([trade('ex-0', 1, NaN, 1_100_000, { rate: 0.1 }), trade('ex-1', 3, 110, 2_500_000, { rate: 0.5 })]);
    const summary = await summarize([transaction('ex-0', 1_000_000), transaction('ex-1', 2_000_000)]);
    expect(summary.feePercent).toBeUndefined();
  });

  // The asset the fee was taken in is the one every trade that names the currency of its fee names, whatever its rate: Binance takes
  // a BUY's fee in the asset bought, a SELL's in the currency, either in BNB with its discount, which no rate converts
  it.each`
    case                                              | fees                                                                      | feeAsset
    ${'every trade paid in the asset bought'}         | ${[{ cost: 0.001, currency: 'BTC' }, { cost: 0.003, currency: 'BTC' }]}   | ${'BTC'}
    ${'every trade paid in the currency'}             | ${[{ rate: 0.1, currency: 'USDT' }, { rate: 0.1, currency: 'USDT' }]}     | ${'USDT'}
    ${'every trade paid in BNB, their rates unknown'} | ${[{ cost: 0.0001, currency: 'BNB' }, { cost: 0.0003, currency: 'BNB' }]} | ${'BNB'}
    ${'a trade names no currency'}                    | ${[{ rate: 0.1 }, { cost: 0.003, currency: 'BTC' }]}                      | ${'BTC'}
    ${'a trade has no fee'}                           | ${[undefined, { cost: 0.003, currency: 'BTC' }]}                          | ${'BTC'}
    ${'the trades paid in BNB, then in the asset'}    | ${[{ cost: 0.0001, currency: 'BNB' }, { cost: 0.003, currency: 'BTC' }]}  | ${undefined}
    ${'no trade names a currency'}                    | ${[{ rate: 0.1 }, { rate: 0.5 }]}                                         | ${undefined}
    ${'a currency is empty'}                          | ${[{ cost: 0.001, currency: '' }, { rate: 0.5 }]}                         | ${undefined}
    ${'no trade has a fee'}                           | ${[undefined, undefined]}                                                 | ${undefined}
  `('gives a fee asset of $feeAsset when $case', async ({ fees, feeAsset }) => {
    fetchMyTrades.mockResolvedValue([trade('ex-0', 1, 100, 1_100_000, fees[0]), trade('ex-1', 3, 110, 2_500_000, fees[1])]);
    const summary = await summarize([transaction('ex-0', 1_000_000), transaction('ex-1', 2_000_000)]);
    expect(summary.feeAsset).toBe(feeAsset);
  });

  it('gives the fee asset of the trades of the order alone, not of those of another order', async () => {
    fetchMyTrades.mockResolvedValue([
      trade('another-order', 10, 90, 1_200_000, { cost: 0.0001, currency: 'BNB' }),
      trade('ex-0', 1, 100, 1_100_000, { cost: 0.001, currency: 'BTC' }),
    ]);
    const summary = await summarize([transaction('ex-0', 1_000_000)]);
    expect(summary.feeAsset).toBe('BTC');
  });

  // What the fees took of the asset bought, 1 at 100 then 3 at 110: each fee's cost, else its rate of the amount of its trade, valued at
  // the price of its trade. A fee in the currency, or in BNB, takes nothing of it.
  it.each`
    case                                                | fees                                                                             | feeTakenInAsset
    ${'every trade paid in the asset bought'}           | ${[{ cost: 0.001, currency: 'BTC' }, { cost: 0.003, currency: 'BTC' }]}          | ${{ amount: 0.004, value: 0.43 }}
    ${'the trades paid in BNB, then in the asset'}      | ${[{ cost: 0.0001, currency: 'BNB' }, { cost: 0.003, currency: 'BTC' }]}         | ${{ amount: 0.003, value: 0.33 }}
    ${'a fee in the asset is given by its rate alone'}  | ${[{ rate: 0.1, currency: 'BTC' }, { cost: 0.003, currency: 'BTC' }]}            | ${{ amount: 0.004, value: 0.43 }}
    ${'the cost of a fee is not a finite number'}       | ${[{ rate: 0.1, cost: NaN, currency: 'BTC' }, { cost: 0.003, currency: 'BTC' }]} | ${{ amount: 0.004, value: 0.43 }}
    ${'a fee in the asset gives neither cost nor rate'} | ${[{ currency: 'BTC' }, { cost: 0.003, currency: 'BTC' }]}                       | ${{ amount: 0.003, value: 0.33 }}
    ${'fees whose binary sum goes astray, 0.1 and 0.2'} | ${[{ cost: 0.1, currency: 'BTC' }, { cost: 0.2, currency: 'BTC' }]}              | ${{ amount: 0.3, value: 32 }}
    ${'every trade paid in the currency'}               | ${[{ rate: 0.1, currency: 'USDT' }, { rate: 0.1, currency: 'USDT' }]}            | ${undefined}
    ${'every trade paid in BNB'}                        | ${[{ cost: 0.0001, currency: 'BNB' }, { cost: 0.0003, currency: 'BNB' }]}        | ${undefined}
    ${'no trade has a fee'}                             | ${[undefined, undefined]}                                                        | ${undefined}
  `('gives what the fees took of the asset, $feeTakenInAsset, when $case', async ({ fees, feeTakenInAsset }) => {
    fetchMyTrades.mockResolvedValue([trade('ex-0', 1, 100, 1_100_000, fees[0]), trade('ex-1', 3, 110, 2_500_000, fees[1])]);
    const summary = await summarize([transaction('ex-0', 1_000_000), transaction('ex-1', 2_000_000)]);
    expect(summary.feeTakenInAsset).toEqual(feeTakenInAsset);
  });

  // A BUY of 1 BTC on Binance whose BNB ran out after its first trade: 0.0001 BNB for the first 0.5, its rate unknown, then 0.0005 BTC,
  // 0.1 %, for the second. The trades name no one asset. The fee of the order is what the second took of the BTC, valued at its price,
  // the BNB counting 0: 0.05 USDT at one price, 0.05 % of the order. The rate of the BTC trade, taken for all of it, charged the half
  // paid in BNB too: a fee of 0.1 USDT.
  it.each`
    case                      | secondPrice | summary
    ${'at one price'}         | ${100}      | ${{ amount: 1, price: 100, feePercent: 0.05, feeTakenInAsset: { amount: 0.0005, value: 0.05 } }}
    ${'the second at 100.02'} | ${100.02}   | ${{ amount: 1, price: 100.01, feePercent: 0.05000499950005, feeTakenInAsset: { amount: 0.0005, value: 0.05001 } }}
  `('summarizes a BUY whose BNB ran out partway, filled $case', async ({ secondPrice, summary }) => {
    fetchMyTrades.mockResolvedValue([
      trade('ex-0', 0.5, 100, 1_100_000, { cost: 0.0001, currency: 'BNB' }),
      trade('ex-0', 0.5, secondPrice, 1_200_000, { rate: 0.1, cost: 0.0005, currency: 'BTC' }),
    ]);
    expect(await summarize([transaction('ex-0', 1_000_000)])).toStrictEqual({
      ...summary,
      feeAsset: undefined,
      side: 'BUY',
      orderExecutionDate: 1_200_000,
    });
  });

  // Worked out in binary, the figures of a summary came out an ulp or two off the decimals the trades were made at: a LIMIT order
  // placed at 104.44 was reported at 104.44000000000001
  describe('of trades whose figures are decimals', () => {
    const summarizeTrades = async (trades: Trade[]) => {
      fetchMyTrades.mockResolvedValue(trades);
      return summarize(trades.map(({ id }, index) => transaction(id, 1_000_000 + index)));
    };

    it.each`
      case                                                 | trades                                                                            | price
      ${'a LIMIT order filled at 104.44 for 2.5'}          | ${[trade('ex-0', 2.5, 104.44, 1_100_000)]}                                        | ${104.44}
      ${'a LIMIT order filled at 104.44 in two trades'}    | ${[trade('ex-0', 0.1, 104.44, 1_100_000), trade('ex-0', 0.2, 104.44, 1_200_000)]} | ${104.44}
      ${'a STICKY order filled at 99 for 1.67428'}         | ${[trade('ex-0', 1.67428, 99, 1_100_000)]}                                        | ${99}
      ${'a STICKY order placed at 101.2 + 0.01 in binary'} | ${[trade('ex-0', 1, 101.21000000000001, 1_100_000)]}                              | ${101.21}
      ${'two fills of 0.3, at 104.44 and 104.46'}          | ${[trade('ex-0', 0.3, 104.44, 1_100_000), trade('ex-1', 0.3, 104.46, 1_200_000)]} | ${104.45}
      ${'fills of 1 at 100 and 2 at 101'}                  | ${[trade('ex-0', 1, 100, 1_100_000), trade('ex-1', 2, 101, 1_200_000)]}           | ${100.666666666667}
    `('gives the price of $case exactly', async ({ trades, price }) => {
      expect((await summarizeTrades(trades)).price).toBe(price);
    });

    it.each`
      case                                   | trades                                                                            | amount
      ${'two trades of 0.1 and 0.2'}         | ${[trade('ex-0', 0.1, 104.44, 1_100_000), trade('ex-0', 0.2, 104.44, 1_200_000)]} | ${0.3}
      ${'two transactions of 0.02 and 0.07'} | ${[trade('ex-0', 0.02, 100, 1_100_000), trade('ex-1', 0.07, 100, 1_200_000)]}     | ${0.09}
    `('gives the amount of $case exactly', async ({ trades, amount }) => {
      expect((await summarizeTrades(trades)).amount).toBe(amount);
    });

    // A rate worked out in binary, as the simulator used to journal a taker fee of 0.0007: 0.0007 × 100 is 0.06999999999999999
    it('gives the fee percent of a rate reported in binary as the decimal it stands for', async () => {
      const summary = await summarizeTrades([trade('ex-0', 1.67428, 99, 1_100_000, { rate: 0.06999999999999999 })]);
      expect(summary.feePercent).toBe(0.07);
    });
  });
});
