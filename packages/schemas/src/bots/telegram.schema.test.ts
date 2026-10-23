import { describe, expect, it } from 'vitest';
import { chatIdSchema, getUpdatesAnswerSchema } from './telegram.schema';

/** A command a user sent in a private chat, as Telegram's getUpdates answers it: more fields than the bot reads */
const PRIVATE_COMMAND = {
  update_id: 7,
  message: {
    message_id: 3,
    date: 1_700_000_000,
    text: '/portfolio',
    chat: { id: 42, type: 'private', username: 'alice', first_name: 'Alice' },
    from: { id: 42, is_bot: false, username: 'alice', first_name: 'Alice', language_code: 'en' },
  },
};
/** A post in a channel, which has a title and no sender */
const CHANNEL_POST = {
  update_id: 8,
  message: { message_id: 4, text: 'hello', chat: { id: -1001234567890, type: 'channel', title: 'News' } },
};

const answerOf = (...result: unknown[]) => ({ ok: true, result });

describe('chatIdSchema', () => {
  it.each`
    scenario            | chatId
    ${'a private chat'} | ${123456789}
    ${'a group'}        | ${-123456789}
    ${'a supergroup'}   | ${-1001234567890}
  `('accepts the id of $scenario', ({ chatId }) => {
    expect(chatIdSchema.parse(chatId)).toBe(chatId);
  });

  // With 0, the bot would ignore every command, its owner's included, and Telegram would refuse every message it sends
  it.each`
    scenario                   | chatId         | message
    ${'0, the id of no chat'}  | ${0}           | ${'chatId cannot be 0, the id of no Telegram chat: a private chat has a positive id, a group a negative one'}
    ${'a fraction'}            | ${1.5}         | ${'Invalid input: expected int, received number'}
    ${'an id given as a text'} | ${'123456789'} | ${'Invalid input: expected number, received string'}
  `('refuses $scenario', ({ chatId, message }) => {
    expect(chatIdSchema.safeParse(chatId).error?.issues).toMatchObject([{ path: [], message }]);
  });
});

describe('getUpdatesAnswerSchema', () => {
  // Telegram sends more than the bot reads (the ids of the message and of the sender, the date, the language), which is dropped
  it.each`
    scenario                                                     | answer                                                                   | expected
    ${'a command in a private chat, keeping what the bot reads'} | ${answerOf(PRIVATE_COMMAND)}                                             | ${answerOf({ update_id: 7, message: { text: '/portfolio', chat: { id: 42, type: 'private', username: 'alice' }, from: { username: 'alice', first_name: 'Alice' } } })}
    ${'a post in a channel, without a sender'}                   | ${answerOf(CHANNEL_POST)}                                                | ${answerOf({ update_id: 8, message: { text: 'hello', chat: { id: -1001234567890, type: 'channel', title: 'News' } } })}
    ${'an update of another kind (an edit), without a message'}  | ${answerOf({ update_id: 9, edited_message: PRIVATE_COMMAND.message })}   | ${answerOf({ update_id: 9 })}
    ${'a message without text (a photo)'}                        | ${answerOf({ update_id: 10, message: { chat: { id: 42 }, photo: [] } })} | ${answerOf({ update_id: 10, message: { chat: { id: 42 } } })}
    ${'no update'}                                               | ${answerOf()}                                                            | ${answerOf()}
  `('reads $scenario', ({ answer, expected }) => {
    expect(getUpdatesAnswerSchema.parse(answer)).toEqual(expected);
  });

  // A page in place of the answer (a proxy's) was read as no update, and null threw a TypeError
  it.each`
    scenario                                       | answer                                                                 | path                                      | message
    ${"a page in place of the answer (a proxy's)"} | ${'<html><body>Bad Gateway</body></html>'}                             | ${[]}                                     | ${'Invalid input: expected object, received string'}
    ${'an empty answer (null)'}                    | ${null}                                                                | ${[]}                                     | ${'Invalid input: expected object, received null'}
    ${'an answer without its result'}              | ${{ ok: true }}                                                        | ${['result']}                             | ${'Invalid input: expected array, received undefined'}
    ${'an update without its id'}                  | ${answerOf({ message: PRIVATE_COMMAND.message })}                      | ${['result', 0, 'update_id']}             | ${'Invalid input: expected number, received undefined'}
    ${'a message without its chat'}                | ${answerOf({ update_id: 7, message: { text: '/portfolio' } })}         | ${['result', 0, 'message', 'chat']}       | ${'Invalid input: expected object, received undefined'}
    ${'a chat id given as a text'}                 | ${answerOf({ update_id: 7, message: { chat: { id: '42' } } })}         | ${['result', 0, 'message', 'chat', 'id']} | ${'Invalid input: expected number, received string'}
    ${'a text that is not a string'}               | ${answerOf({ update_id: 7, message: { text: 42, chat: { id: 42 } } })} | ${['result', 0, 'message', 'text']}       | ${'Invalid input: expected string, received number'}
  `('refuses $scenario', ({ answer, path, message }) => {
    expect(getUpdatesAnswerSchema.safeParse(answer).error?.issues).toMatchObject([{ path, message }]);
  });

  // The fetcher throws for such an answer before the schema reads it: refused all the same, ok and result each with its issue
  it('refuses an answer that says ok: false', () => {
    expect(getUpdatesAnswerSchema.safeParse({ ok: false, description: 'Conflict' }).error?.issues).toMatchObject([
      { path: ['ok'], message: 'Invalid input: expected true' },
      { path: ['result'], message: 'Invalid input: expected array, received undefined' },
    ]);
  });
});
