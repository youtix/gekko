import { ONE_SECOND } from '@gekko/shared/constants/time.const';
import type { supervisionSchema } from '@gekko/schemas/plugins/supervision.schema';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { pick } from 'lodash-es';
import type { z } from 'zod';
import { REALTIME_START, startFakeClock } from '../../helpers/clock.helper';
import type { RawConfiguration } from '../../helpers/configuration.helper';
import {
  endRealtimeRun,
  mockRealtimeModules,
  runRealtimeFor,
  runRealtimeUntilEnd,
  useRealtimeConfiguration,
} from '../../helpers/realtimeRun.helper';
import { MockCCXTExchange } from '../../mocks/ccxt.mock';
import { MockFetcherService } from '../../mocks/fetcher.mock';
import { clearLogs, isTextLine, logStore } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// 1. Mock winston, ccxt and the fetcher, which the Telegram bot of Supervision calls. Each test runs on real minutes under the fake
// clock, from 12:00:30, and ends its run before the next test starts (see realtimeRun.helper)
mockRealtimeModules();
// The bot's lines are info lines and warnings, which the logger hands winston whatever the level: set, so that a level in the
// environment cannot add the debug lines
process.env.GEKKO_LOG_LEVEL = 'info';

// 2. Configuration: one pair on Binance, Supervision as the only plugin, its options set by each scenario
let supervision: Omit<z.input<typeof supervisionSchema>, 'name' | 'token' | 'botUsername'>;
useRealtimeConfiguration(
  (): RawConfiguration => ({
    watch: { mode: 'realtime', assets: ['BTC'], currency: 'USDT', timeframe: '1m', warmup: { candleCount: 0 } },
    exchange: { name: 'binance' },
    plugins: [{ name: 'Supervision', token: 'test-token', botUsername: 'gekko_bot', ...supervision }],
  }),
);

// --------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------

/** The start of the minute hh:mm of the day the runs start on, 2024-01-01 (see REALTIME_START) */
const minute = (hours: number, minutes: number) => Date.UTC(2024, 0, 1, hours, minutes);

/** `seconds` seconds after the start of the run, 12:00:30 */
const afterStart = (seconds: number) => REALTIME_START + seconds * ONE_SECOND;

/** A command a chat sends the bot, which Telegram holds from `at` on: before the start of the run, it was queued while Gekko was down */
type Command = { at: EpochTimeStamp; chat: number; text: string };

let commands: Command[] = [];

/**
 * Telegram's getUpdates as the bot calls it: the commands sent by now, numbered from 1 in the order they were sent, from the one the
 * offset names on, or the last -offset of them for a negative offset, which the bot asks for at start-up to drop what was queued
 */
const getUpdates = (url: string) => {
  const offset = Number(new URL(url).searchParams.get('offset'));
  const updates = commands
    .map(({ at, chat, text }, index) => ({
      at,
      update: {
        update_id: index + 1,
        message: {
          message_id: index + 1,
          from: { id: chat, is_bot: false, first_name: 'Trader', username: `trader${chat}` },
          chat: { id: chat, type: 'private', username: `trader${chat}` },
          date: Math.floor(at / ONE_SECOND),
          text,
        },
      },
    }))
    .filter(({ at }) => at <= Date.now())
    .map(({ update }) => update);
  return { ok: true, result: offset < 0 ? updates.slice(offset) : updates.filter(({ update_id }) => update_id >= offset) };
};

/** The messages the bot sent, oldest first: when, to which chat, and what (sendMessage, the only POST it makes) */
const sentMessages = () =>
  MockFetcherService.callHistory
    .filter(({ method }) => method === 'POST')
    .map(({ timestamp, payload }) => ({ at: timestamp, chat: payload.chat_id, text: payload.text }));

/** The lines the Telegram bot logged, at info level and above, oldest first, each after its level */
const botLines = () =>
  logStore
    .filter(isTextLine)
    .filter(({ _tag, level }) => _tag === 'BOT' && level !== 'debug')
    .map(({ level, message }) => `${level}: ${message}`);

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Realtime Supervision', () => {
  beforeEach(() => {
    clearLogs();
    MockFetcherService.reset();
    MockFetcherService.when('getUpdates').thenReturn(getUpdates);
    MockCCXTExchange.reset();
    commands = [];
    startFakeClock();
  });

  // A realtime run never ends by itself: each test ends its own, plugins finalised, before the next one starts
  afterEach(() => endRealtimeRun());

  it('Scenario A: candle_check alerts at 12:05:31 that no candle came for 3 minutes, then at 12:07:31 that they come again', async () => {
    supervision = { chatId: 123 };
    // The exchange has no candle for the minutes 12:02 to 12:05
    MockCCXTExchange.simulatedGaps = [{ start: minute(12, 2), end: minute(12, 6) }];
    commands = [{ at: afterStart(1), chat: 123, text: '/sub_candle_check' }];

    await runRealtimeFor({ minutes: 9 });

    // The check looks at the age of the last bucket every minute from the subscription, handled by the poll of 12:00:31: at 12:01:31,
    // 12:02:31 and so on. The ticks bring a bucket a minute until 12:02:02, then nothing for four ticks. At 12:05:31 the last bucket is
    // 209 s old, above the 3 minutes of candleStaleThreshold. The tick of 12:07:02 gets 12:06, and the buckets of 12:02 to 12:05, made
    // up by the gap filler, with it: at 12:07:31 the last bucket is 29 s old.
    expect(sentMessages()).toEqual([
      { at: afterStart(1), chat: 123, text: 'Subscribed to candle_check' },
      {
        at: minute(12, 5) + 31 * ONE_SECOND,
        chat: 123,
        text: '⚠️ No 1m candle received for 3 minutes, last one @ 2024-01-01T12:02:02.000Z',
      },
      { at: minute(12, 7) + 31 * ONE_SECOND, chat: 123, text: '✅ 1m candles are coming again, last one @ 2024-01-01T12:07:02.000Z' },
    ]);
  });

  it('Scenario B: cpu_check and memory_check alert every 10 s from their subscription to their unsubscription', async () => {
    // Thresholds any process exceeds: the alerts come at each check
    supervision = { chatId: 123, cpuThreshold: 1e-9, memoryThreshold: 1 };
    commands = [
      { at: afterStart(1), chat: 123, text: '/sub_cpu_check' },
      { at: afterStart(2), chat: 123, text: '/sub_memory_check' },
      { at: afterStart(30), chat: 123, text: '/subscriptions' },
      { at: afterStart(35), chat: 123, text: '/sub_cpu_check' },
      { at: afterStart(36), chat: 123, text: '/sub_memory_check' },
      { at: afterStart(37), chat: 123, text: '/subscriptions' },
    ];

    await runRealtimeFor({ minutes: 2 });

    // Each check runs every 10 s, cpuCheckInterval and memoryCheckInterval by default, from its subscription: three of each before
    // the unsubscriptions, none in the minute after them. The usages are the process's own, as they come.
    const cpuAlert = expect.stringMatching(/^⚠️ CPU usage exceeded: \d+\.\d\d%$/);
    const memoryAlert = expect.stringMatching(/^⚠️ Memory usage exceeded: \d+\.\d\d MB$/);
    expect(sentMessages()).toEqual([
      { at: afterStart(1), chat: 123, text: 'Subscribed to cpu_check' },
      { at: afterStart(2), chat: 123, text: 'Subscribed to memory_check' },
      { at: afterStart(11), chat: 123, text: cpuAlert },
      { at: afterStart(12), chat: 123, text: memoryAlert },
      { at: afterStart(21), chat: 123, text: cpuAlert },
      { at: afterStart(22), chat: 123, text: memoryAlert },
      { at: afterStart(30), chat: 123, text: 'cpu_check\nmemory_check' },
      { at: afterStart(31), chat: 123, text: cpuAlert },
      { at: afterStart(32), chat: 123, text: memoryAlert },
      { at: afterStart(35), chat: 123, text: 'Unsubscribed from cpu_check' },
      { at: afterStart(36), chat: 123, text: 'Unsubscribed from memory_check' },
      { at: afterStart(37), chat: 123, text: 'No subscriptions' },
    ]);
  });

  it.each([
    [
      'without chatId: the command queued before start-up dropped, the first sent after it binds the bot to its chat, whoever',
      {
        chatId: undefined,
        // 456's subscription binds the bot to 456, which 123 asks about too late
        sent: [{ at: afterStart(10), chat: 456, text: 'Subscribed to candle_check' }],
        botLines: [
          'warn: Telegram bot @gekko_bot has no chatId: it will bind itself to the first chat that sends it a command from now on, ' +
            'whoever that is. Set chatId in the configuration of its plugin to lock it to your chat.',
          'info: @gekko_bot now talks only to the Telegram chat 456 (private chat with @trader456), the first to send it a command. ' +
            'To keep this chat from start-up, set chatId: 456 in the configuration of its plugin.',
        ],
      },
    ],
    [
      "with chatId 123: the command its chat queued before start-up answered at the first poll, another chat's ignored",
      {
        chatId: 123,
        // 456's subscription is not taken: 123 has none
        sent: [
          { at: REALTIME_START, chat: 123, text: 'No subscriptions' },
          { at: afterStart(20), chat: 123, text: 'No subscriptions' },
        ],
        botLines: [],
      },
    ],
  ])('Scenario C: the chat of the bot %s', async (_title, { chatId, sent, botLines: lines }) => {
    supervision = { chatId };
    commands = [
      { at: afterStart(-10), chat: 123, text: '/subscriptions' },
      { at: afterStart(10), chat: 456, text: '/sub_candle_check' },
      { at: afterStart(20), chat: 123, text: '/subscriptions' },
    ];

    // A minute in which the candles come every minute: the candle check of 456, if it took, has nothing to report
    await runRealtimeFor({ minutes: 1 });

    expect({ sent: sentMessages(), botLines: botLines() }).toEqual({ sent, botLines: lines });
  });

  it('Scenario D: monitor_log sends each minute the warnings logged since the last batch, and why the run stops as it stops', async () => {
    supervision = { chatId: 123 };
    // Delisted: the exchange has no candle from 12:02 on, so that the run stops after the 5th tick without one, at 12:07:02
    MockCCXTExchange.simulatedGaps = [{ start: minute(12, 2), end: Infinity }];
    commands = [{ at: afterStart(1), chat: 123, text: '/sub_monitor_log' }];

    const failure = await runRealtimeUntilEnd({ maxMinutes: 10 });

    // A batch every minute from the subscription, logMonitoringInterval by default, of the warnings and errors logged since the last
    // one: none at 12:01:31 and 12:02:31, nothing logged by then; from the tick of 12:03:02 on, each tick warns that 12:02 is still
    // missing. The last batch goes out as the plugins are finalised, at the stop: the 5th warning, then the error that says why the
    // application closes.
    const missing = 'Received undefined candle for BTC/USDT @ 2024-01-01T12:02:00.000Z';
    const stop =
      '[STREAM] No 1m candle received for BTC/USDT for 5 minutes (last one @ 2024-01-01T12:01:00.000Z): the pair no longer delivers.';
    /** The batch of the warning the tick of hh:mm:02 logged, sent at hh:mm:31 */
    const batchOf = (minutes: number) => ({
      at: minute(12, minutes) + 31 * ONE_SECOND,
      chat: 123,
      text: `• ${new Date(minute(12, minutes) + 2 * ONE_SECOND).toISOString()} [WARN] (stream)\n${missing}`,
    });
    expect({ failure: pick(failure, ['name', 'message']), sent: sentMessages() }).toEqual({
      failure: { name: 'GekkoError', message: stop },
      sent: [
        { at: afterStart(1), chat: 123, text: 'Subscribed to monitor_log' },
        batchOf(3),
        batchOf(4),
        batchOf(5),
        batchOf(6),
        {
          at: minute(12, 7) + 2 * ONE_SECOND,
          chat: 123,
          text: [
            `• 2024-01-01T12:07:02.000Z [WARN] (stream)\n${missing}`,
            `• 2024-01-01T12:07:02.000Z [ERROR] (stream)\nGekko is closing the application due to an error: ${stop}`,
          ].join('---\n'),
        },
      ],
    });
  });
});
