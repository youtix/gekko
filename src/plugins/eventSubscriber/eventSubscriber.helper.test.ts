import { ONE_MINUTE, ONE_SECOND } from '@constants/time.const';
import { BalanceDetail } from '@models/portfolio.types';
import { TradingPair } from '@models/utility.types';
import { toTimestamp } from '@utils/date/date.utils';
import { describe, expect, it } from 'vitest';
import { describePortfolioAnswer } from './eventSubscriber.helper';
import { PortfolioAnswerParams } from './eventSubscriber.types';

describe('describePortfolioAnswer', () => {
  const receivedAt = toTimestamp('2024-01-01T12:00:02Z');
  const portfolio = new Map<string, BalanceDetail>([
    ['BTC', { free: 0.4, used: 0.1, total: 0.5 }],
    ['ETH', { free: 0, used: 0, total: 0 }],
    ['USDT', { free: 1000, used: 0, total: 1000 }],
  ]);
  const prices = new Map<TradingPair, number>([
    ['BTC/USDT', 110],
    ['ETH/USDT', 2200],
  ]);
  /** The answer for a portfolio received at 12:00:02 and the closes of the bucket of 12:02, asked 3 minutes 12 seconds later */
  const answer = (overrides: Partial<PortfolioAnswerParams> = {}) =>
    describePortfolioAnswer({
      portfolio,
      portfolioAt: receivedAt,
      prices,
      pricesAt: toTimestamp('2024-01-01T12:03:00Z'),
      pairs: ['BTC/USDT', 'ETH/USDT'],
      assets: ['BTC', 'ETH'],
      currency: 'USDT',
      now: receivedAt + 192 * ONE_SECOND,
      ...overrides,
    });

  const BALANCE_LINES = [
    'Balances read by the Trader, received at 2024-01-01T12:00:02.000Z (3 minutes 12 seconds ago)',
    'BTC: 0.5 (free 0.4, used 0.1)',
    'ETH: 0 (free 0, used 0)',
    'USDT: 1,000 (free 1,000, used 0)',
  ];
  const PRICE_LINES = ['Prices at the close of 2024-01-01T12:03:00.000Z', 'BTC/USDT: 110 USDT', 'ETH/USDT: 2,200 USDT'];
  const NO_BALANCE = 'No balance received from the Trader yet (no Trader configured, or its first read still on its way)';
  const NO_PRICE = 'No price yet: no 1-minute candle has been processed';
  const NOTHING_RECEIVED = { portfolio: undefined, portfolioAt: undefined };
  const NOTHING_PROCESSED = { prices: new Map(), pricesAt: undefined };

  // The total value: the 1,000 USDT, plus the 0.5 BTC, 0.1 of it reserved by an open order, at 110 (55), plus the 0 ETH at 2,200
  it.each`
    held                                            | overrides                                        | lines
    ${'a portfolio and the closes of a bucket'}     | ${{}}                                            | ${[...BALANCE_LINES, ...PRICE_LINES, 'Total value: 1,055 USDT']}
    ${'a portfolio, no bucket processed yet'}       | ${NOTHING_PROCESSED}                             | ${[...BALANCE_LINES, NO_PRICE]}
    ${'the closes of a bucket, no portfolio yet'}   | ${NOTHING_RECEIVED}                              | ${[NO_BALANCE, ...PRICE_LINES]}
    ${'neither a portfolio nor a bucket processed'} | ${{ ...NOTHING_RECEIVED, ...NOTHING_PROCESSED }} | ${[NO_BALANCE, NO_PRICE]}
  `('answers with $held', ({ overrides, lines }) => {
    expect(answer(overrides)).toBe(lines.join('\n'));
  });

  // Telegram shows when the message was sent, not when its figures were read
  it.each`
    asked                                         | now                             | line
    ${'at the reception'}                         | ${receivedAt}                   | ${'Balances read by the Trader, received at 2024-01-01T12:00:02.000Z (just now)'}
    ${'within the second of the reception'}       | ${receivedAt + 999}             | ${'Balances read by the Trader, received at 2024-01-01T12:00:02.000Z (just now)'}
    ${'a second after the reception'}             | ${receivedAt + ONE_SECOND}      | ${'Balances read by the Trader, received at 2024-01-01T12:00:02.000Z (1 second ago)'}
    ${'an hour and a minute after the reception'} | ${receivedAt + 61 * ONE_MINUTE} | ${'Balances read by the Trader, received at 2024-01-01T12:00:02.000Z (1 hour 1 minute ago)'}
    ${'on a clock set back since the reception'}  | ${receivedAt - 5 * ONE_SECOND}  | ${'Balances read by the Trader, received at 2024-01-01T12:00:02.000Z (just now)'}
  `('dates the balances with their age when asked $asked: "$line"', ({ now, line }) => {
    expect(answer({ now }).split('\n')[0]).toBe(line);
  });

  // The balance of each watched asset, in the order of watch.assets, then the currency's, once
  it.each`
    watched                            | assets             | pairs                        | listed
    ${'ETH before BTC'}                | ${['ETH', 'BTC']}  | ${['ETH/USDT', 'BTC/USDT']}  | ${['ETH', 'BTC', 'USDT']}
    ${'the currency among the assets'} | ${['BTC', 'USDT']} | ${['BTC/USDT', 'USDT/USDT']} | ${['BTC', 'USDT']}
  `('lists the balances of $listed with $watched watched', ({ assets, pairs, listed }) => {
    const lines = answer({ assets, pairs }).split('\n');
    const pricesLine = lines.findIndex(line => line.startsWith('Prices at the close'));
    expect(lines.slice(1, pricesLine).map(line => line.split(':')[0])).toEqual(listed);
  });

  it('writes 0 for a watched asset the portfolio lacks', () => {
    const withoutEth = new Map([...portfolio].filter(([asset]) => asset !== 'ETH'));
    expect(answer({ portfolio: withoutEth }).split('\n')).toContain('ETH: 0 (free 0, used 0)');
  });

  // The total value: the 1,000 USDT, plus the 0.5 BTC at 110 (55): the 2 ETH, without a close, add nothing
  it('leaves a pair without a close out of the prices and of the total value', () => {
    const holdingEth = new Map([...portfolio, ['ETH', { free: 2, used: 0, total: 2 }]]);
    expect(answer({ portfolio: holdingEth, prices: new Map([['BTC/USDT', 110]]) })).toBe(
      [
        BALANCE_LINES[0],
        'BTC: 0.5 (free 0.4, used 0.1)',
        'ETH: 2 (free 2, used 0)',
        'USDT: 1,000 (free 1,000, used 0)',
        'Prices at the close of 2024-01-01T12:03:00.000Z',
        'BTC/USDT: 110 USDT',
        'Total value: 1,055 USDT',
      ].join('\n'),
    );
  });
});
