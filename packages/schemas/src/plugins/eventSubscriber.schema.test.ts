import { describe, expect, it } from 'vitest';
import { eventSubscriberSchema } from './eventSubscriber.schema';

const entry = { name: 'EventSubscriber', token: 'token', botUsername: 'gekko_bot' };

describe('eventSubscriberSchema', () => {
  it('accepts the Telegram bot options', () => {
    expect(eventSubscriberSchema.parse(entry)).toEqual(entry);
  });

  // The one chat the bot talks to: a private chat has a positive id, a group a negative one
  it.each`
    scenario            | chatId
    ${'a private chat'} | ${123456789}
    ${'a group'}        | ${-123456789}
    ${'a supergroup'}   | ${-1001234567890}
  `('accepts the chat id of $scenario', ({ chatId }) => {
    expect(eventSubscriberSchema.parse({ ...entry, chatId })).toEqual({ ...entry, chatId });
  });

  // No update would match such a chat id, so the bot would ignore every command: it stops Gekko at start-up instead
  it.each`
    scenario                       | chatId
    ${'a chat id given as a text'} | ${'123456789'}
    ${'a fraction'}                | ${1.5}
    ${'an empty value'}            | ${null}
    ${'0, the id of no chat'}      | ${0}
  `('refuses $scenario as chatId', ({ chatId }) => {
    expect(eventSubscriberSchema.safeParse({ ...entry, chatId }).error?.issues).toMatchObject([{ path: ['chatId'] }]);
  });

  it('says why it refuses 0 as chatId', () => {
    expect(eventSubscriberSchema.safeParse({ ...entry, chatId: 0 }).error?.issues[0].message).toBe(
      'chatId cannot be 0, the id of no Telegram chat: a private chat has a positive id, a group a negative one',
    );
  });

  // Subscriptions are toggled with Telegram commands, not configured
  it.each`
    scenario                                 | options                                  | keys
    ${'an unknown option (subscriptions)'}   | ${{ subscriptions: ['order_complete'] }} | ${['subscriptions']}
    ${'an option of the Supervision plugin'} | ${{ cpuThreshold: 90 }}                  | ${['cpuThreshold']}
  `('refuses $scenario', ({ options, keys }) => {
    expect(eventSubscriberSchema.safeParse({ ...entry, ...options }).error?.issues).toMatchObject([
      { code: 'unrecognized_keys', keys, path: [] },
    ]);
  });
});
