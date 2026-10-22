import { GekkoError } from '@gekko/shared/errors/gekko.error';
import * as logger from '../logger/logger';
import { wait } from '@gekko/shared/utils/process/process.utils';
import ccxt, { binance, hyperliquid, NetworkError } from 'ccxt';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { pick } from 'lodash-es';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROKER_MAX_RETRIES_ON_FAILURE, PRICE_SIGNIFICANT_DIGITS } from './exchange.const';
import { ExchangeNetworkError, InvalidOrder, OrderNotFound } from './exchange.error';
import * as utils from './exchange.helper';

vi.mock('../logger/logger', () => ({
  debug: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@gekko/shared/utils/process/process.utils', () => ({
  wait: vi.fn().mockResolvedValue(undefined),
}));

describe('exchange.helper', () => {
  describe('retry', () => {
    const timeout = new ccxt.RequestTimeout('binance GET https://api.binance.com/api/v3/order request timed out (10000 ms)');
    const keyRefused = new ccxt.AuthenticationError('binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}');
    // A rejection with a value that is not an Error, which the log line writes as it is
    const hangUp = 'socket hang up';
    // A failure of Gekko's own in the call, quoted without its tag: the log line has the exchange's
    const noTicker = new GekkoError('exchange', 'Fetch ticker failed to return data for BTC/USDT');

    it('should return result immediately on success', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      expect(await utils.retry(fn)).toBe('success');
    });

    it('should retry on NetworkError', async () => {
      const fn = vi.fn().mockRejectedValueOnce(new NetworkError('fail 1')).mockResolvedValue('success');
      expect(await utils.retry(fn)).toBe('success');
    });

    it('should verify retry called correctly', async () => {
      const fn = vi.fn().mockRejectedValueOnce(new NetworkError('fail 1')).mockResolvedValue('success');
      await utils.retry(fn);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw after max retries', async () => {
      const fn = vi.fn().mockRejectedValue(new NetworkError('fail'));
      await expect(utils.retry(fn, 0, 2)).rejects.toThrow(ExchangeNetworkError);
    });

    it('should throw non-NetworkError immediately', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Fatal'));
      await expect(utils.retry(fn)).rejects.toThrow('Fatal');
    });

    it('calls 3 times, the first call numbered 0, with a maxRetries of 2', async () => {
      const fn = vi.fn().mockRejectedValue(new NetworkError('fail'));
      await utils.retry(fn, 0, 2).catch(() => undefined);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    // Numbered from 0, as the fetcher numbers its requests: numbered from 1, every read waited 1585, 2000 and 2322 ms
    it.each`
      call | delay
      ${1} | ${1000}
      ${2} | ${1584.9625007211562}
      ${3} | ${2000}
    `('waits $delay ms after the failure of call $call, as the fetcher does', async ({ call, delay }) => {
      await utils.retry(vi.fn().mockRejectedValue(timeout)).catch(() => undefined);
      expect(wait).toHaveBeenNthCalledWith(call, delay);
    });

    it('waits BROKER_MAX_RETRIES_ON_FAILURE times before giving up', async () => {
      await utils.retry(vi.fn().mockRejectedValue(timeout)).catch(() => undefined);
      expect(wait).toHaveBeenCalledTimes(BROKER_MAX_RETRIES_ON_FAILURE);
    });

    // The callers log what they could not read, at the level it deserves. Logged here as an error then a warning, a read that failed
    // once reached Telegram as an alert (Supervision forwards every warning and error) though it succeeded at the next call.
    describe.each`
      description                                      | createFn
      ${'a read that times out once, then succeeds'}   | ${() => vi.fn().mockRejectedValueOnce(timeout).mockResolvedValue('order')}
      ${'a read that times out on every call'}         | ${() => vi.fn().mockRejectedValue(timeout)}
      ${'a read the exchange refuses'}                 | ${() => vi.fn().mockRejectedValue(keyRefused)}
      ${'a read that fails with a value not an Error'} | ${() => vi.fn().mockRejectedValue(hangUp)}
    `('$description', ({ createFn }) => {
      it.each`
        level
        ${'error'}
        ${'warning'}
      `('logs no $level', async ({ level }) => {
        await utils.retry(createFn()).catch(() => undefined);
        expect(logger[level as 'error' | 'warning']).not.toHaveBeenCalled();
      });
    });

    it.each`
      description                       | createFn                                                                      | line | message
      ${'a timeout, retried'}           | ${() => vi.fn().mockRejectedValue(timeout)}                                   | ${1} | ${`Call to the exchange failed, attempt 1 of 4, retried in 1000 ms: ${timeout.message}`}
      ${'a second timeout, retried'}    | ${() => vi.fn().mockRejectedValue(timeout)}                                   | ${2} | ${`Call to the exchange failed, attempt 2 of 4, retried in 1585 ms: ${timeout.message}`}
      ${'a fourth timeout, given up'}   | ${() => vi.fn().mockRejectedValue(timeout)}                                   | ${4} | ${`Call to the exchange failed, attempt 4 of 4, given up: ${timeout.message}`}
      ${'a refusal, not retried'}       | ${() => vi.fn().mockRejectedValue(keyRefused)}                                | ${1} | ${`Call to the exchange failed, attempt 1, not retried: ${keyRefused.message}`}
      ${'a value that is not an Error'} | ${() => vi.fn().mockRejectedValue(hangUp)}                                    | ${1} | ${`Call to the exchange failed, attempt 1, not retried: ${hangUp}`}
      ${'a GekkoError, not retried'}    | ${() => vi.fn().mockRejectedValue(noTicker)}                                  | ${1} | ${'Call to the exchange failed, attempt 1, not retried: Fetch ticker failed to return data for BTC/USDT'}
      ${'a refusal after a timeout'}    | ${() => vi.fn().mockRejectedValueOnce(timeout).mockRejectedValue(keyRefused)} | ${2} | ${`Call to the exchange failed, attempt 2, not retried: ${keyRefused.message}`}
    `('logs $description at debug level, as line $line: $message', async ({ createFn, line, message }) => {
      await utils.retry(createFn()).catch(() => undefined);
      expect(logger.debug).toHaveBeenNthCalledWith(line, 'exchange', message);
    });

    it('calls again after a NetworkError up to BROKER_MAX_RETRIES_ON_FAILURE times', async () => {
      const fn = vi.fn().mockRejectedValue(new ccxt.RequestTimeout('binance GET https://api.binance.com/api/v3/order request timed out'));
      await utils.retry(fn).catch(() => undefined);
      expect(fn).toHaveBeenCalledTimes(BROKER_MAX_RETRIES_ON_FAILURE + 1);
    });

    it('rejects with an ExchangeNetworkError once the retries are exhausted', async () => {
      const fn = vi.fn().mockRejectedValue(new ccxt.RequestTimeout('binance GET https://api.binance.com/api/v3/order request timed out'));
      await expect(utils.retry(fn)).rejects.toBeInstanceOf(ExchangeNetworkError);
    });

    it('keeps the last NetworkError as the cause once the retries are exhausted', async () => {
      const lastError = new ccxt.ExchangeNotAvailable('binance 503 Service Unavailable');
      const fn = vi.fn().mockRejectedValueOnce(new ccxt.RequestTimeout('binance request timed out')).mockRejectedValue(lastError);
      await expect(utils.retry(fn, 0, 1)).rejects.toHaveProperty('cause', lastError);
    });

    it.each`
      error
      ${new ccxt.InvalidOrder('binance {"code":-2010,"msg":"Duplicate order sent."}')}
      ${new ccxt.OrderNotFound('binance {"code":-2011,"msg":"Unknown order sent."}')}
      ${new ccxt.AuthenticationError('binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}')}
    `('does not call again after $error.name', async ({ error }) => {
      const fn = vi.fn().mockRejectedValue(error);
      await utils.retry(fn).catch(() => undefined);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not call again after an ExchangeNetworkError, which a nested retry already gave up on', async () => {
      const fn = vi.fn().mockRejectedValue(new ExchangeNetworkError('binance GET https://api.binance.com/api/v3/ticker request timed out'));
      await utils.retry(fn).catch(() => undefined);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('rejects a value which is not an Error unchanged', async () => {
      const fn = vi.fn().mockRejectedValue('Fatal');
      await expect(utils.retry(fn)).rejects.toBe('Fatal');
    });

    it.each`
      error                                                                                           | expected
      ${new ccxt.OrderNotFound('binance {"code":-2011,"msg":"Unknown order sent."}')}                 | ${OrderNotFound}
      ${new ccxt.BadRequest('binance {"code":-1013,"msg":"Filter failure: NOTIONAL"}')}               | ${InvalidOrder}
      ${new ccxt.InsufficientFunds('binance Account has insufficient balance for requested action.')} | ${InvalidOrder}
    `('rejects the ccxt $error.name at once with the $expected.name of Gekko', async ({ error, expected }) => {
      const fn = vi.fn().mockRejectedValue(error);
      await expect(utils.retry(fn)).rejects.toBeInstanceOf(expected);
    });
  });

  describe('translateCcxtError', () => {
    const message = 'binance {"code":-2010,"msg":"Account has insufficient balance for requested action."}';

    it.each`
      ccxtError                 | expected
      ${ccxt.OrderNotFound}     | ${OrderNotFound}
      ${ccxt.InvalidOrder}      | ${InvalidOrder}
      ${ccxt.InsufficientFunds} | ${InvalidOrder}
      ${ccxt.BadRequest}        | ${InvalidOrder}
      ${ccxt.BadSymbol}         | ${InvalidOrder}
      ${ccxt.NetworkError}      | ${ExchangeNetworkError}
      ${ccxt.RequestTimeout}    | ${ExchangeNetworkError}
      ${ccxt.RateLimitExceeded} | ${ExchangeNetworkError}
      ${ccxt.OnMaintenance}     | ${ExchangeNetworkError}
    `('translates the ccxt $ccxtError.name into the $expected.name of Gekko', ({ ccxtError, expected }) => {
      expect(utils.translateCcxtError(new ccxtError(message))).toBeInstanceOf(expected);
    });

    it.each`
      ccxtError
      ${ccxt.OrderNotFound}
      ${ccxt.InsufficientFunds}
      ${ccxt.RequestTimeout}
    `('keeps the message of the ccxt $ccxtError.name', ({ ccxtError }) => {
      expect(utils.translateCcxtError(new ccxtError(message))).toHaveProperty('message', expect.stringContaining(message));
    });

    it.each`
      ccxtError
      ${ccxt.OrderNotFound}
      ${ccxt.InsufficientFunds}
      ${ccxt.RequestTimeout}
    `('keeps the ccxt $ccxtError.name as the cause', ({ ccxtError }) => {
      const ccxtErrorInstance = new ccxtError(message);
      expect(utils.translateCcxtError(ccxtErrorInstance)).toHaveProperty('cause', ccxtErrorInstance);
    });

    it.each`
      description                        | value
      ${'a ccxt AuthenticationError'}    | ${new ccxt.AuthenticationError(message)}
      ${'a ccxt ArgumentsRequired'}      | ${new ccxt.ArgumentsRequired(message)}
      ${'a generic ccxt ExchangeError'}  | ${new ccxt.ExchangeError(message)}
      ${'a ccxt OperationFailed'}        | ${new ccxt.OperationFailed(message)}
      ${'a GekkoError'}                  | ${new GekkoError('exchange', message)}
      ${'an Error'}                      | ${new Error(message)}
      ${'a value which is not an Error'} | ${message}
    `('returns $description unchanged', ({ value }) => {
      expect(utils.translateCcxtError(value)).toBe(value);
    });
  });

  describe('translateErrors', () => {
    it('returns the result of the call', async () => {
      expect(await utils.translateErrors(() => Promise.resolve('order'))).toBe('order');
    });

    it('rejects with the translated error', async () => {
      const fn = () => Promise.reject(new ccxt.InsufficientFunds('binance Account has insufficient balance for requested action.'));
      await expect(utils.translateErrors(fn)).rejects.toBeInstanceOf(InvalidOrder);
    });

    it('rejects a NetworkError at once with an ExchangeNetworkError', async () => {
      const fn = () => Promise.reject(new ccxt.RequestTimeout('binance POST https://api.binance.com/api/v3/order request timed out'));
      await expect(utils.translateErrors(fn)).rejects.toBeInstanceOf(ExchangeNetworkError);
    });

    it('does not call again after a NetworkError', async () => {
      const fn = vi.fn().mockRejectedValue(new ccxt.RequestTimeout('binance POST https://api.binance.com/api/v3/order request timed out'));
      await utils.translateErrors(fn).catch(() => undefined);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('mapCcxtTradeToTrade', () => {
    const timestamp = 1600000000000;
    // As ccxt 4.5.39 builds them: binance's BTC/USDT, whose fees ccxt names by unified codes; hyperliquid's markets of its wrapped
    // tokens, UBTC listed as BTC/USDC and UPUMP as PMP/USDC (a coin name ccxt learns from the token list), with the token as baseName,
    // and a market quoted in USDT0, listed in USDT with the token as quoteId: hyperliquid's fees are named by token (feeToken)
    const binanceMarket: any = { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', baseId: 'BTC', quoteId: 'USDT' };
    const hyperliquidMarket: any = { symbol: 'BTC/USDC', base: 'BTC', baseName: 'UBTC', quote: 'USDC', baseId: '10142', quoteId: 'USDC' };
    const hyperliquidPumpMarket: any = { symbol: 'PMP/USDC', base: 'PMP', baseName: 'UPUMP', quote: 'USDC', quoteId: 'USDC' };
    const hyperliquidUsdt0Market: any = { symbol: 'HYPE/USDT', base: 'HYPE', baseName: 'HYPE', quote: 'USDT', quoteId: 'USDT0' };

    it('maps a trade, keeping the cost and the currency of its fee', () => {
      const trade: any = { id: '1', order: 'ord1', amount: 1, price: 60000, timestamp, fee: { cost: 60, currency: 'USDT' } };
      expect(utils.mapCcxtTradeToTrade(trade, binanceMarket, 'BTC/USDT')).toEqual({
        id: 'ord1',
        amount: 1,
        price: 60000,
        timestamp,
        fee: { rate: 0.1, cost: 60, currency: 'USDT' },
      });
    });

    // The currency of a fee taken in the base or the quote of the market is named as the symbol configured writes the asset and the
    // currency of the pair, the names the portfolio and the round trips read: hyperliquid names a fee by its token, and ccxt resolves a
    // pair written with the token name (UBTC/USDC) to the market of the coin it wraps (BTC/USDC). Any other currency keeps the
    // exchange's name. Named after ccxt's base, the fee of a BUY of UBTC/USDC was taken in BTC, which a round trip of UBTC counted.
    it.each`
      description                                                 | market                    | symbol          | fee                                   | expected
      ${'the quote of binance'}                                   | ${binanceMarket}          | ${'BTC/USDT'}   | ${{ cost: 60, currency: 'USDT' }}     | ${'USDT'}
      ${'the base of binance'}                                    | ${binanceMarket}          | ${'BTC/USDT'}   | ${{ cost: 0.001, currency: 'BTC' }}   | ${'BTC'}
      ${'the token of the base of hyperliquid, written so'}       | ${hyperliquidMarket}      | ${'UBTC/USDC'}  | ${{ cost: 0.001, currency: 'UBTC' }}  | ${'UBTC'}
      ${'the token of the base of hyperliquid, its coin written'} | ${hyperliquidMarket}      | ${'BTC/USDC'}   | ${{ cost: 0.001, currency: 'UBTC' }}  | ${'BTC'}
      ${'the coin of the base of hyperliquid, its token written'} | ${hyperliquidMarket}      | ${'UBTC/USDC'}  | ${{ cost: 0.001, currency: 'BTC' }}   | ${'UBTC'}
      ${'a token ccxt names after a coin of its own'}             | ${hyperliquidPumpMarket}  | ${'UPUMP/USDC'} | ${{ cost: 0.001, currency: 'UPUMP' }} | ${'UPUMP'}
      ${'the quote of hyperliquid'}                               | ${hyperliquidMarket}      | ${'UBTC/USDC'}  | ${{ cost: 60, currency: 'USDC' }}     | ${'USDC'}
      ${'the token of the quote of hyperliquid'}                  | ${hyperliquidUsdt0Market} | ${'HYPE/USDT'}  | ${{ cost: 0.04, currency: 'USDT0' }}  | ${'USDT'}
      ${'another currency, BNB with the discount'}                | ${binanceMarket}          | ${'BTC/USDT'}   | ${{ cost: 0.0001, currency: 'BNB' }}  | ${'BNB'}
      ${'no fee'}                                                 | ${binanceMarket}          | ${'BTC/USDT'}   | ${undefined}                          | ${undefined}
      ${'a fee without currency'}                                 | ${binanceMarket}          | ${'BTC/USDT'}   | ${{ cost: 60 }}                       | ${undefined}
      ${'a fee whose currency is empty'}                          | ${binanceMarket}          | ${'BTC/USDT'}   | ${{ cost: 60, currency: '' }}         | ${undefined}
    `('names the currency of a fee taken in $description, on $symbol, as $expected', ({ market, symbol, fee, expected }) => {
      const trade: any = { id: '1', order: 'ord1', amount: 1, price: 60000, timestamp, fee };
      expect(utils.mapCcxtTradeToTrade(trade, market, symbol).fee.currency).toBe(expected);
    });

    it('maps a trade without an order id to an empty id', () => {
      const trade: any = { amount: 1, price: 60000, timestamp };
      expect(utils.mapCcxtTradeToTrade(trade, binanceMarket, 'BTC/USDT')).toMatchObject({ id: '', amount: 1, price: 60000 });
    });

    // Trade.fee.rate is in % (0.1 for 0.1 %), and undefined when it cannot be known: never 0, which would be a trade without fees
    it.each`
      description                                                                  | market                    | amount | price    | fee                                                    | expected
      ${'converts the rate given by ccxt, a fraction, to a percentage'}            | ${binanceMarket}          | ${1}   | ${60000} | ${{ rate: 0.001 }}                                     | ${0.1}
      ${'prefers the rate given by ccxt to the one derived from the cost'}         | ${binanceMarket}          | ${1}   | ${60000} | ${{ rate: 0.002, cost: 60, currency: 'USDT' }}         | ${0.2}
      ${'derives the rate of a fee in the quote from the cost of the trade'}       | ${binanceMarket}          | ${1}   | ${60000} | ${{ cost: 60, currency: 'USDT' }}                      | ${0.1}
      ${'derives the rate of a fee in the base from the amount of the trade'}      | ${binanceMarket}          | ${1}   | ${60000} | ${{ cost: 0.001, currency: 'BTC' }}                    | ${0.1}
      ${'derives the rate of a fee in the token of the base (baseName)'}           | ${hyperliquidMarket}      | ${1}   | ${60000} | ${{ cost: 0.001, currency: 'UBTC', rate: undefined }}  | ${0.1}
      ${'derives the rate of a fee in a token ccxt names after a coin of its own'} | ${hyperliquidPumpMarket}  | ${1}   | ${60000} | ${{ cost: 0.001, currency: 'UPUMP', rate: undefined }} | ${0.1}
      ${'derives the rate of a fee in the quote of hyperliquid'}                   | ${hyperliquidMarket}      | ${1}   | ${60000} | ${{ cost: 60, currency: 'USDC', rate: undefined }}     | ${0.1}
      ${'derives the rate of a fee in the token of the quote (quoteId)'}           | ${hyperliquidUsdt0Market} | ${1}   | ${40}    | ${{ cost: 0.04, currency: 'USDT0', rate: undefined }}  | ${0.1}
      ${'derives a rate of 0 from a fee that cost nothing'}                        | ${binanceMarket}          | ${1}   | ${60000} | ${{ cost: 0, currency: 'USDT' }}                       | ${0}
      ${'derives the rate when the rate given by ccxt is not finite'}              | ${binanceMarket}          | ${1}   | ${60000} | ${{ rate: Number.NaN, cost: 60, currency: 'USDT' }}    | ${0.1}
      ${'leaves the rate of a fee in another currency (BNB discount) unknown'}     | ${binanceMarket}          | ${1}   | ${60000} | ${{ cost: 0.0001, currency: 'BNB' }}                   | ${undefined}
      ${'leaves the rate of a trade without fee unknown'}                          | ${binanceMarket}          | ${1}   | ${60000} | ${undefined}                                           | ${undefined}
      ${'leaves the rate of a fee with neither cost nor currency unknown'}         | ${binanceMarket}          | ${1}   | ${60000} | ${{ cost: undefined, currency: undefined }}            | ${undefined}
      ${'leaves the rate of a fee without cost unknown'}                           | ${binanceMarket}          | ${1}   | ${60000} | ${{ currency: 'USDT' }}                                | ${undefined}
      ${'leaves the rate of a fee without currency unknown'}                       | ${binanceMarket}          | ${1}   | ${60000} | ${{ cost: 60 }}                                        | ${undefined}
    `('$description', ({ market, amount, price, fee, expected }) => {
      const trade: any = { id: '1', order: 'ord1', amount, price, timestamp, fee };
      expect(utils.mapCcxtTradeToTrade(trade, market, market.symbol).fee.rate).toBe(expected);
    });

    // In binary these came out at 0.06999999999999999 % for 0.07 %, 0.09999999999999999 % for 0.1 % and 0.03333333333333333 % for the
    // share with no end. The last two fees, rounded to 8 decimals by the exchange, are shares with no end too: worked out in binary, even
    // rounded to 15 significant digits, they came out a unit off the exact share in the 15th digit (0.0999999999903884, 0.06999966844051)
    it.each`
      description                                           | market               | amount     | price       | fee                                        | expected
      ${'a rate of 0.0007 given by ccxt'}                   | ${binanceMarket}     | ${1}       | ${60000}    | ${{ rate: 0.0007 }}                        | ${0.07}
      ${'a fee of 0.10001 USDT on 1 at 100.01'}             | ${binanceMarket}     | ${1}       | ${100.01}   | ${{ cost: 0.10001, currency: 'USDT' }}     | ${0.1}
      ${'a fee of 0.0007 USDC on 0.01 at 100'}              | ${hyperliquidMarket} | ${0.01}    | ${100}      | ${{ cost: 0.0007, currency: 'USDC' }}      | ${0.07}
      ${'a fee of 0.0049 BTC on 4.9'}                       | ${binanceMarket}     | ${4.9}     | ${60000}    | ${{ cost: 0.0049, currency: 'BTC' }}       | ${0.1}
      ${'a fee of 0.00483 UBTC on 6.9'}                     | ${hyperliquidMarket} | ${6.9}     | ${60000}    | ${{ cost: 0.00483, currency: 'UBTC' }}     | ${0.07}
      ${'a fee of 0.001 USDT on 3 at 1, with no end'}       | ${binanceMarket}     | ${3}       | ${1}        | ${{ cost: 0.001, currency: 'USDT' }}       | ${0.0333333333333333}
      ${'a fee of 33.29329435 USDT on 0.39967 at 83301.96'} | ${binanceMarket}     | ${0.39967} | ${83301.96} | ${{ cost: 33.29329435, currency: 'USDT' }} | ${0.0999999999903885}
      ${'a fee of 0.00084449 UBTC on 1.20642'}              | ${hyperliquidMarket} | ${1.20642} | ${60000}    | ${{ cost: 0.00084449, currency: 'UBTC' }}  | ${0.0699996684405099}
    `('gives the rate of $description as a decimal, $expected %', ({ market, amount, price, fee, expected }) => {
      const trade: any = { id: '1', order: 'ord1', amount, price, timestamp, fee };
      expect(utils.mapCcxtTradeToTrade(trade, market, market.symbol).fee.rate).toBe(expected);
    });
  });

  // ccxt 4.5.39 leaves the amount or the price of a trade undefined when the exchange gives none. Read as 0, an unknown price entered
  // the mean price of its order: fills of 0.5 at 100 and of 0.5 at an unknown price made a fill of 1 at 50.
  describe('isExecutedTrade', () => {
    it.each`
      description                     | amount        | price        | expected
      ${'an amount and a price'}      | ${0.5}        | ${100}       | ${true}
      ${'no amount'}                  | ${undefined}  | ${100}       | ${false}
      ${'no price'}                   | ${0.5}        | ${undefined} | ${false}
      ${'an amount of 0'}             | ${0}          | ${100}       | ${false}
      ${'a price of 0'}               | ${0.5}        | ${0}         | ${false}
      ${'a negative amount'}          | ${-0.5}       | ${100}       | ${false}
      ${'a negative price'}           | ${0.5}        | ${-100}      | ${false}
      ${'an amount that is NaN'}      | ${Number.NaN} | ${100}       | ${false}
      ${'a price that is not finite'} | ${0.5}        | ${Infinity}  | ${false}
    `('says a trade with $description executed: $expected', ({ amount, price, expected }) => {
      const trade: any = { id: '1', order: 'ord1', amount, price, timestamp: 1600000000000 };
      expect(utils.isExecutedTrade(trade)).toBe(expected);
    });
  });

  describe('mapCcxtOrderToOrder', () => {
    const now = 1704346500000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // Only a status that ends the order is final. Any other one, which ccxt passes on as the exchange wrote it (Binance's
    // PENDING_CANCEL as canceling, PENDING_NEW, Hyperliquid's acknowledgement of a cancelation as success), is not known to have
    // ended: open, not a fill
    it.each`
      status               | expected
      ${undefined}         | ${'open'}
      ${''}                | ${'open'}
      ${'open'}            | ${'open'}
      ${'closed'}          | ${'closed'}
      ${'canceled'}        | ${'canceled'}
      ${'rejected'}        | ${'canceled'}
      ${'expired'}         | ${'canceled'}
      ${'scheduledCancel'} | ${'canceled'}
      ${'canceling'}       | ${'open'}
      ${'PENDING_NEW'}     | ${'open'}
      ${'success'}         | ${'open'}
      ${'whatever'}        | ${'open'}
    `('maps the status $status to $expected', ({ status, expected }) => {
      const order: any = { id: '1', status, filled: 5, remaining: 5, price: 100, timestamp: 1000 };
      expect(utils.mapCcxtOrderToOrder(order)).toMatchObject({ status: expected });
    });

    it.each`
      status
      ${'canceling'}
      ${'success'}
      ${'whatever'}
    `('logs the unknown status $status at debug level', ({ status }) => {
      utils.mapCcxtOrderToOrder({ id: '1', status } as any);
      expect(logger.debug).toHaveBeenCalledWith('exchange', expect.stringContaining(status));
    });

    it.each`
      status
      ${undefined}
      ${'open'}
      ${'closed'}
      ${'expired'}
      ${'scheduledCancel'}
    `('does not log the status $status', ({ status }) => {
      utils.mapCcxtOrderToOrder({ id: '1', status } as any);
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it('maps the acknowledgement of a cancelation by Hyperliquid, an order without id, fill or date, to an open order dated now', () => {
      // What ccxt 4.5.39 returns for { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }
      const acknowledgement: any = { info: 'success', status: 'success', id: undefined, filled: undefined, remaining: undefined };
      expect(utils.mapCcxtOrderToOrder(acknowledgement)).toEqual({
        id: undefined,
        status: 'open',
        filled: undefined,
        remaining: undefined,
        price: undefined,
        timestamp: now,
      });
    });

    // ccxt 4.5.39 leaves the timestamp undefined when the exchange gives none, but createOrderSummary fetches the trades of the order
    // from it: undefined made that bound NaN, and logging it threw
    it.each`
      description                                                      | timestamp        | lastUpdateTimestamp | expected
      ${'keeps the timestamp given by the exchange'}                   | ${1704346468838} | ${1704346470000}    | ${1704346468838}
      ${'falls back on the last update of an order without timestamp'} | ${undefined}     | ${1704346470000}    | ${1704346470000}
      ${'falls back on now without timestamp or last update'}          | ${undefined}     | ${undefined}        | ${now}
      ${'falls back on now when neither date is a finite number'}      | ${Number.NaN}    | ${Infinity}         | ${now}
    `('$description', ({ timestamp, lastUpdateTimestamp, expected }) => {
      const order: any = { id: '1', status: 'open', amount: 2, filled: 0, remaining: 2, price: 100, timestamp, lastUpdateTimestamp };
      expect(utils.mapCcxtOrderToOrder(order).timestamp).toBe(expected);
    });

    // ccxt 4.5.39 leaves the fill or the remaining amount undefined when the exchange gives neither it nor what to derive it from
    it.each`
      description                                                         | amount       | filled        | remaining    | expected
      ${'keeps the fill and the remaining amount given'}                  | ${2}         | ${0.5}        | ${1.5}       | ${{ filled: 0.5, remaining: 1.5 }}
      ${'derives the fill from the amount and the remaining amount'}      | ${2}         | ${undefined}  | ${1.5}       | ${{ filled: 0.5, remaining: 1.5 }}
      ${'derives the remaining amount from the amount and the fill'}      | ${2}         | ${0.5}        | ${undefined} | ${{ filled: 0.5, remaining: 1.5 }}
      ${'derives the fill in decimal (0.8 - 0.1 is 0.7000000000000001)'}  | ${0.8}       | ${undefined}  | ${0.1}       | ${{ filled: 0.7, remaining: 0.1 }}
      ${'derives a fill of 0 from a remaining amount beyond the amount'}  | ${2}         | ${undefined}  | ${2.5}       | ${{ filled: 0, remaining: 2.5 }}
      ${'derives a remaining amount of 0 from a fill beyond the amount'}  | ${2}         | ${2.5}        | ${undefined} | ${{ filled: 2.5, remaining: 0 }}
      ${'derives the fill in place of one that is not a finite number'}   | ${2}         | ${Number.NaN} | ${1.5}       | ${{ filled: 0.5, remaining: 1.5 }}
      ${'derives nothing without the amount'}                             | ${undefined} | ${0.5}        | ${undefined} | ${{ filled: 0.5, remaining: undefined }}
      ${'derives nothing from neither the fill nor the remaining amount'} | ${2}         | ${undefined}  | ${undefined} | ${{ filled: undefined, remaining: undefined }}
    `('$description', ({ amount, filled, remaining, expected }) => {
      const order: any = { id: '1', status: 'open', amount, filled, remaining, price: 100, timestamp: 1704346468838 };
      expect(pick(utils.mapCcxtOrderToOrder(order), ['filled', 'remaining'])).toEqual(expected);
    });
  });

  describe('mapCcxtOrderToOpenOrder', () => {
    const now = 1704346500000;
    // As ccxt 4.5.39 parses the open orders of Binance (GET /api/v3/openOrders: side and type in lower case, the fill executedQty,
    // the remaining amount derived from it) and of Hyperliquid (frontendOpenOrders: the side read from A for ask, the amount origSz,
    // the remaining amount sz)
    const binanceLimitBuy: any = {
      id: '28457',
      symbol: 'BTC/USDT',
      status: 'open',
      type: 'limit',
      side: 'buy',
      price: 95,
      amount: 2,
      filled: 0.5,
      remaining: 1.5,
      timestamp: 1704346468838,
      lastUpdateTimestamp: 1704346470000,
      triggerPrice: undefined,
    };
    const hyperliquidLimitSell: any = {
      id: '3991946565',
      symbol: 'BTC/USDC',
      status: 'open',
      type: 'limit',
      side: 'sell',
      price: 105,
      amount: 0.1,
      filled: 0,
      remaining: 0.1,
      timestamp: 1704346468838,
      lastUpdateTimestamp: undefined,
      triggerPrice: undefined,
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each`
      description                                      | order                   | expected
      ${'maps a limit BUY of Binance, filled in part'} | ${binanceLimitBuy}      | ${{ id: '28457', side: 'BUY', type: 'LIMIT', price: 95, amount: 2, filled: 0.5, remaining: 1.5, timestamp: 1704346468838 }}
      ${'maps a limit SELL of Hyperliquid, untouched'} | ${hyperliquidLimitSell} | ${{ id: '3991946565', side: 'SELL', type: 'LIMIT', price: 105, amount: 0.1, filled: 0, remaining: 0.1, timestamp: 1704346468838 }}
    `('$description', ({ order, expected }) => {
      expect(utils.mapCcxtOrderToOpenOrder(order)).toEqual(expected);
    });

    it.each`
      side      | expected
      ${'buy'}  | ${'BUY'}
      ${'sell'} | ${'SELL'}
      ${'BUY'}  | ${'BUY'}
      ${'Sell'} | ${'SELL'}
    `('maps the side $side to $expected', ({ side, expected }) => {
      expect(utils.mapCcxtOrderToOpenOrder({ ...binanceLimitBuy, side }).side).toBe(expected);
    });

    // ccxt gives a conditional order the type it executes with once triggered, along with its trigger price: Hyperliquid's stop limit
    // and Binance's take_profit as limit, Hyperliquid's stop market as market. It leaves the types it does not unify as the exchange
    // wrote them.
    it.each`
      description                                                    | type                    | triggerPrice | expected
      ${'a limit order'}                                             | ${'limit'}              | ${undefined} | ${'LIMIT'}
      ${'a limit order whose type is written in upper case'}         | ${'LIMIT'}              | ${undefined} | ${'LIMIT'}
      ${'a limit order with a trigger price of 0, which sets none'}  | ${'limit'}              | ${0}         | ${'LIMIT'}
      ${'a market order'}                                            | ${'market'}             | ${undefined} | ${'MARKET'}
      ${'a conditional order typed limit, a stop limit'}             | ${'limit'}              | ${0.6}       | ${'OTHER'}
      ${'a conditional order typed market, a stop market'}           | ${'market'}             | ${90}        | ${'OTHER'}
      ${'a stop_loss_limit of Binance'}                              | ${'stop_loss_limit'}    | ${90}        | ${'OTHER'}
      ${'a take profit market of Hyperliquid'}                       | ${'take profit market'} | ${120}       | ${'OTHER'}
      ${'an order of a type ccxt does not unify, without a trigger'} | ${'iceberg'}            | ${undefined} | ${'OTHER'}
      ${'an order without a type'}                                   | ${undefined}            | ${undefined} | ${'OTHER'}
    `('maps $description to the type $expected', ({ type, triggerPrice, expected }) => {
      expect(utils.mapCcxtOrderToOpenOrder({ ...binanceLimitBuy, type, triggerPrice }).type).toBe(expected);
    });

    // Binance's stop_loss executes at the market once triggered: ccxt gives its price of "0.00000000" as undefined
    it('leaves the price of an order without one undefined', () => {
      const stopLoss = { ...binanceLimitBuy, type: 'stop_loss', price: undefined, triggerPrice: 90 };
      expect(utils.mapCcxtOrderToOpenOrder(stopLoss).price).toBeUndefined();
    });

    it.each`
      description                                                    | filled       | remaining    | expected
      ${'derives the remaining amount from the amount and the fill'} | ${0.5}       | ${undefined} | ${{ filled: 0.5, remaining: 1.5 }}
      ${'derives the fill from the amount and the remaining amount'} | ${undefined} | ${1.5}       | ${{ filled: 0.5, remaining: 1.5 }}
    `('$description', ({ filled, remaining, expected }) => {
      const order = utils.mapCcxtOrderToOpenOrder({ ...binanceLimitBuy, filled, remaining });
      expect(pick(order, ['filled', 'remaining'])).toEqual(expected);
    });

    it.each`
      description                                                               | timestamp        | lastUpdateTimestamp | expected
      ${'dates an order by its timestamp'}                                      | ${1704346468838} | ${1704346470000}    | ${1704346468838}
      ${'dates an order without timestamp by its last update'}                  | ${undefined}     | ${1704346470000}    | ${1704346470000}
      ${'dates an order without timestamp or last update now, when it is read'} | ${undefined}     | ${undefined}        | ${now}
    `('$description', ({ timestamp, lastUpdateTimestamp, expected }) => {
      expect(utils.mapCcxtOrderToOpenOrder({ ...binanceLimitBuy, timestamp, lastUpdateTimestamp }).timestamp).toBe(expected);
    });

    // Listed with made-up values, or left out, an order holding funds on the exchange would go unseen
    const quoted = (text: string) => `'${text}'`;
    it.each`
      description                                     | overrides                                      | problem
      ${'without a side'}                             | ${{ side: undefined }}                         | ${'no side Gekko knows (undefined)'}
      ${'of a side that is neither buy nor sell'}     | ${{ side: 'short' }}                           | ${`no side Gekko knows (${quoted('short')})`}
      ${'without an amount'}                          | ${{ amount: undefined }}                       | ${'no known amount (amount undefined, filled 0.5, remaining 1.5)'}
      ${'with neither a fill nor a remaining amount'} | ${{ filled: undefined, remaining: undefined }} | ${'no known amount (amount 2, filled undefined, remaining undefined)'}
    `('refuses an open order $description with a GekkoError naming it', ({ overrides, problem }) => {
      expect(() => utils.mapCcxtOrderToOpenOrder({ ...binanceLimitBuy, ...overrides })).toThrow(
        new GekkoError(
          'exchange',
          `Open order 28457 on BTC/USDT has ${problem}: the open orders of BTC/USDT cannot be listed, check it on the exchange`,
        ),
      );
    });
  });

  describe('mapOhlcvToCandles', () => {
    it('should map candles correctly', () => {
      const input: any[] = [[1000, 10, 15, 5, 12, 100]];
      expect(utils.mapOhlcvToCandles(input)).toEqual([
        {
          start: 1000,
          open: 10,
          high: 15,
          low: 5,
          close: 12,
          volume: 100,
        },
      ]);
    });

    it('should handle empty candle data', () => {
      const input: any[] = [[]];
      expect(utils.mapOhlcvToCandles(input)).toEqual([
        {
          start: 0,
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          volume: 0,
        },
      ]);
    });
  });

  describe('createExchange', () => {
    const baseConfig = {
      name: 'binance' as const,
      apiKey: 'k',
      secret: 's',
      verbose: false,
      sandbox: false,
      exchangeSynchInterval: 1,
      orderSynchInterval: 1,
    };
    // A throwaway key, valid for signing: the requests the tests make it sign are never sent
    const hyperliquidConfig = {
      ...baseConfig,
      name: 'hyperliquid' as const,
      privateKey: `0x${'11'.repeat(32)}`,
      walletAddress: `0x${'22'.repeat(20)}`,
    };

    it('should create default exchange', () => {
      const result = utils.createExchange(baseConfig);
      expect(result).toMatchObject({ publicClient: expect.any(Object), privateClient: expect.any(Object) });
    });

    it('should create hyperliquid exchange', () => {
      const result = utils.createExchange(hyperliquidConfig);
      expect(result).toMatchObject({ publicClient: expect.any(Object), privateClient: expect.any(Object) });
    });

    it.each`
      client             | option                   | expected
      ${'publicClient'}  | ${'builderFee'}          | ${false}
      ${'privateClient'} | ${'builderFee'}          | ${false}
      ${'publicClient'}  | ${'fetchMarkets.types'}  | ${['spot']}
      ${'privateClient'} | ${'fetchMarkets.types'}  | ${['spot']}
      ${'publicClient'}  | ${'maxRetriesOnFailure'} | ${0}
      ${'privateClient'} | ${'maxRetriesOnFailure'} | ${0}
    `('sets the $option option of the hyperliquid $client to $expected', ({ client, option, expected }) => {
      const clients = utils.createExchange(hyperliquidConfig);
      expect(clients[client as keyof typeof clients].options).toHaveProperty(option, expected);
    });

    // ccxt's hyperliquid charges a builder fee for ccxt's own address by default: before the first order or cancelation of a session
    // (initializeClient), it signs its approval with the user's wallet, then adds it to every order.
    describe('hyperliquid builder fee', () => {
      // A spot market as ccxt parses it from hyperliquid (the wrapped token UBTC, listed as BTC/USDC), enough to build an order request
      const market = {
        id: '@142',
        symbol: 'BTC/USDC',
        base: 'BTC',
        quote: 'USDC',
        baseId: '10142',
        baseName: 'UBTC',
        quoteId: 'USDC',
        type: 'spot',
        spot: true,
        contract: false,
        precision: { amount: 0.00001, price: 1 },
        limits: { cost: { min: 10 } },
      };
      let privateClient: hyperliquid;

      beforeEach(() => {
        privateClient = utils.createExchange(hyperliquidConfig).privateClient as hyperliquid;
        // The exchange endpoint, which the approval, the referrer and the orders are posted to, answered without any request
        vi.spyOn(privateClient, 'privatePostExchange').mockResolvedValue({ status: 'ok', response: { type: 'default' } });
      });

      it('skips the approval of the builder fee', async () => {
        expect(await privateClient.handleBuilderFeeApproval()).toBe(false);
      });

      it('posts no approval of the builder fee', async () => {
        await privateClient.handleBuilderFeeApproval();
        expect(privateClient.privatePostExchange).not.toHaveBeenCalled();
      });

      it('adds no builder fee to a sell order built once the client is initialised', async () => {
        privateClient.setMarkets([market]);
        await privateClient.initializeClient(); // as createOrders does before building its request
        const request = privateClient.createOrdersRequest([
          { symbol: 'BTC/USDC', type: 'limit', side: 'sell', amount: 0.001, price: 100000 },
        ]);
        expect(request.action).not.toHaveProperty('builder');
      });
    });

    // The price of an order as the hyperliquid client sends it, the rule PRICE_SIGNIFICANT_DIGITS states (MarketData.precision
    // .priceSignificantDigits): 5 significant digits, all those of a longer integer part, then at most 8 decimals less those of the amount
    describe('hyperliquid order prices', () => {
      // A spot market as ccxt parses it from hyperliquid at a mid price of 9990: a tick of 0.1 there (precision.price), amounts to 0.01
      const market = {
        id: '@1',
        symbol: 'TKN/USDC',
        base: 'TKN',
        quote: 'USDC',
        baseId: '10001',
        baseName: 'TKN',
        quoteId: 'USDC',
        type: 'spot',
        spot: true,
        contract: false,
        precision: { amount: 0.01, price: 0.1 },
        limits: { cost: { min: 10 } },
      };
      const significantDigits = PRICE_SIGNIFICANT_DIGITS.hyperliquid ?? NaN;
      let privateClient: hyperliquid;
      // The price of a limit BUY in the order request the client builds for it, as the exchange receives it
      const getSentPrice = (price: number) =>
        privateClient.createOrdersRequest([{ symbol: 'TKN/USDC', type: 'limit', side: 'buy', amount: 1, price }]).action.orders[0].p;

      beforeEach(() => {
        privateClient = utils.createExchange(hyperliquidConfig).privateClient as hyperliquid;
        privateClient.setMarkets([market]);
      });

      it('sends a price of PRICE_SIGNIFICANT_DIGITS.hyperliquid significant digits as it is', () => {
        const price = Number('1.23456789'.slice(0, significantDigits + 1));
        expect(getSentPrice(price)).toBe(String(price));
      });

      it('rounds off the significant digit after them', () => {
        const price = Number('1.23456789'.slice(0, significantDigits + 2));
        expect(getSentPrice(price)).not.toBe(String(price));
      });

      it.each`
        description                                                        | price          | sent
        ${'10001, of 5 significant digits, as it is'}                      | ${10001}       | ${'10001'}
        ${'10000.3 at 10000: whole units from 10000 on'}                   | ${10000.3}     | ${'10000'}
        ${'10000.4, a tick of precision.price above it, at 10000 as well'} | ${10000.4}     | ${'10000'}
        ${'10000.08 at 10000'}                                             | ${10000.08}    | ${'10000'}
        ${'10000.05 at 10000, its sixth digit a 0'}                        | ${10000.05}    | ${'10000'}
        ${'10000.5 at 10001, a tie rounded up'}                            | ${10000.5}     | ${'10001'}
        ${'10000.6 at 10001'}                                              | ${10000.6}     | ${'10001'}
        ${'9999.95 at 10000, rounded up to the next power of ten'}         | ${9999.95}     | ${'10000'}
        ${'9999.94 at 9999.9, the tick of precision.price under 10000'}    | ${9999.94}     | ${'9999.9'}
        ${'99.9995 at 100, rounded up to the next power of ten'}           | ${99.9995}     | ${'100'}
        ${'123456.7 at 123457, a longer integer part kept whole'}          | ${123456.7}    | ${'123457'}
        ${'0.12345678 at 0.12346, 5 significant digits under 1'}           | ${0.12345678}  | ${'0.12346'}
        ${'0.000123456 at 0.000123, 8 decimals less the 2 of the amount'}  | ${0.000123456} | ${'0.000123'}
      `('sends $description', ({ price, sent }) => {
        expect(getSentPrice(price)).toBe(sent);
      });
    });

    // The tick ccxt states for a hyperliquid market (precision.price) is the one at its mid price when the markets load
    // (calculatePricePrecision), finer than the exchange's above the next power of ten: hence MarketData.precision.priceSignificantDigits
    describe('hyperliquid spot markets', () => {
      // spotMetaAndAssetCtxs, as hyperliquid answers it for one market, of the token TKN quoted in USDC
      const spotMetaAndAssetCtxs = (midPx: string, szDecimals: number) => [
        {
          tokens: [
            { name: 'USDC', szDecimals: 8, weiDecimals: 8, index: 0, tokenId: '0x6d1e7cde53ba9467b783cb7c530ce054', isCanonical: true },
            { name: 'TKN', szDecimals, weiDecimals: 8, index: 1, tokenId: '0xc1fb593aeffbeb02f85e0308e9956a90', isCanonical: true },
          ],
          universe: [{ name: 'TKN/USDC', tokens: [1, 0], index: 0, isCanonical: true }],
        },
        [{ dayNtlVlm: '8906.0', markPx: midPx, midPx, prevDayPx: midPx }],
      ];

      it.each`
        midPx        | szDecimals | tick
        ${'61235.5'} | ${5}       | ${1}
        ${'9990'}    | ${2}       | ${0.1}
        ${'99.5'}    | ${2}       | ${0.001}
      `('gives a market loaded at a mid price of $midPx its tick there, $tick, as precision.price', async ({ midPx, szDecimals, tick }) => {
        const publicClient = utils.createExchange(hyperliquidConfig).publicClient as hyperliquid;
        // The info endpoint, answered without any request
        vi.spyOn(publicClient, 'publicPostInfo').mockResolvedValue(spotMetaAndAssetCtxs(midPx, szDecimals));
        const [market] = await publicClient.fetchSpotMarkets();
        expect(market?.precision.price).toBe(tick);
      });
    });

    it.each`
      proxy              | agentType
      ${'http://proxy'}  | ${HttpsProxyAgent}
      ${'socks://proxy'} | ${SocksProxyAgent}
    `('should use $agentType for $proxy', ({ proxy, agentType }) => {
      const result = utils.createExchange({ ...baseConfig, proxy });
      expect(result.publicClient.agent).toBeInstanceOf(agentType);
    });

    it('should not assign agent if proxy format is unknown', () => {
      const result = utils.createExchange({ ...baseConfig, proxy: 'tcp://proxy' });
      expect(result.publicClient.agent).toBeUndefined();
    });

    it('should configure sandbox', () => {
      const result = utils.createExchange({ ...baseConfig, sandbox: true });
      expect(result.publicClient).toHaveProperty('sandbox', true);
    });

    it.each`
      client
      ${'publicClient'}
      ${'privateClient'}
    `('turns off the quoteOrderQty option of the binance $client', ({ client }) => {
      const clients = utils.createExchange(baseConfig);
      expect(clients[client as keyof typeof clients].options).toHaveProperty('quoteOrderQty', false);
    });

    // CCXTExchange.createMarketOrder sends the ticker price along with a market order. With quoteOrderQty on (ccxt's default),
    // binance would send an amount of quote currency, amount × price, instead of the amount asked.
    describe('binance market order sent with a price', () => {
      // A spot market as ccxt parses it from binance, enough to build an order request without loading the markets
      const market = {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        baseId: 'BTC',
        quoteId: 'USDT',
        type: 'spot',
        spot: true,
        contract: false,
        precision: { amount: 0.00001, price: 0.01 },
        limits: { amount: { min: 0.00001, max: 9000 }, price: { min: 0.01, max: 1000000 }, cost: { min: 5 } },
        info: { orderTypes: ['LIMIT', 'LIMIT_MAKER', 'MARKET'] },
      };
      let request: Record<string, unknown>;

      beforeEach(() => {
        const privateClient = utils.createExchange(baseConfig).privateClient as binance;
        privateClient.setMarkets([market]);
        request = privateClient.createOrderRequest('BTC/USDT', 'market', 'SELL', 0.5, 60000);
      });

      it('sends the amount as the quantity', () => {
        expect(request).toHaveProperty('quantity', '0.5');
      });

      it.each`
        field
        ${'quoteOrderQty'}
        ${'price'}
      `('sends no $field', ({ field }) => {
        expect(request).not.toHaveProperty(field);
      });
    });
  });

  describe('checkMandatoryFeatures', () => {
    const baseExchange: any = {
      name: 'ex',
      has: {
        cancelOrder: true,
        createLimitOrder: true,
        createMarketOrder: true,
        fetchBalance: true,
        fetchMyTrades: true,
        fetchOHLCV: true,
        fetchOpenOrders: true,
        fetchOrder: true,
        fetchTicker: true,
        fetchTickers: true,
      },
    };

    it('should pass given valid features', () => {
      expect(() => utils.checkMandatoryFeatures(baseExchange, false)).not.toThrow();
    });

    // fetchOpenOrders: CCXTExchange.fetchOpenOrders reads the open orders of a pair through it
    it.each`
      feature
      ${'fetchOHLCV'}
      ${'fetchOpenOrders'}
    `('should throw on missing $feature', ({ feature }) => {
      const ex = { ...baseExchange, has: { ...baseExchange.has, [feature]: false } };
      expect(() => utils.checkMandatoryFeatures(ex, false)).toThrow(`Missing ${feature} feature in ex exchange`);
    });

    it('should throw on missing sandbox if requested', () => {
      const ex = { ...baseExchange, has: { ...baseExchange.has, sandbox: false } };
      expect(() => utils.checkMandatoryFeatures(ex, true)).toThrow(/Missing sandbox/);
    });

    it('should ignore sandbox missing if not requested', () => {
      const ex = { ...baseExchange, has: { ...baseExchange.has, sandbox: false } };
      expect(() => utils.checkMandatoryFeatures(ex, false)).not.toThrow();
    });
  });

  describe('isDummyExchange', () => {
    const dummy = { getExchangeName: () => 'dummy-ex', processOneMinuteBucket: () => {} };
    const paper = { getExchangeName: () => 'paper-ex', processOneMinuteBucket: () => {} };
    const real = { getExchangeName: () => 'real-ex', processOneMinuteBucket: () => {} };

    it.each`
      exchange     | expected | desc
      ${dummy}     | ${true}  | ${'dummy exchange'}
      ${paper}     | ${true}  | ${'paper exchange'}
      ${real}      | ${false} | ${'real exchange'}
      ${{}}        | ${false} | ${'empty object'}
      ${null}      | ${false} | ${'null'}
      ${undefined} | ${false} | ${'undefined'}
      ${123}       | ${false} | ${'number'}
    `('should return $expected for $desc', ({ exchange, expected }) => {
      expect(utils.isDummyExchange(exchange)).toBe(expected);
    });

    it('should return false if missing processOneMinuteBucket', () => {
      expect(utils.isDummyExchange({ getExchangeName: () => 'dummy' })).toBe(false);
    });
  });
});
