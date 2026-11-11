import { describe, expect, it } from 'vitest';
import { supervisionSchema } from './supervision.schema';

const entry = { name: 'Supervision', token: 'token', botUsername: 'gekko_bot' };
const defaults = {
  cpuThreshold: 80,
  memoryThreshold: 1024,
  cpuCheckInterval: 10_000,
  memoryCheckInterval: 10_000,
  logMonitoringInterval: 60_000,
  candleCheckInterval: 60_000,
  candleStaleThreshold: 180_000,
};
const custom = {
  cpuThreshold: 90,
  memoryThreshold: 2048,
  cpuCheckInterval: 5000,
  memoryCheckInterval: 15_000,
  logMonitoringInterval: 30_000,
  candleCheckInterval: 30_000,
  candleStaleThreshold: 300_000,
};

const intervalMessage = (field: string) => `${field} must be an integer number of milliseconds between 1000 and 2147483647`;

const staleThresholdMessage =
  'candleStaleThreshold must be an integer number of milliseconds above 60000: the 1-minute candles come once a minute';

describe('supervisionSchema', () => {
  it.each`
    scenario                                     | options   | expected
    ${'the required options, with the defaults'} | ${{}}     | ${{ ...entry, ...defaults }}
    ${'every option'}                            | ${custom} | ${{ ...entry, ...custom }}
  `('accepts $scenario', ({ options, expected }) => {
    expect(supervisionSchema.parse({ ...entry, ...options })).toEqual(expected);
  });

  // The one chat the bot talks to: a private chat has a positive id, a group a negative one
  it.each`
    scenario            | chatId
    ${'a private chat'} | ${123456789}
    ${'a group'}        | ${-123456789}
    ${'a supergroup'}   | ${-1001234567890}
  `('accepts the chat id of $scenario', ({ chatId }) => {
    expect(supervisionSchema.parse({ ...entry, chatId }).chatId).toBe(chatId);
  });

  // No update would match such a chat id, so the bot would ignore every command: it stops Gekko at start-up instead
  it.each`
    scenario                       | chatId
    ${'a chat id given as a text'} | ${'123456789'}
    ${'a fraction'}                | ${1.5}
    ${'an empty value'}            | ${null}
    ${'0, the id of no chat'}      | ${0}
  `('refuses $scenario as chatId', ({ chatId }) => {
    expect(supervisionSchema.safeParse({ ...entry, chatId }).error?.issues).toMatchObject([{ path: ['chatId'] }]);
  });

  it('says why it refuses 0 as chatId', () => {
    expect(supervisionSchema.safeParse({ ...entry, chatId: 0 }).error?.issues[0].message).toBe(
      'chatId cannot be 0, the id of no Telegram chat: a private chat has a positive id, a group a negative one',
    );
  });

  // A stripped option would leave its default in place: cpuTreshold: 50 would keep the CPU alert at 80 %
  it.each`
    scenario                                    | options                     | keys
    ${'a misspelt option (cpuTreshold)'}        | ${{ cpuTreshold: 50 }}      | ${['cpuTreshold']}
    ${'an option of the TradingAdvisor plugin'} | ${{ strategyName: 'DEMA' }} | ${['strategyName']}
  `('refuses $scenario', ({ options, keys }) => {
    expect(supervisionSchema.safeParse({ ...entry, ...options }).error?.issues).toMatchObject([
      { code: 'unrecognized_keys', keys, path: [] },
    ]);
  });

  // Each period is handed to setInterval: a delay of a few milliseconds would run the check nonstop, and one past 2^31 - 1 ms
  // overflows to 1 ms
  describe.each`
    field
    ${'cpuCheckInterval'}
    ${'memoryCheckInterval'}
    ${'logMonitoringInterval'}
    ${'candleCheckInterval'}
  `('$field', ({ field }) => {
    it.each`
      scenario                                       | value
      ${'0'}                                         | ${0}
      ${'a negative delay'}                          | ${-1}
      ${'1 ms'}                                      | ${1}
      ${'a fraction of a millisecond'}               | ${0.5}
      ${'a fractional delay above one second'}       | ${1000.5}
      ${'a delay below one second'}                  | ${999}
      ${'2^31 ms, one past the longest timer delay'} | ${2_147_483_648}
      ${'Infinity'}                                  | ${Infinity}
      ${'NaN'}                                       | ${NaN}
      ${'a number given as a string'}                | ${'10000'}
    `('rejects $scenario', ({ value }) => {
      const result = supervisionSchema.safeParse({ ...entry, [field]: value });
      expect(result.error?.issues).toMatchObject([{ path: [field], message: intervalMessage(field) }]);
    });

    it.each`
      scenario                      | value
      ${'one second, the shortest'} | ${1000}
      ${'2^31 - 1 ms, the longest'} | ${2_147_483_647}
    `('accepts $scenario', ({ value }) => {
      const result = supervisionSchema.parse({ ...entry, [field]: value });
      expect(result[field as keyof typeof defaults]).toBe(value);
    });
  });

  // A bucket comes once a minute: with a threshold of a minute or less, the candles would be reported as stopped, then as coming
  // again, between every two of them
  describe('candleStaleThreshold', () => {
    it.each`
      scenario                               | value
      ${'0'}                                 | ${0}
      ${'a negative age'}                    | ${-1}
      ${'one minute'}                        | ${60_000}
      ${'less than a minute'}                | ${30_000}
      ${'a fractional age above one minute'} | ${90_000.5}
      ${'Infinity'}                          | ${Infinity}
      ${'NaN'}                               | ${NaN}
      ${'a number given as a string'}        | ${'180000'}
    `('rejects $scenario', ({ value }) => {
      const result = supervisionSchema.safeParse({ ...entry, candleStaleThreshold: value });
      expect(result.error?.issues).toMatchObject([{ path: ['candleStaleThreshold'], message: staleThresholdMessage }]);
    });

    it.each`
      scenario                         | value
      ${'a millisecond over a minute'} | ${60_001}
      ${'a day'}                       | ${86_400_000}
    `('accepts $scenario', ({ value }) => {
      expect(supervisionSchema.parse({ ...entry, candleStaleThreshold: value }).candleStaleThreshold).toBe(value);
    });
  });
});
