import { debug, info, warning } from '../../logger/logger';
import { beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { TelegramBot } from './TelegramBot';
import { TelegramUpdate } from './telegram.types';

vi.mock('../../logger/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('../../fetcher/fetcher.service', () => ({
  fetcher: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const { fetcher } = await import('../../fetcher/fetcher.service');

// The chat of the bot's owner, and the chat of someone else who found the bot by its username
const OWNER_CHAT = 10;
const OTHER_CHAT = 66;

describe('TelegramBot', () => {
  let bot: TelegramBot;
  const token = 'test-token';
  const username = 'bot_name';
  const sentPayloads = () => (fetcher.post as Mock).mock.calls.map(([{ payload }]) => payload as { chat_id?: number; text: string });

  beforeEach(() => {
    bot = new TelegramBot(token, username, undefined, OWNER_CHAT);
  });

  it('fetchUpdates should return updates and update offset', async () => {
    const updates = [
      { update_id: 1, message: { text: 'a', chat: { id: 1 } } },
      { update_id: 2, message: { text: 'b', chat: { id: 2 } } },
    ];
    (fetcher.get as Mock).mockResolvedValue({ ok: true, result: updates });
    const result = await (bot as any).fetchUpdates();
    expect(fetcher.get).toHaveBeenCalledWith({
      url: `https://api.telegram.org/bot${token}/getUpdates?timeout=50&offset=1`,
    });
    expect(result).toEqual(updates);
    expect((bot as any).offset).toBe(2);
  });

  // The fetcher throws when Telegram says ok: false, and hands any other body over as it came: one that is not a list of updates the
  // bot can read fails the check, which the polling logs and backs off from. It was read as no update (a page in place of the JSON,
  // an answer without ok), threw a TypeError (null, no result) or was taken as it came (after an update without an id, the next poll
  // asked for offset NaN)
  describe('with an answer it cannot read', () => {
    const fetchUnreadable = () => (bot as any).fetchUpdates();

    it.each`
      description                         | answer
      ${'an answer that does not say ok'} | ${{ ok: false, result: [] }}
      ${'a page in place of the JSON'}    | ${'<html><body>502 Bad Gateway</body></html>'}
      ${'null'}                           | ${null}
      ${'an answer without result'}       | ${{ ok: true }}
      ${'an update without an id'}        | ${{ ok: true, result: [{ message: { text: '/help', chat: { id: OWNER_CHAT } } }] }}
      ${'a message without a chat'}       | ${{ ok: true, result: [{ update_id: 1, message: { text: '/help' } }] }}
    `('rejects $description as unreadable', async ({ answer }) => {
      (fetcher.get as Mock).mockResolvedValue(answer);
      await expect(fetchUnreadable()).rejects.toThrow('[BOT] Unreadable answer from Telegram to getUpdates:\n');
    });

    it('names what it cannot read and where', async () => {
      (fetcher.get as Mock).mockResolvedValue({ ok: true, result: [{ update_id: 1, message: { text: '/help' } }] });
      await expect(fetchUnreadable()).rejects.toThrow(
        'Unreadable answer from Telegram to getUpdates:\n✖ Invalid input: expected object, received undefined\n  → at result[0].message.chat',
      );
    });

    it('keeps the offset at 0', async () => {
      (fetcher.get as Mock).mockResolvedValue({ ok: true, result: [{ message: { text: '/help', chat: { id: OWNER_CHAT } } }] });
      await fetchUnreadable().catch(() => undefined);
      expect((bot as any).offset).toBe(0);
    });
  });

  it('fetchUpdates should keep the offset when there is no update', async () => {
    (fetcher.get as Mock).mockResolvedValue({ ok: true, result: [] });
    await (bot as any).fetchUpdates();
    expect((bot as any).offset).toBe(0);
  });

  describe('sendMessage', () => {
    const LIMIT = 4096; // The Bot API's limit on the text of a message
    const sentTexts = () => sentPayloads().map(({ text }) => text);
    const line = (char: string, length: number) => `${char.repeat(length - 1)}\n`; // `length` counts the line break

    it('sends a text to the configured chat, without waiting for a command', async () => {
      await bot.sendMessage('hello');
      expect(fetcher.post).toHaveBeenCalledExactlyOnceWith({
        url: `https://api.telegram.org/bot${token}/sendMessage`,
        payload: { chat_id: OWNER_CHAT, text: 'hello' },
      });
    });

    it.each`
      description                         | text
      ${'a short text'}                   | ${'hello'}
      ${'a text at the limit'}            | ${'a'.repeat(LIMIT)}
      ${'a multi-line text at the limit'} | ${line('a', 10) + line('b', LIMIT - 10)}
    `('sends $description unchanged, in one message', async ({ text }) => {
      await bot.sendMessage(text);
      expect(sentTexts()).toEqual([text]);
    });

    it.each`
      description                                            | text                                                   | parts
      ${'after the last line break in reach'}                | ${line('a', 3000) + line('b', 1000) + line('c', 2000)} | ${[line('a', 3000) + line('b', 1000), line('c', 2000)]}
      ${'after a line break on the last code unit in reach'} | ${line('a', 10) + line('b', LIMIT - 10) + 'c'}         | ${[line('a', 10) + line('b', LIMIT - 10), 'c']}
      ${'before a line break just out of reach'}             | ${line('a', 10) + line('b', LIMIT - 9) + 'c'}          | ${[line('a', 10), line('b', LIMIT - 9) + 'c']}
      ${'at the limit inside a line longer than a message'}  | ${'a'.repeat(LIMIT + 1)}                               | ${['a'.repeat(LIMIT), 'a']}
      ${'before a surrogate pair that straddles the limit'}  | ${'a'.repeat(LIMIT - 1) + '😀b'}                       | ${['a'.repeat(LIMIT - 1), '😀b']}
      ${'after a surrogate pair that ends on the limit'}     | ${'a'.repeat(LIMIT - 2) + '😀b'}                       | ${['a'.repeat(LIMIT - 2) + '😀', 'b']}
      ${'leaving out a blank part'}                          | ${line('a', LIMIT) + '\n' + 'b'.repeat(LIMIT + 1)}     | ${[line('a', LIMIT), 'b'.repeat(LIMIT), 'b']}
    `('cuts a long text $description', async ({ text, parts }) => {
      await bot.sendMessage(text);
      expect(sentTexts()).toEqual(parts);
    });

    it.each`
      description        | text
      ${'an empty text'} | ${''}
      ${'a blank text'}  | ${' \n'}
    `('sends nothing for $description', async ({ text }) => {
      await bot.sendMessage(text);
      expect(fetcher.post).not.toHaveBeenCalled();
    });

    describe('with a long batch of logs', () => {
      // Supervision's format: a header line per log, then its message (here an error with 0 to 6 stack frames)
      const batch = Array.from(
        { length: 200 },
        (_, i) => `• 2026-10-02T12:00:00.000Z [ERROR] (gekko)\nError: failure ${i}${'\n    at frame (src/file.ts:1:1)'.repeat(i % 7)}`,
      ).join('---\n');

      beforeEach(async () => {
        await bot.sendMessage(batch);
      });

      it('keeps every message within the limit', () => {
        expect(Math.max(...sentTexts().map(text => text.length))).toBeLessThanOrEqual(LIMIT);
      });

      it('ends every message but the last with a line break', () => {
        expect(sentTexts().filter((text, i, texts) => i < texts.length - 1 && !text.endsWith('\n'))).toEqual([]);
      });

      it('gives the batch back when the messages are concatenated', () => {
        expect(sentTexts().join('')).toBe(batch);
      });
    });

    it('does not send a part before the previous one is accepted', async () => {
      (fetcher.post as Mock).mockReturnValueOnce(new Promise(() => {})); // The first part is never accepted
      bot.sendMessage('a'.repeat(LIMIT + 1));
      await new Promise(resolve => setTimeout(resolve));
      expect(fetcher.post).toHaveBeenCalledTimes(1);
    });

    describe('when a part fails', () => {
      const failure = new Error('HTTP 429 Too Many Requests: Too Many Requests: retry after 5');
      const threeParts = 'a'.repeat(2 * LIMIT + 1);

      beforeEach(() => {
        (fetcher.post as Mock).mockResolvedValueOnce({}).mockRejectedValueOnce(failure);
      });

      it('rejects with its error', async () => {
        await expect(bot.sendMessage(threeParts)).rejects.toBe(failure);
      });

      it('does not send the parts after it', async () => {
        await bot.sendMessage(threeParts).catch(() => undefined);
        expect(fetcher.post).toHaveBeenCalledTimes(2);
      });
    });

    // No chatId configured and no command received yet: there is nobody to send to
    describe('without a chat', () => {
      beforeEach(async () => {
        bot = new TelegramBot(token, username);
        await bot.sendMessage('hello');
      });

      it('sends nothing', () => {
        expect(fetcher.post).not.toHaveBeenCalled();
      });

      it('says so at debug level', () => {
        expect(debug).toHaveBeenCalledWith('bot', expect.stringContaining('no chat yet'));
      });
    });
  });

  describe('checkUpdates', () => {
    const handle = vi.fn((command: string) => `answer to ${command}`);
    type Update = Omit<TelegramUpdate, 'update_id'>;
    const message = (chatId: number, text: string): Update => ({ message: { text, chat: { id: chatId } } });
    // A command as Telegram sends it: with fields the bot does not read, besides those it reads
    const TELEGRAM_MESSAGE = {
      message: {
        message_id: 7,
        date: 1600000000,
        from: { id: 5, is_bot: false, first_name: 'Ann', username: 'owner' },
        chat: { id: OWNER_CHAT, first_name: 'Ann', username: 'owner', type: 'private' },
        text: '/help',
      },
    };
    const answer = (updates: Update[]) => ({ ok: true, result: updates.map((update, i) => ({ update_id: i + 1, ...update })) });
    /**
     * Hands the bot a batch of updates, as getUpdates returns them. The first check of a bot without a chat starts by dropping the
     * updates queued before start-up, with a getUpdates whose offset is -1: there are none here (see 'at start-up').
     */
    const receive = async (...updates: Update[]) => {
      (fetcher.get as Mock).mockImplementation(async ({ url }: { url: string }) => answer(url.includes('offset=-1') ? [] : updates));
      await bot['checkUpdates']();
    };
    const sent = () => sentPayloads().map(({ chat_id, text }) => [chat_id, text]);

    describe('with a configured chat', () => {
      beforeEach(() => {
        bot = new TelegramBot(token, username, handle, OWNER_CHAT);
      });

      it.each`
        scenario                                                 | updates                                                                  | messages
        ${'answers a command of its chat'}                       | ${[message(OWNER_CHAT, '/help')]}                                        | ${[[OWNER_CHAT, 'answer to /help']]}
        ${'ignores a command of another chat'}                   | ${[message(OTHER_CHAT, '/unsubscribe_all')]}                             | ${[]}
        ${'ignores another chat that sends a command before it'} | ${[message(OTHER_CHAT, '/subscribe_all'), message(OWNER_CHAT, '/help')]} | ${[[OWNER_CHAT, 'answer to /help']]}
        ${'ignores an update without a message'}                 | ${[{}]}                                                                  | ${[]}
        ${'ignores a message without a text'}                    | ${[{ message: { chat: { id: OWNER_CHAT } } }]}                           | ${[]}
        ${'handles a command after an update without a text'}    | ${[{}, message(OWNER_CHAT, '/help')]}                                    | ${[[OWNER_CHAT, 'answer to /help']]}
        ${'answers a command with every field Telegram sends'}   | ${[TELEGRAM_MESSAGE]}                                                    | ${[[OWNER_CHAT, 'answer to /help']]}
      `('$scenario', async ({ updates, messages }) => {
        await receive(...updates);
        expect(sent()).toEqual(messages);
      });

      it('logs a message from another chat at debug level, with the id of that chat', async () => {
        await receive(message(OTHER_CHAT, '/help'));
        expect(debug).toHaveBeenCalledWith('bot', expect.stringContaining(`chat ${OTHER_CHAT}:`));
      });

      it('does not log that it takes a chat', async () => {
        await receive(message(OWNER_CHAT, '/help'));
        expect(info).not.toHaveBeenCalled();
      });

      it('does not answer a command when there is no handleCommand', async () => {
        bot = new TelegramBot(token, username, undefined, OWNER_CHAT);
        await receive(message(OWNER_CHAT, '/help'));
        expect(fetcher.post).not.toHaveBeenCalled();
      });

      // A plain text of its own chat is not a failed attempt to bind the bot: just chatter
      it('does not log a plain text of its chat', async () => {
        await receive(message(OWNER_CHAT, 'hi'));
        expect(debug).not.toHaveBeenCalledWith('bot', expect.stringContaining('not a command'));
      });
    });

    describe('without a configured chat', () => {
      beforeEach(() => {
        bot = new TelegramBot(token, username, handle);
      });

      // Each batch is a call of checkUpdates; then a notification goes out, as a plugin sends one
      it.each`
        scenario                                                 | batches                                                                                                   | messages
        ${'takes the chat of the first command'}                 | ${[[message(OWNER_CHAT, '/help')]]}                                                                       | ${[[OWNER_CHAT, 'answer to /help'], [OWNER_CHAT, 'notification']]}
        ${'then ignores another chat, in the same batch'}        | ${[[message(OWNER_CHAT, '/help'), message(OTHER_CHAT, '/unsubscribe_all')]]}                              | ${[[OWNER_CHAT, 'answer to /help'], [OWNER_CHAT, 'notification']]}
        ${'then ignores another chat, in a later batch'}         | ${[[message(OWNER_CHAT, '/help')], [message(OTHER_CHAT, '/unsubscribe_all')]]}                            | ${[[OWNER_CHAT, 'answer to /help'], [OWNER_CHAT, 'notification']]}
        ${'is not taken by a plain text of another chat'}        | ${[[message(OWNER_CHAT, '/help')], [message(OTHER_CHAT, 'hi')]]}                                          | ${[[OWNER_CHAT, 'answer to /help'], [OWNER_CHAT, 'notification']]}
        ${'takes no chat on a plain text'}                       | ${[[message(OTHER_CHAT, 'hi'), message(OWNER_CHAT, '/help'), message(OTHER_CHAT, '/help')]]}              | ${[[OWNER_CHAT, 'answer to /help'], [OWNER_CHAT, 'notification']]}
        ${'takes no chat on a command addressed to another bot'} | ${[[message(OTHER_CHAT, '/help@other_bot'), message(OWNER_CHAT, '/help'), message(OTHER_CHAT, '/help')]]} | ${[[OWNER_CHAT, 'answer to /help'], [OWNER_CHAT, 'notification']]}
        ${'sends nothing while no chat has sent a command'}      | ${[[message(OTHER_CHAT, 'hi')]]}                                                                          | ${[]}
      `('$scenario', async ({ batches, messages }) => {
        for (const updates of batches) await receive(...updates);
        await bot.sendMessage('notification');
        expect(sent()).toEqual(messages);
      });

      it('logs the chat it takes at info level, once, with its id', async () => {
        await receive(message(OWNER_CHAT, '/help'), message(OWNER_CHAT, '/subscriptions'));
        expect(info).toHaveBeenCalledExactlyOnceWith('bot', expect.stringContaining(`chatId: ${OWNER_CHAT}`));
      });

      it('logs a message from another chat at debug level, with the id of that chat', async () => {
        await receive(message(OWNER_CHAT, '/help'), message(OTHER_CHAT, '/help'));
        expect(debug).toHaveBeenCalledWith('bot', expect.stringContaining(`chat ${OTHER_CHAT}:`));
      });

      it('logs the chat it takes in full', async () => {
        await receive({ message: { text: '/help', chat: { id: OWNER_CHAT, type: 'private', username: 'owner' } } });
        expect(info).toHaveBeenCalledExactlyOnceWith(
          'bot',
          `@bot_name now talks only to the Telegram chat ${OWNER_CHAT} (private chat with @owner), the first to send it a command. ` +
            `To keep this chat from start-up, set chatId: ${OWNER_CHAT} in the configuration of its plugin.`,
        );
      });

      // As far as the message tells: the operator must see whose chat the bot took, a stranger's maybe
      it.each`
        kind                                               | chat                                                           | from                         | naming
        ${'a private chat, by its username'}               | ${{ id: OWNER_CHAT, type: 'private', username: 'owner' }}      | ${undefined}                 | ${`chat ${OWNER_CHAT} (private chat with @owner),`}
        ${'a private chat, by the username of its sender'} | ${{ id: OWNER_CHAT, type: 'private' }}                         | ${{ username: 'owner' }}     | ${`chat ${OWNER_CHAT} (private chat with @owner),`}
        ${'a private chat without a username, by a name'}  | ${{ id: OWNER_CHAT, type: 'private' }}                         | ${{ first_name: 'Ann Lee' }} | ${`chat ${OWNER_CHAT} (private chat with "Ann Lee"),`}
        ${'a private chat without any name'}               | ${{ id: OWNER_CHAT, type: 'private' }}                         | ${undefined}                 | ${`chat ${OWNER_CHAT} (private chat),`}
        ${'a group, by its title'}                         | ${{ id: -20, type: 'group', title: 'Gekko alerts' }}           | ${{ username: 'owner' }}     | ${'chat -20 (group "Gekko alerts"),'}
        ${'a supergroup, by its title'}                    | ${{ id: -1001234567890, type: 'supergroup', title: 'Alerts' }} | ${{ username: 'owner' }}     | ${'chat -1001234567890 (supergroup "Alerts"),'}
        ${'a title on two lines, on one'}                  | ${{ id: -20, type: 'group', title: 'Gekko\n[INFO] fake' }}     | ${undefined}                 | ${'chat -20 (group "Gekko\\n[INFO] fake"),'}
        ${'a group without a title, by its kind'}          | ${{ id: -20, type: 'group' }}                                  | ${undefined}                 | ${'chat -20 (group),'}
        ${'a chat of an unknown kind, by its id alone'}    | ${{ id: OWNER_CHAT, title: 'Gekko alerts' }}                   | ${{ username: 'owner' }}     | ${`chat ${OWNER_CHAT}, the first`}
      `('names $kind', async ({ chat, from, naming }) => {
        await receive({ message: { text: '/help', chat, from } });
        expect(info).toHaveBeenCalledExactlyOnceWith('bot', expect.stringContaining(naming));
      });

      // Only a command binds the bot: its owner, who may expect a text to do it too, can see why it did not
      it('logs a plain text at debug level, with the id of its chat', async () => {
        await receive(message(OTHER_CHAT, 'hi'));
        expect(debug).toHaveBeenCalledWith(
          'bot',
          `@bot_name ignored a message from the Telegram chat ${OTHER_CHAT}: not a command, and only a command binds it`,
        );
      });
    });

    // The Start button, how a chat with a bot begins, sends /start: the first contact gets the list of commands
    it.each`
      text
      ${'/start'}
      ${'/start@bot_name'}
    `('hands $text to handleCommand as /help', async ({ text }) => {
      bot = new TelegramBot(token, username, handle);
      await receive(message(OWNER_CHAT, text));
      expect(handle).toHaveBeenCalledExactlyOnceWith('/help');
    });

    // The offset is already past the batch when it is handled: a failure must not drop the updates after it
    describe('when handling an update fails', () => {
      const refuseTheAnswer = () =>
        (fetcher.post as Mock).mockRejectedValueOnce(new Error('HTTP 403 Forbidden: bot was blocked by the user'));
      const throwInThePlugin = () =>
        handle.mockImplementationOnce(() => {
          throw new Error('boom');
        });

      beforeEach(() => {
        bot = new TelegramBot(token, username, handle, OWNER_CHAT);
      });

      it.each`
        scenario                                        | fail
        ${'Telegram refuses the answer'}                | ${refuseTheAnswer}
        ${'the plugin throws while handling a command'} | ${throwInThePlugin}
      `('handles the next update of the batch when $scenario', async ({ fail }) => {
        fail();
        await receive(message(OWNER_CHAT, '/help'), message(OWNER_CHAT, '/subscriptions'));
        expect(sentPayloads().at(-1)).toEqual({ chat_id: OWNER_CHAT, text: 'answer to /subscriptions' });
      });

      // A string as it is, which util.inspect quoted
      it.each`
        failure                                                         | reason
        ${new Error('HTTP 403 Forbidden: bot was blocked by the user')} | ${'HTTP 403 Forbidden: bot was blocked by the user'}
        ${'socket hang up'}                                             | ${'socket hang up'}
        ${{ error_code: 403 }}                                          | ${'{ error_code: 403 }'}
      `('logs the failure $reason at warning level', async ({ failure, reason }) => {
        (fetcher.post as Mock).mockRejectedValueOnce(failure);
        await receive(message(OWNER_CHAT, '/help'));
        expect(warning).toHaveBeenCalledExactlyOnceWith('bot', `Failed to handle the Telegram update 1: ${reason}`);
      });
    });

    describe('reading a command', () => {
      const read = async (botUsername: string, text: string) => {
        bot = new TelegramBot(token, botUsername, handle);
        await receive(message(OWNER_CHAT, text));
      };

      // Bare or addressed to the bot (in any case, even when configured with its '@'), with or without an argument
      it.each`
        botUsername    | text                    | command
        ${'bot_name'}  | ${'/help'}              | ${'/help'}
        ${'bot_name'}  | ${'/help@bot_name'}     | ${'/help'}
        ${'bot_name'}  | ${'/help@Bot_Name'}     | ${'/help'}
        ${'Bot_Name'}  | ${'/help@bot_name'}     | ${'/help'}
        ${'@bot_name'} | ${'/help@bot_name'}     | ${'/help'}
        ${'bot_name'}  | ${'/sub_cpu_check now'} | ${'/sub_cpu_check'}
        ${'bot_name'}  | ${'/help@bot_name now'} | ${'/help'}
      `('hands $text to handleCommand as $command, for the bot $botUsername', async ({ botUsername, text, command }) => {
        await read(botUsername, text);
        expect(handle).toHaveBeenCalledExactlyOnceWith(command);
      });

      it.each`
        description                             | text
        ${'a command addressed to another bot'} | ${'/help@other_bot'}
        ${'a plain text'}                       | ${'hi'}
        ${'a text that names the bot'}          | ${'ping me @bot_name'}
        ${'a slash alone'}                      | ${'/'}
      `('ignores $description', async ({ text }) => {
        await read(username, text);
        expect(handle).not.toHaveBeenCalled();
      });

      // With a wrong botUsername, the bare commands of a private chat work but every command tapped in a group's menu, which names
      // the bot, is ignored: the log names both bots
      it.each`
        scenario                  | chatId
        ${'while it has no chat'} | ${undefined}
        ${'in its chat'}          | ${OWNER_CHAT}
      `('logs a command addressed to another bot at debug level, $scenario', async ({ chatId }) => {
        bot = new TelegramBot(token, 'real_bot', handle, chatId);
        await receive(message(OWNER_CHAT, '/help@Reel_Bot now'));
        expect(debug).toHaveBeenCalledWith(
          'bot',
          '@real_bot ignored /help addressed to @Reel_Bot: if that is this bot, its botUsername option is wrong',
        );
      });
    });

    // The first check of a bot without a chat starts by dropping the updates queued before start-up, which Telegram keeps for 24 hours:
    // a /start that a stranger sent while Gekko was down must not bind the bot. A bot bound by its configuration handles them.
    describe('at start-up', () => {
      const FIRST_ID = 500; // Telegram numbers the updates of each bot from an id of its own
      const STRANGER_START = message(OTHER_CHAT, '/start');
      const getUpdatesUrl = (parameters: string) => `https://api.telegram.org/bot${token}/getUpdates?${parameters}`;
      const urls = () => (fetcher.get as Mock).mock.calls.map(([{ url }]) => url);
      /**
       * Telegram, with `queued` waiting since before start-up and `later` sent after it, numbered from FIRST_ID. getUpdates with a
       * negative offset -n answers the last n updates queued, or fails with `dropFailure`; with a positive offset, the updates from
       * that id on. (Telegram also forgets the updates queued before the last one, which no answer here would show.)
       */
      const telegram = (queued: Update[], later: Update[] = [], dropFailure?: unknown) => {
        const updates = [...queued, ...later].map((update, i) => ({ update_id: FIRST_ID + i, ...update }));
        (fetcher.get as Mock).mockImplementation(async ({ url }: { url: string }) => {
          const offset = Number(new URL(url).searchParams.get('offset'));
          if (offset < 0 && dropFailure) throw dropFailure;
          const result =
            offset < 0 ? updates.slice(0, queued.length).slice(offset) : updates.filter(({ update_id }) => update_id >= offset);
          return { ok: true, result };
        });
      };
      const check = () => bot['checkUpdates']();

      describe('without a configured chat', () => {
        beforeEach(() => {
          bot = new TelegramBot(token, username, handle);
        });

        it('first asks Telegram for the last update queued, at once, which drops the earlier ones', async () => {
          telegram([STRANGER_START]);
          await check();
          expect(urls()[0]).toBe(getUpdatesUrl('offset=-1&timeout=0'));
        });

        // The poll that asks for the updates after the last one queued confirms it: Telegram never sends it again
        it.each`
          scenario                    | queued                                                     | offset
          ${'nothing is queued'}      | ${[]}                                                      | ${1}
          ${'one update is queued'}   | ${[STRANGER_START]}                                        | ${FIRST_ID + 1}
          ${'two updates are queued'} | ${[STRANGER_START, message(OTHER_CHAT, '/subscribe_all')]} | ${FIRST_ID + 2}
        `('then polls from offset $offset when $scenario', async ({ queued, offset }) => {
          telegram(queued);
          await check();
          expect(urls()[1]).toBe(getUpdatesUrl(`timeout=50&offset=${offset}`));
        });

        // Each scenario ends with a notification, as a plugin sends one: it goes to the chat the bot took, if any
        it.each`
          scenario                                                     | queued                                                     | later                             | messages
          ${'takes no chat on a /start queued before start-up'}        | ${[STRANGER_START]}                                        | ${[]}                             | ${[]}
          ${'takes no chat on the commands queued before start-up'}    | ${[STRANGER_START, message(OTHER_CHAT, '/subscribe_all')]} | ${[]}                             | ${[]}
          ${'takes the chat of the first command sent after start-up'} | ${[STRANGER_START]}                                        | ${[message(OWNER_CHAT, '/help')]} | ${[[OWNER_CHAT, 'answer to /help'], [OWNER_CHAT, 'notification']]}
        `('$scenario', async ({ queued, later, messages }) => {
          telegram(queued, later);
          await check();
          await bot.sendMessage('notification');
          expect(sent()).toEqual(messages);
        });

        it('warns that it will take the first chat to send it a command', async () => {
          telegram([]);
          await check();
          expect(warning).toHaveBeenCalledExactlyOnceWith(
            'bot',
            'Telegram bot @bot_name has no chatId: it will bind itself to the first chat that sends it a command from now on, ' +
              'whoever that is. Set chatId in the configuration of its plugin to lock it to your chat.',
          );
        });

        it('logs the last update it drops at debug level', async () => {
          telegram([STRANGER_START, STRANGER_START]);
          await check();
          expect(debug).toHaveBeenCalledWith(
            'bot',
            `Telegram bot @bot_name dropped the updates queued before start-up, up to update ${FIRST_ID + 1}`,
          );
        });

        it('logs no drop when nothing is queued', async () => {
          telegram([]);
          await check();
          expect(debug).not.toHaveBeenCalledWith('bot', expect.stringContaining('dropped'));
        });

        describe('at the next checks', () => {
          beforeEach(async () => {
            telegram([STRANGER_START]);
            await check();
            await check();
          });

          it('only polls', () => {
            expect(urls()).toEqual([
              getUpdatesUrl('offset=-1&timeout=0'),
              getUpdatesUrl(`timeout=50&offset=${FIRST_ID + 1}`),
              getUpdatesUrl(`timeout=50&offset=${FIRST_ID + 1}`),
            ]);
          });

          it('does not warn again', () => {
            expect(warning).toHaveBeenCalledOnce();
          });
        });

        // Then the polls start from the earliest update kept, as they did before the drop existed
        describe('when dropping the queued updates fails', () => {
          const failure = new Error('HTTP 502 Bad Gateway: Bad Gateway');

          beforeEach(() => {
            telegram([STRANGER_START], [], failure);
          });

          it('does not fail the check: the polling goes on', async () => {
            await expect(check()).resolves.toBeUndefined();
          });

          it('polls from the earliest update kept', async () => {
            await check();
            expect(urls()).toEqual([getUpdatesUrl('offset=-1&timeout=0'), getUpdatesUrl('timeout=50&offset=1')]);
          });

          it('handles the queued updates as they come: the first command among them takes the bot', async () => {
            await check();
            expect(sent()).toEqual([[OTHER_CHAT, 'answer to /help']]);
          });

          it.each`
            dropFailure            | reason
            ${failure}             | ${'HTTP 502 Bad Gateway: Bad Gateway'}
            ${{ error_code: 502 }} | ${'{ error_code: 502 }'}
          `('logs the failure $reason at warning level', async ({ dropFailure, reason }) => {
            telegram([STRANGER_START], [], dropFailure);
            await check();
            expect(warning).toHaveBeenLastCalledWith(
              'bot',
              `Telegram bot @bot_name could not drop the updates queued before start-up: ${reason}. ` +
                'It handles them as they come, so the first command among them, whoever sent it, binds it.',
            );
          });
        });
      });

      // Its chat may have sent commands while Gekko was down (a /subscribe_all): they still count, and other chats are ignored anyway
      describe('with a configured chat', () => {
        beforeEach(async () => {
          bot = new TelegramBot(token, username, handle, OWNER_CHAT);
          telegram([message(OWNER_CHAT, '/subscribe_all'), STRANGER_START]);
          await check();
        });

        it('polls at once, from the earliest update queued', () => {
          expect(urls()).toEqual([getUpdatesUrl('timeout=50&offset=1')]);
        });

        it('handles the commands its chat sent before start-up, and those only', () => {
          expect(sent()).toEqual([[OWNER_CHAT, 'answer to /subscribe_all']]);
        });

        it('does not warn', () => {
          expect(warning).not.toHaveBeenCalled();
        });
      });
    });
  });
});
