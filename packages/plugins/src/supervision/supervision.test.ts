import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { Candle } from '@gekko/shared/models/candle.types';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { LogLevel } from '@gekko/shared/models/logLevel.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { Timeframe, Watch } from '@gekko/schemas/configuration/configuration.types';
import { TelegramBot } from '@gekko/core/bots/telegram/TelegramBot';
import { createPluginContext } from '@gekko/core/plugin/plugin.mock';
import { debug, getBufferedLogs, warning } from '@gekko/core/logger/logger';
import { BufferedLog } from '@gekko/shared/models/log.types';
import { noop } from 'lodash-es';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Supervision } from './supervision';
import { supervisionSchema } from '@gekko/schemas/plugins/supervision.schema';
import { SUBSCRIPTION_NAMES, SupervisionConfig } from './supervision.types';

vi.mock('@gekko/core/logger/logger', () => ({ debug: vi.fn(), warning: vi.fn(), getBufferedLogs: vi.fn(() => []) }));
// Only records how the plugin builds its bot: each test then puts fakeBot in its place
vi.mock('@gekko/core/bots/telegram/TelegramBot', () => ({ TelegramBot: vi.fn(function () {}) }));
// A realtime run on BTC/USDT, as the configuration's watch section gives it
const WATCH: Partial<Watch> = { pairs: [{ symbol: 'BTC/USDT' }], mode: 'realtime', warmup: { candleCount: 0, tickrate: 1000 } };

describe('Supervision', () => {
  let plugin: Supervision;
  const fakeBot = { sendMessage: vi.fn(), listen: vi.fn(), close: vi.fn() };
  const baseConfig = {
    name: 'Supervision',
    token: 't',
    botUsername: 'bot-name',
    chatId: 1,
    cpuThreshold: 50,
    memoryThreshold: 50,
    cpuCheckInterval: 100,
    memoryCheckInterval: 100,
    logMonitoringInterval: 100,
    candleCheckInterval: 100,
    candleStaleThreshold: 300,
  };
  /** The plugin built with these options, in a run watching `watch` */
  const createSupervision = (options: SupervisionConfig = baseConfig, watch = WATCH) =>
    new Supervision(options, createPluginContext({ watch }));

  beforeEach(() => {
    vi.useFakeTimers();
    plugin = createSupervision();
    plugin['bot'] = fakeBot as any;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The bot handles the commands of that chat only and sends the alerts there; without it, it takes the first chat to send a command
  it.each`
    scenario                  | chatId
    ${'a configured chat id'} | ${-1001234567890}
    ${'no chat id'}           | ${undefined}
  `('builds its bot with $scenario', ({ chatId }) => {
    createSupervision({ ...baseConfig, chatId });
    expect(TelegramBot).toHaveBeenLastCalledWith('t', 'bot-name', expect.any(Function), chatId);
  });

  it('should start bot listening for processInit', () => {
    plugin['processInit']();
    expect(fakeBot.listen).toHaveBeenCalled();
  });

  it('should return running status for handleCommand /healthcheck ', () => {
    const res = plugin['handleCommand']('/healthcheck');
    expect(res).toBe('✅ Gekko is running');
  });

  it('should send alert when CPU usage exceeds threshold', async () => {
    plugin['getCpuUsage'] = vi.fn().mockReturnValue(60);
    plugin['handleCommand']('/sub_cpu_check');
    await vi.advanceTimersByTimeAsync(100);
    expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('⚠️ CPU usage exceeded'));
  });

  it('should stop CPU monitoring on unsubscribe', () => {
    plugin['handleCommand']('/sub_cpu_check');
    plugin['handleCommand']('/sub_cpu_check');
    expect(plugin['cpuInterval']).toBeUndefined();
  });

  it('should send alert when Memory usage exceeds threshold', async () => {
    plugin['getMemoryUsage'] = vi.fn().mockReturnValue(100);
    plugin['handleCommand']('/sub_memory_check');
    await vi.advanceTimersByTimeAsync(100);
    expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('⚠️ Memory usage exceeded'));
  });

  it('should stop Memory monitoring on unsubscribe', () => {
    plugin['handleCommand']('/sub_memory_check');
    plugin['handleCommand']('/sub_memory_check');
    expect(plugin['memoryInterval']).toBeUndefined();
  });

  describe('CPU sampling', () => {
    /** The CPU time the process has used since it started, in microseconds, as process.cpuUsage counts it */
    let cpuTime: number;
    /** Lets `ms` go by with the process using `percent` % of a CPU */
    const run = (ms: number, percent: number) => {
      cpuTime += ms * 10 * percent; // ms × 1000 µs × percent / 100
      return vi.advanceTimersByTimeAsync(ms);
    };
    const toggleSubscription = () => plugin['handleCommand']('/sub_cpu_check');
    /** One sample under the threshold, then an unsubscription */
    const sampleOnce = async () => {
      toggleSubscription();
      await run(100, 5);
      toggleSubscription();
    };

    beforeEach(() => {
      cpuTime = 0;
      vi.spyOn(process, 'cpuUsage').mockImplementation(previous => ({ user: cpuTime - (previous?.user ?? 0), system: 0 }));
      // Built once the counter is stubbed, as the plugin is once the process has started
      plugin = createSupervision();
      plugin['bot'] = fakeBot as any;
    });

    afterEach(() => {
      vi.restoreAllMocks(); // The process.cpuUsage spy
    });

    it.each`
      subscription                          | before
      ${'subscribing, long after start-up'} | ${noop}
      ${'subscribing again'}                | ${sampleOnce}
    `('measures the first sample after $subscription over its interval only', async ({ before }) => {
      await before();
      await run(9_900, 5); // A long quiet time, unsubscribed: since start-up or since the last sample
      toggleSubscription();
      await run(100, 100); // Then a spike, over the first interval
      expect(fakeBot.sendMessage.mock.calls).toEqual([['⚠️ CPU usage exceeded: 100.00%']]);
    });
  });

  describe.each`
    check       | command                | sampler
    ${'CPU'}    | ${'/sub_cpu_check'}    | ${'getCpuUsage'}
    ${'Memory'} | ${'/sub_memory_check'} | ${'getMemoryUsage'}
  `('$check alerts', ({ check, command, sampler }) => {
    /** Samples a usage over both thresholds at every check */
    const sample = vi.fn(() => 100);
    const checkUsage = (times = 1) => vi.advanceTimersByTimeAsync(times * 100);

    beforeEach(() => {
      plugin[sampler as 'getCpuUsage' | 'getMemoryUsage'] = sample;
      plugin['handleCommand'](command);
    });

    it('sends one at every check', async () => {
      await checkUsage(2);
      expect(fakeBot.sendMessage).toHaveBeenCalledTimes(2);
    });

    // A value without a prototype, which String() (and so a template literal) throws for, is described as inspect() does, and a string
    // as it is, which inspect() quoted
    describe.each`
      failure                          | rejection                        | reason
      ${'an error'}                    | ${new Error('Telegram is down')} | ${'Telegram is down'}
      ${'a value without a prototype'} | ${Object.create(null)}           | ${'[Object: null prototype] {}'}
      ${'a string'}                    | ${'socket hang up'}              | ${'socket hang up'}
    `('when Telegram fails to take one with $failure', ({ rejection, reason }) => {
      beforeEach(async () => {
        fakeBot.sendMessage.mockRejectedValueOnce(rejection);
        await checkUsage();
      });

      it('logs the failure as a warning', () => {
        expect(warning).toHaveBeenCalledWith('supervision', `${check} alert not sent: ${reason}`);
      });

      it('sends the next one at the next check', async () => {
        await checkUsage();
        expect(fakeBot.sendMessage).toHaveBeenCalledTimes(2);
      });
    });

    describe('while one is in flight', () => {
      beforeEach(async () => {
        fakeBot.sendMessage.mockReturnValueOnce(new Promise(() => {})); // Telegram does not answer
        await checkUsage(3);
      });

      it('sends no other one', () => {
        expect(fakeBot.sendMessage).toHaveBeenCalledTimes(1);
      });

      it('logs the ones it skips at debug level', () => {
        expect(debug).toHaveBeenCalledWith('supervision', `${check} alert skipped: the previous one is still in flight`);
      });

      it('still samples at every check', () => {
        expect(sample).toHaveBeenCalledTimes(3);
      });
    });
  });

  it.each`
    check       | command                | sampler
    ${'CPU'}    | ${'/sub_cpu_check'}    | ${'getCpuUsage'}
    ${'Memory'} | ${'/sub_memory_check'} | ${'getMemoryUsage'}
  `('sends no $check alert while the usage is under its threshold', async ({ command, sampler }) => {
    plugin[sampler as 'getCpuUsage' | 'getMemoryUsage'] = vi.fn(() => 10); // Both thresholds are 50
    plugin['handleCommand'](command);
    await vi.advanceTimersByTimeAsync(300);
    expect(fakeBot.sendMessage).not.toHaveBeenCalled();
  });

  it('measures the memory usage as the resident set size, in MB', () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 3 * 1024 * 1024 } as NodeJS.MemoryUsage);
    expect(plugin['getMemoryUsage']()).toBe(3);
  });

  describe('timeframe candle check', () => {
    /** Monday 1 January 2024 at midnight UTC: a candle of every timeframe starts then */
    const start = Date.UTC(2024, 0, 1);
    /** The timeframe candle Gekko built, of every pair */
    const gekkoCandle: Candle = { start, open: 1, high: 3, low: 1, close: 2, volume: 10 };
    /** The minutes Gekko batched into it as a 2m candle */
    const minutes: Candle[] = [
      { start, open: 1, high: 2, low: 1, close: 1.5, volume: 4 },
      { start: start + ONE_MINUTE, open: 1.5, high: 3, low: 1.2, close: 2, volume: 6 },
    ];
    const fetchOHLCV = vi.fn();
    const bucket = (...symbols: TradingPair[]): CandleBucket => new Map(symbols.map(symbol => [symbol, gekkoCandle]));
    /** Hands the plugin a bucket of timeframe candles, then lets the check it starts in the background run to its end */
    const check = async (candles: CandleBucket) => {
      plugin.onTimeframeCandle([candles]);
      await vi.advanceTimersByTimeAsync(0);
    };
    /** The message reporting a mismatch of the candle starting at `start` */
    const mismatch = (symbol: TradingPair, timeframe: string, ...fields: string[]) =>
      [
        `⚠️ Timeframe candle mismatch detected: ${symbol} ${timeframe} candle starting at 2024-01-01T00:00:00.000Z (exchange | Gekko)`,
        ...fields,
      ].join('\n');
    /** A plugin watching the timeframe on the exchange, subscribed to the check */
    const setUp = (timeframe: string, exchangeName = 'binance') => {
      plugin = createSupervision(baseConfig, { ...WATCH, pairs: [], timeframe: timeframe as Timeframe });
      plugin['bot'] = fakeBot as any;
      plugin.setExchange({ getExchangeName: () => exchangeName, fetchOHLCV } as any);
      plugin['handleCommand']('/sub_candle_check');
    };

    beforeEach(() => {
      fetchOHLCV.mockResolvedValue([]);
    });

    it.each`
      exchangeName       | timeframe
      ${'binance'}       | ${'1h'}
      ${'binance'}       | ${'1M'}
      ${'paper-binance'} | ${'6h'}
      ${'hyperliquid'}   | ${'1w'}
    `('fetches the $timeframe candle, which $exchangeName serves', async ({ exchangeName, timeframe }) => {
      setUp(timeframe, exchangeName);
      await check(bucket('BTC/USDT'));
      expect(fetchOHLCV).toHaveBeenCalledWith('BTC/USDT', { from: start, timeframe, limit: 1 });
    });

    it.each`
      exchangeName     | timeframe | minuteCount
      ${'binance'}     | ${'2m'}   | ${2}
      ${'binance'}     | ${'10m'}  | ${10}
      ${'hyperliquid'} | ${'6h'}   | ${360}
      ${'dummy-cex'}   | ${'1d'}   | ${1440}
    `(
      'fetches the $minuteCount minutes of the $timeframe candle, which $exchangeName does not serve',
      async ({ exchangeName, timeframe, minuteCount }) => {
        setUp(timeframe, exchangeName);
        await check(bucket('BTC/USDT'));
        expect(fetchOHLCV).toHaveBeenCalledWith('BTC/USDT', { from: start, timeframe: '1m', limit: minuteCount });
      },
    );

    it.each`
      exchangeName     | timeframe
      ${'binance'}     | ${'3M'}
      ${'binance'}     | ${'1y'}
      ${'hyperliquid'} | ${'6M'}
    `(
      'fetches nothing for the $timeframe candle, which $exchangeName does not serve and spans too many minutes',
      async ({ exchangeName, timeframe }) => {
        setUp(timeframe, exchangeName);
        await check(bucket('BTC/USDT'));
        expect(fetchOHLCV).not.toHaveBeenCalled();
      },
    );

    it('says once per run why it does not check a timeframe', async () => {
      setUp('3M');
      await check(bucket('BTC/USDT', 'ETH/USDT'));
      await check(bucket('BTC/USDT', 'ETH/USDT'));
      expect(vi.mocked(warning).mock.calls).toEqual([
        [
          'supervision',
          'Timeframe candles not checked: binance serves no 3M candles, and one request returns 1000 1-minute candles at most, fewer than a 3M candle spans',
        ],
      ]);
    });

    it.each`
      description                                                        | answer                                                           | expected
      ${'the fields that differ, exchange first'}                        | ${[{ ...gekkoCandle, open: 2, volume: 11 }]}                     | ${[[mismatch('BTC/USDT', '1h', 'open: 2 | 1', 'volume: 11 | 10')]]}
      ${'nothing when the candles are equal'}                            | ${[gekkoCandle]}                                                 | ${[]}
      ${'nothing when the exchange has no candle starting at that time'} | ${[{ ...gekkoCandle, start: start + 60 * ONE_MINUTE, open: 2 }]} | ${[]}
    `('sends $description for a timeframe the exchange serves', async ({ answer, expected }) => {
      setUp('1h');
      fetchOHLCV.mockResolvedValue(answer);
      await check(bucket('BTC/USDT'));
      expect(fakeBot.sendMessage.mock.calls).toEqual(expected);
    });

    it.each`
      description                                                    | answer                                                                                                    | expected
      ${'nothing when its minutes batch into the candle'}            | ${minutes}                                                                                                | ${[]}
      ${'the fields that differ when they do not'}                   | ${[minutes[0], { ...minutes[1], close: 2.5, volume: 7 }]}                                                 | ${[[mismatch('BTC/USDT', '2m', 'close: 2.5 | 2', 'volume: 11 | 10')]]}
      ${'nothing when the exchange lacks the last minute'}           | ${[minutes[0]]}                                                                                           | ${[]}
      ${'the fields that differ in its minutes, not in those after'} | ${[minutes[0], { ...minutes[1], close: 2.5 }, { ...minutes[1], start: start + 2 * ONE_MINUTE, high: 9 }]} | ${[[mismatch('BTC/USDT', '2m', 'close: 2.5 | 2')]]}
    `('sends $description, for a timeframe batched from minutes', async ({ answer, expected }) => {
      setUp('2m');
      fetchOHLCV.mockResolvedValue(answer);
      await check(bucket('BTC/USDT'));
      expect(fakeBot.sendMessage.mock.calls).toEqual(expected);
    });

    it('checks every pair of the bucket', async () => {
      setUp('1h');
      await check(bucket('BTC/USDT', 'ETH/USDT'));
      expect(fetchOHLCV.mock.calls.map(([symbol]) => symbol)).toEqual(['BTC/USDT', 'ETH/USDT']);
    });

    it('checks nothing once unsubscribed', async () => {
      setUp('1h');
      plugin['handleCommand']('/sub_candle_check');
      await check(bucket('BTC/USDT'));
      expect(fetchOHLCV).not.toHaveBeenCalled();
    });

    // The flush of the deferred events awaits every handler before the next bucket: this one must not wait for the exchange nor Telegram
    it.each`
      service       | makeItHang
      ${'exchange'} | ${() => fetchOHLCV.mockReturnValue(new Promise(() => {}))}
      ${'Telegram'} | ${() => fakeBot.sendMessage.mockReturnValue(new Promise(() => {}))}
    `('returns at once while the $service does not answer', async ({ makeItHang }) => {
      setUp('1h');
      fetchOHLCV.mockResolvedValue([{ ...gekkoCandle, open: 2 }]); // A mismatch to send
      makeItHang();
      let hasReturned = false;
      (async () => {
        await plugin.onTimeframeCandle([bucket('BTC/USDT')]); // As the flush awaits it
        hasReturned = true;
      })();
      await vi.advanceTimersByTimeAsync(0);
      expect(hasReturned).toBe(true);
    });

    describe('while the check of a candle is in flight', () => {
      let answer: (candles: Candle[]) => void;

      beforeEach(() => {
        setUp('1h');
        fetchOHLCV.mockReturnValueOnce(new Promise<Candle[]>(resolve => (answer = resolve))); // Until the exchange answers
        plugin.onTimeframeCandle([bucket('BTC/USDT')]);
      });

      it('skips the next candle', async () => {
        await check(bucket('BTC/USDT'));
        expect(fetchOHLCV).toHaveBeenCalledTimes(1);
      });

      it('logs the skip at debug level', async () => {
        await check(bucket('BTC/USDT'));
        expect(debug).toHaveBeenCalledWith('supervision', 'Timeframe candle check skipped: the previous one is still in flight');
      });

      it('checks the candle after it once it is over', async () => {
        answer([gekkoCandle]);
        await vi.advanceTimersByTimeAsync(0);
        await check(bucket('BTC/USDT'));
        expect(fetchOHLCV).toHaveBeenCalledTimes(2);
      });
    });

    // A value without a prototype, which String() (and so a template literal) throws for, is described as inspect() does
    describe.each`
      failure                                         | makeItFail                                                                    | reason
      ${'the exchange fails'}                         | ${() => fetchOHLCV.mockRejectedValue(new Error('Exchange is down'))}          | ${'Exchange is down'}
      ${'Telegram fails'}                             | ${() => fakeBot.sendMessage.mockRejectedValue(new Error('Telegram is down'))} | ${'Telegram is down'}
      ${'the failure is a value without a prototype'} | ${() => fetchOHLCV.mockRejectedValue(Object.create(null))}                    | ${'[Object: null prototype] {}'}
    `('when $failure', ({ makeItFail, reason }) => {
      beforeEach(() => {
        setUp('1h');
        fetchOHLCV.mockResolvedValue([{ ...gekkoCandle, open: 2 }]); // A mismatch to send
        makeItFail();
      });

      it('ends its check without rejecting', async () => {
        plugin.onTimeframeCandle([bucket('BTC/USDT')]);
        await expect(plugin['candleCheckInFlight']).resolves.not.toThrow();
      });

      it('logs a warning naming the candle and the failure', async () => {
        await check(bucket('BTC/USDT'));
        expect(warning).toHaveBeenCalledWith(
          'supervision',
          `Timeframe candle check failed for the BTC/USDT 1h candle starting at 2024-01-01T00:00:00.000Z: ${reason}`,
        );
      });

      it('checks the next candle', async () => {
        await check(bucket('BTC/USDT'));
        await check(bucket('BTC/USDT'));
        expect(fetchOHLCV).toHaveBeenCalledTimes(2);
      });
    });

    it('checks the other pairs when one fails', async () => {
      setUp('1h');
      fetchOHLCV.mockImplementation(async symbol => {
        if (symbol === 'BTC/USDT') throw new Error('Exchange is down');
        return [{ ...gekkoCandle, open: 2 }];
      });
      await check(bucket('BTC/USDT', 'ETH/USDT'));
      expect(fakeBot.sendMessage.mock.calls).toEqual([[mismatch('ETH/USDT', '1h', 'open: 2 | 1')]]);
    });
  });

  // The same subscription checks that the 1-minute candles keep coming: every 100 ms here, the stale threshold being 300 ms
  describe('candle freshness check', () => {
    type Settle = Omit<PromiseWithResolvers<void>, 'promise'>;
    /** Monday 1 January 2024 at midnight UTC: the time of the subscription, unless a test lets time go by first */
    const subscribedAt = Date.UTC(2024, 0, 1);
    const toggleSubscription = () => plugin['handleCommand']('/sub_candle_check');
    /** Lets `ms` go by, a check every 100 ms, with a bucket received before each check until `bucketsUntil` ms have gone by */
    const run = async (ms: number, bucketsUntil = 0) => {
      for (let elapsed = 100; elapsed <= ms; elapsed += 100) {
        if (elapsed <= bucketsUntil) plugin['processOneMinuteBucket']();
        await vi.advanceTimersByTimeAsync(100);
      }
    };
    /** The alert that no bucket came for `minutes`, a number of them other than 1, the last one received at `lastAt` */
    const stopped = (minutes: number, lastAt = '2024-01-01T00:00:00.000Z') =>
      `⚠️ No 1m candle received for ${minutes} minutes, last one @ ${lastAt}`;
    /** The message that the buckets come again, the last one received at `lastAt` */
    const comingAgain = (lastAt: string) => `✅ 1m candles are coming again, last one @ ${lastAt}`;
    const sentMessages = () => fakeBot.sendMessage.mock.calls.map(([text]) => text);

    beforeEach(() => {
      vi.setSystemTime(subscribedAt);
    });

    it.each`
      description                                          | bucketsUntil | expected
      ${'nothing while the buckets keep coming'}           | ${1000}      | ${[]}
      ${'one alert when none came since the subscription'} | ${0}         | ${[stopped(0)]}
      ${'one alert naming the last bucket received'}       | ${200}       | ${[stopped(0, '2024-01-01T00:00:00.100Z')]}
    `('sends $description, over ten checks', async ({ bucketsUntil, expected }) => {
      toggleSubscription();
      await run(1000, bucketsUntil);
      expect(sentMessages()).toEqual(expected);
    });

    it('sends nothing while the last bucket is as old as the stale threshold, not older', async () => {
      toggleSubscription();
      await run(300);
      expect(fakeBot.sendMessage).not.toHaveBeenCalled();
    });

    it('measures the age from the last bucket received before the subscription', async () => {
      plugin['processOneMinuteBucket']();
      await vi.advanceTimersByTimeAsync(250);
      toggleSubscription();
      await run(100); // The first check, 350 ms after the bucket
      expect(sentMessages()).toEqual([stopped(0)]);
    });

    it('names the age of the last bucket in whole minutes', async () => {
      plugin = createSupervision({ ...baseConfig, candleCheckInterval: ONE_MINUTE, candleStaleThreshold: 3 * ONE_MINUTE });
      plugin['bot'] = fakeBot as any;
      toggleSubscription();
      await vi.advanceTimersByTimeAsync(4 * ONE_MINUTE); // Stale at the check of the 4th minute only: 3 minutes is not older
      expect(sentMessages()).toEqual([stopped(4)]);
    });

    // Written "minute(s)" whatever the age
    it('names an age of one whole minute in the singular', async () => {
      plugin = createSupervision({ ...baseConfig, candleCheckInterval: ONE_MINUTE / 2, candleStaleThreshold: ONE_MINUTE });
      plugin['bot'] = fakeBot as any;
      toggleSubscription();
      await vi.advanceTimersByTimeAsync(1.5 * ONE_MINUTE); // Stale at the check of 90 s only: 60 s is not older
      expect(sentMessages()).toEqual(['⚠️ No 1m candle received for 1 minute, last one @ 2024-01-01T00:00:00.000Z']);
    });

    it('says once that the buckets come again, naming the one that came', async () => {
      toggleSubscription();
      await run(600); // The alert, at 400 ms
      plugin['processOneMinuteBucket'](); // At 600 ms
      await run(300);
      expect(sentMessages()).toEqual([stopped(0), comingAgain('2024-01-01T00:00:00.600Z')]);
    });

    it('alerts again on a new subscription while the buckets are still missing', async () => {
      toggleSubscription();
      await run(500); // The alert, at 400 ms
      toggleSubscription();
      toggleSubscription();
      await run(100);
      expect(sentMessages()).toEqual([stopped(0), stopped(0)]);
    });

    it('stops on unsubscription', async () => {
      toggleSubscription();
      toggleSubscription();
      await run(1000);
      expect(fakeBot.sendMessage).not.toHaveBeenCalled();
    });

    it('keeps one check when started again while subscribed', () => {
      toggleSubscription();
      plugin['launchTimeframeCandleCheck']();
      expect(vi.getTimerCount()).toBe(1);
    });

    it('stops with the finalization', async () => {
      toggleSubscription();
      await plugin['processFinalize']();
      expect(vi.getTimerCount()).toBe(0);
    });

    // A value without a prototype, which String() (and so a template literal) throws for, is described as inspect() does
    describe.each`
      failure                          | rejection                        | reason
      ${'an error'}                    | ${new Error('Telegram is down')} | ${'Telegram is down'}
      ${'a value without a prototype'} | ${Object.create(null)}           | ${'[Object: null prototype] {}'}
    `('when Telegram fails to take the alert with $failure', ({ rejection, reason }) => {
      beforeEach(async () => {
        fakeBot.sendMessage.mockRejectedValueOnce(rejection);
        toggleSubscription();
        await run(400); // The alert, at 400 ms
      });

      it('logs the failure as a warning', () => {
        expect(warning).toHaveBeenCalledWith('supervision', `Candle alert not sent, sent again at the next check: ${reason}`);
      });

      it('sends it again at the next check', async () => {
        await run(100);
        expect(sentMessages()).toEqual([stopped(0), stopped(0)]);
      });
    });

    describe('while an alert is in flight', () => {
      let send: Settle;

      beforeEach(async () => {
        fakeBot.sendMessage.mockReturnValueOnce(new Promise<void>((resolve, reject) => (send = { resolve, reject })));
        toggleSubscription();
        await run(400); // The alert, at 400 ms, which Telegram does not answer yet
        plugin['processOneMinuteBucket'](); // The buckets come again, at 400 ms
      });

      it('sends nothing else', async () => {
        await run(500);
        expect(fakeBot.sendMessage).toHaveBeenCalledOnce();
      });

      it('logs the checks it skips at debug level', async () => {
        await run(100);
        expect(debug).toHaveBeenCalledWith('supervision', 'Candle freshness check skipped: the previous alert is still in flight');
      });

      it.each`
        outcome     | settle                                                    | expected
        ${'sent'}   | ${(s: Settle) => s.resolve()}                             | ${[stopped(0), comingAgain('2024-01-01T00:00:00.400Z')]}
        ${'failed'} | ${(s: Settle) => s.reject(new Error('Telegram is down'))} | ${[stopped(0)]}
      `('sends what has changed meanwhile at the next check once it has $outcome', async ({ settle, expected }) => {
        settle(send);
        await run(100);
        expect(sentMessages()).toEqual(expected);
      });
    });
  });

  describe('log monitoring', () => {
    type Settle = Omit<PromiseWithResolvers<void>, 'promise'>;
    /** Logged in the first millisecond by default: a burst of logs commonly shares one */
    const log = (message: string, level: LogLevel = 'warn', timestamp = 1): BufferedLog => ({ timestamp, level, tag: 'gekko', message });
    /** Sets the content of the ring buffer, oldest first */
    const buffer = (...logs: BufferedLog[]) => vi.mocked(getBufferedLogs).mockReturnValue(logs);
    /** The message of each log of each batch sent, failed sends included */
    const sentBatches = () =>
      fakeBot.sendMessage.mock.calls.map(([text]) => (text as string).split('---\n').map(entry => entry.split('\n')[1]));
    /** The next send stays in flight until settled */
    const sendInFlight = () => {
      let settle!: Settle;
      fakeBot.sendMessage.mockReturnValueOnce(new Promise<void>((resolve, reject) => (settle = { resolve, reject })));
      return settle;
    };
    const check = () => vi.advanceTimersByTimeAsync(100);
    const toggleSubscription = () => plugin['handleCommand']('/sub_monitor_log');

    it('starts on subscription', () => {
      toggleSubscription();
      expect(plugin['logMonitorInterval']).toBeDefined();
    });

    it('stops on unsubscription', () => {
      toggleSubscription();
      toggleSubscription();
      expect(plugin['logMonitorInterval']).toBeUndefined();
    });

    it('sends a batch as one entry per log: its time, level and tag, then its message', async () => {
      toggleSubscription();
      buffer(log('w1', 'warn', 1), log('e1', 'error', 2));
      await check();
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(
        '• 1970-01-01T00:00:00.001Z [WARN] (gekko)\nw1---\n• 1970-01-01T00:00:00.002Z [ERROR] (gekko)\ne1',
      );
    });

    it.each`
      description                                                                  | before                 | after                                                                     | evicted | expected
      ${'only the warnings and errors'}                                            | ${[]}                  | ${[log('i1', 'info'), log('w1'), log('d1', 'debug'), log('e1', 'error')]} | ${0}    | ${[['w1', 'e1']]}
      ${'nothing logged before the subscription'}                                  | ${[log('w0')]}         | ${[log('w1', 'warn', 2)]}                                                 | ${0}    | ${[['w1']]}
      ${'the logs of the millisecond of the last one before the subscription'}     | ${[log('i0', 'info')]} | ${[log('w1')]}                                                            | ${0}    | ${[['w1']]}
      ${'every buffered log once the last one before the subscription is evicted'} | ${[log('w0')]}         | ${[log('w1', 'warn', 2), log('w2', 'warn', 2)]}                           | ${1}    | ${[['w1', 'w2']]}
      ${'nothing without a new warning or error'}                                  | ${[log('w0')]}         | ${[log('i1', 'info', 2)]}                                                 | ${0}    | ${[]}
    `('sends $description at the first check', async ({ before, after, evicted, expected }) => {
      buffer(...before);
      toggleSubscription();
      buffer(...[...before, ...after].slice(evicted));
      await check();
      expect(sentBatches()).toEqual(expected);
    });

    it.each`
      description                                           | first                     | then                      | expected
      ${'what was logged since'}                            | ${[log('w1', 'warn', 1)]} | ${[log('w2', 'warn', 2)]} | ${[['w1'], ['w2']]}
      ${'the logs of the millisecond of the last one sent'} | ${[log('w1')]}            | ${[log('w2')]}            | ${[['w1'], ['w2']]}
      ${'nothing twice'}                                    | ${[log('w1')]}            | ${[]}                     | ${[['w1']]}
    `('sends $description at the check after a batch', async ({ first, then, expected }) => {
      toggleSubscription();
      buffer(...first);
      await check();
      buffer(...first, ...then);
      await check();
      expect(sentBatches()).toEqual(expected);
    });

    // A value without a prototype, which String() (and so a template literal) throws for, is described as inspect() does
    describe.each`
      failure                          | rejection                        | reason
      ${'an error'}                    | ${new Error('Telegram is down')} | ${'Telegram is down'}
      ${'a value without a prototype'} | ${Object.create(null)}           | ${'[Object: null prototype] {}'}
    `('when Telegram fails to take a batch with $failure', ({ rejection, reason }) => {
      const w1 = log('w1');

      beforeEach(async () => {
        fakeBot.sendMessage.mockRejectedValueOnce(rejection);
        toggleSubscription();
        buffer(w1);
        await check();
      });

      it('sends it again with the next batch', async () => {
        buffer(w1, log('e1', 'error'));
        await check();
        expect(sentBatches()).toEqual([['w1'], ['w1', 'e1']]);
      });

      it('logs the failure at debug level', () => {
        expect(debug).toHaveBeenCalledWith('supervision', `Logs not sent, retried with the next batch: ${reason}`);
      });
    });

    describe('while a batch is in flight', () => {
      const w1 = log('w1', 'warn', 1);
      const w2 = log('w2', 'warn', 2);
      let send: Settle;

      beforeEach(async () => {
        send = sendInFlight();
        toggleSubscription();
        buffer(w1);
        await check();
        buffer(w1, w2);
      });

      it('skips the checks', async () => {
        await vi.advanceTimersByTimeAsync(200);
        expect(fakeBot.sendMessage).toHaveBeenCalledTimes(1);
      });

      it.each`
        outcome     | settle                                                    | expected
        ${'sent'}   | ${(s: Settle) => s.resolve()}                             | ${[['w1'], ['w2']]}
        ${'failed'} | ${(s: Settle) => s.reject(new Error('Telegram is down'))} | ${[['w1'], ['w1', 'w2']]}
      `('sends what is left at the next check once it has $outcome', async ({ settle, expected }) => {
        settle(send);
        await check();
        expect(sentBatches()).toEqual(expected);
      });

      it.each`
        outcome     | settle                                                    | expected
        ${'sent'}   | ${(s: Settle) => s.resolve()}                             | ${[['w1'], ['w2']]}
        ${'failed'} | ${(s: Settle) => s.reject(new Error('Telegram is down'))} | ${[['w1'], ['w1', 'w2']]}
      `('lets the last flush send what is left once it has $outcome', async ({ settle, expected }) => {
        const finalization = plugin['processFinalize']();
        settle(send);
        await finalization;
        expect(sentBatches()).toEqual(expected);
      });

      it('keeps the start of a subscription made meanwhile', async () => {
        toggleSubscription();
        toggleSubscription();
        send.resolve();
        buffer(w1, w2, log('w3', 'warn', 3));
        await check();
        expect(sentBatches()).toEqual([['w1'], ['w3']]);
      });
    });
  });

  describe('processFinalize', () => {
    const stopReasonLog: BufferedLog = {
      timestamp: 2,
      level: 'warn',
      tag: 'stream',
      message: 'Application stopped gracefully: [STRATEGY] Max consecutive order errors reached (5)',
    };

    it('sends nothing when log monitoring is off', async () => {
      vi.mocked(getBufferedLogs).mockReturnValue([stopReasonLog]);

      await plugin['processFinalize']();

      expect(fakeBot.sendMessage).not.toHaveBeenCalled();
    });

    describe('when log monitoring is on', () => {
      beforeEach(() => {
        plugin['handleCommand']('/sub_monitor_log');
        vi.mocked(getBufferedLogs).mockReturnValue([stopReasonLog]); // Logged after the subscription
      });

      describe('when Telegram takes the last logs', () => {
        beforeEach(async () => {
          await plugin['processFinalize']();
        });

        it('sends the warnings and errors logged since the last check', () => {
          expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Max consecutive order errors reached (5)'));
        });

        it('logs no warning', () => {
          expect(warning).not.toHaveBeenCalled();
        });

        it('leaves no timer behind', () => {
          expect(vi.getTimerCount()).toBe(0);
        });
      });

      // A value without a prototype, which String() (and so a template literal) throws for, is described as inspect() does
      describe.each`
        failure                          | rejection                                                       | reason
        ${'an error'}                    | ${new Error('HTTP 403 Forbidden: bot was blocked by the user')} | ${'HTTP 403 Forbidden: bot was blocked by the user'}
        ${'a value without a prototype'} | ${Object.create(null)}                                          | ${'[Object: null prototype] {}'}
      `('when Telegram refuses them with $failure', ({ rejection, reason }) => {
        beforeEach(() => {
          fakeBot.sendMessage.mockRejectedValue(rejection);
        });

        it('resolves', async () => {
          await expect(plugin['processFinalize']()).resolves.toBeUndefined();
        });

        it('logs the failure as a warning', async () => {
          await plugin['processFinalize']();
          expect(warning).toHaveBeenCalledWith('supervision', `Last logs not sent: ${reason}`);
        });
      });

      describe('when Telegram does not answer', () => {
        let isFinalized: boolean;

        beforeEach(() => {
          fakeBot.sendMessage.mockReturnValue(new Promise(() => {})); // A black-holed network: the send never settles
          isFinalized = false;
          plugin['processFinalize']().then(() => (isFinalized = true));
        });

        it.each`
          elapsed  | finalization       | expected
          ${14999} | ${'still pending'} | ${false}
          ${15000} | ${'over'}          | ${true}
        `('has the finalization $finalization after $elapsed ms', async ({ elapsed, expected }) => {
          await vi.advanceTimersByTimeAsync(elapsed);
          expect(isFinalized).toBe(expected);
        });

        it('logs a warning when it gives them up', async () => {
          await vi.advanceTimersByTimeAsync(15000);
          expect(warning).toHaveBeenCalledWith('supervision', 'Last logs given up: not sent within 15 s');
        });
      });
    });
  });

  // close() does not abort the long poll in flight: it can still deliver a command once processFinalize has stopped the monitoring
  describe('once finalized', () => {
    beforeEach(async () => {
      plugin['handleCommand']('/sub_memory_check'); // Its monitoring stops with the finalization
      await plugin['processFinalize']();
    });

    it.each`
      command
      ${'/subscribe_all'}
      ${'/sub_cpu_check'}
      ${'/sub_candle_check'}
      ${'/sub_monitor_log'}
    `('starts no timer on $command', ({ command }) => {
      plugin['handleCommand'](command);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each`
      command                | answer
      ${'/subscribe_all'}    | ${'Gekko is stopping: no monitoring can start any more'}
      ${'/sub_candle_check'} | ${'Gekko is stopping: no monitoring can start any more'}
      ${'/sub_memory_check'} | ${'Unsubscribed from memory_check'}
    `('answers $command with $answer', ({ command, answer }) => {
      expect(plugin['handleCommand'](command)).toBe(answer);
    });

    it('takes no subscription', () => {
      plugin['handleCommand']('/subscribe_all');
      plugin['handleCommand']('/sub_cpu_check');
      expect(plugin['handleCommand']('/subscriptions')).toBe('memory_check');
    });
  });

  it('should return help information', () => {
    const res = plugin['handleCommand']('/help');
    expect(res).toContain('healthcheck');
    expect(res).toContain('help');
  });

  it('should subscribe to all monitoring', () => {
    plugin['handleCommand']('/subscribe_all');
    expect(plugin['subscriptions'].size).toBe(SUBSCRIPTION_NAMES.length);
  });

  it('should unsubscribe from all monitoring', () => {
    plugin['handleCommand']('/subscribe_all');
    plugin['handleCommand']('/unsubscribe_all');
    expect(plugin['subscriptions'].size).toBe(0);
  });

  it('should list current subscriptions', () => {
    plugin['handleCommand']('/sub_cpu_check');
    const res = plugin['handleCommand']('/subscriptions');
    expect(res).toBe('cpu_check');
  });

  it('should return no subscriptions when empty', () => {
    const res = plugin['handleCommand']('/subscriptions');
    expect(res).toBe('No subscriptions');
  });

  it.each`
    description                             | command
    ${'a subscription that does not exist'} | ${'/sub_unknown'}
    ${'a command that does not exist'}      | ${'/unknown'}
  `('answers $description as an unknown command', ({ command }) => {
    expect(plugin['handleCommand'](command)).toBe('Unknown command');
  });

  it('answers /healthcheck that Gekko is not running when the process has no uptime', () => {
    vi.spyOn(process, 'uptime').mockReturnValue(0);
    expect(plugin['handleCommand']('/healthcheck')).toBe('❌ Gekko is not running');
  });

  it('keeps one timer per monitoring when /subscribe_all follows every subscription', () => {
    SUBSCRIPTION_NAMES.forEach(subscription => plugin['handleCommand'](`/sub_${subscription}`));
    plugin['handleCommand']('/subscribe_all');
    expect(vi.getTimerCount()).toBe(SUBSCRIPTION_NAMES.length);
  });

  it('getStaticConfiguration returns expected meta', () => {
    const meta = Supervision.getStaticConfiguration();
    expect(meta).toMatchObject({ name: 'Supervision', modes: ['realtime'] });
    expect(meta.schema).toBe(supervisionSchema);
  });
});
