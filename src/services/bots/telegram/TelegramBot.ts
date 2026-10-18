import { describeError } from '@errors/error.helper';
import { GekkoError } from '@errors/gekko.error';
import { fetcher } from '@services/fetcher/fetcher.service';
import { debug, info, warning } from '@services/logger';
import { pluralize } from '@utils/string/string.utils';
import { isString } from 'lodash-es';
import { z } from 'zod';
import { Bot } from '../Bot';
import { HandleCommand } from '../bots.types';
import { COMMAND } from './telegram.const';
import { describeChat, splitIntoMessages } from './telegram.helper';
import { getUpdatesAnswerSchema } from './telegram.schema';
import { TelegramUpdate } from './telegram.types';

export class TelegramBot extends Bot {
  private readonly apiUrl: string;
  private offset = 0;
  /**
   * The one chat the bot talks to: it handles the commands of no other, and sends its messages there. Anyone can find a bot by
   * its username and write to it, so this is the configured chat or else the first one to send a command, kept until the process
   * ends: no later chat can take over the notifications or the subscriptions. Undefined until then.
   */
  private chatId?: number;
  private readonly botUsername: string;
  /** Whether the first check has run the start-up step (see start) */
  private hasStarted = false;

  constructor(token: string, botUsername: string, handleCommand?: HandleCommand, chatId?: number) {
    super(handleCommand);
    this.apiUrl = `https://api.telegram.org/bot${token}`;
    // Kept as a command names it, without the '@' it is often written with, and in lower case: Telegram usernames ignore case
    this.botUsername = botUsername.replace(/^@/, '').toLowerCase();
    this.chatId = chatId;
  }

  /**
   * Calls getUpdates with these parameters, and keeps the id of the last update returned as the offset. Telegram keeps an update,
   * 24 hours at most, until a getUpdates confirms it with a higher offset than its id (https://core.telegram.org/bots/api#getupdates).
   * Throws, the offset kept, when the answer is not a list of updates the bot can read. The fetcher throws when Telegram says ok: false
   * and hands any other body over unchecked: a page in its place (a proxy's) was read as no update, and null threw a TypeError.
   */
  private async getUpdates(parameters: string): Promise<TelegramUpdate[]> {
    const url = `${this.apiUrl}/getUpdates?${parameters}`;
    const answer = getUpdatesAnswerSchema.safeParse(await fetcher.get({ url }));
    if (!answer.success) {
      throw new GekkoError('bot', `Unreadable answer from Telegram to getUpdates:\n${z.prettifyError(answer.error)}`);
    }
    const updates = answer.data.result;
    if (updates.length > 0) this.offset = updates[updates.length - 1].update_id;

    return updates;
  }

  /** A long poll for the updates after the last one received, which it confirms */
  private fetchUpdates() {
    return this.getUpdates(`timeout=50&offset=${this.offset + 1}`);
  }

  /**
   * Sends a text to the bot's chat, or nothing while it has none. A text longer than a message goes out as several, in order,
   * each once the previous one is accepted. If one fails, this rejects with its error and the parts after it are not sent.
   */
  public async sendMessage(text: string) {
    const chatId = this.chatId;
    if (chatId === undefined) {
      return debug('bot', `Message not sent: @${this.botUsername} has no chat yet (no chatId configured, no command received)`);
    }
    for (const part of splitIntoMessages(text)) {
      // Never a blank message: Telegram refuses an empty text, and a blank one would show nothing
      if (!part.trim()) continue;
      await fetcher.post({
        url: `${this.apiUrl}/sendMessage`,
        payload: { chat_id: chatId, text: part },
      });
    }
  }

  /**
   * The step the first check starts with. A bot without a chatId takes the first chat to send it a command, whoever that is: it
   * warns, and confirms the updates queued before start-up without handling them. Its first poll would otherwise get them all, up
   * to 24 hours of them, and a /start sent by a stranger while Gekko was down (or crashed, then restarted by a supervisor) would bind
   * the bot before its owner could press Start. A bot bound by its configuration handles them as they come: the commands its chat
   * sent while Gekko was down (a /subscribe_all) still count, and other chats are ignored anyway.
   */
  private async start() {
    if (this.chatId !== undefined) return;
    warning(
      'bot',
      `Telegram bot @${this.botUsername} has no chatId: it will bind itself to the first chat that sends it a command from now on, ` +
        'whoever that is. Set chatId in the configuration of its plugin to lock it to your chat.',
    );
    try {
      // A negative offset -n asks for the last n updates queued, and has Telegram forget all the earlier ones. So offset=-1 returns
      // the last update at most, which is not confirmed yet: as the offset is now its id, the first poll asks for the updates after
      // it, which confirms it unhandled. timeout=0: no long poll, the answer comes at once, even when nothing is queued.
      const lastQueued = (await this.getUpdates('offset=-1&timeout=0')).at(-1);
      if (lastQueued) {
        debug('bot', `Telegram bot @${this.botUsername} dropped the updates queued before start-up, up to update ${lastQueued.update_id}`);
      }
    } catch (err) {
      // The polls go on regardless, from the earliest update kept: the queued updates are handled as they come, as before this step
      // existed, and the first command among them binds the bot
      warning(
        'bot',
        `Telegram bot @${this.botUsername} could not drop the updates queued before start-up: ${describeError(err)}. ` +
          'It handles them as they come, so the first command among them, whoever sent it, binds it.',
      );
    }
  }

  protected async checkUpdates(): Promise<void> {
    if (!this.hasStarted) {
      this.hasStarted = true; // Once, even when the step fails: it never rejects, and says why
      await this.start();
    }
    const updates = await this.fetchUpdates();
    debug('bot', `Received ${updates.length} ${pluralize('update', updates.length)} from Telegram Bot`);
    // The offset is already past the whole batch: a failure that escaped would drop the updates after it for good
    for (const update of updates) {
      await this.handleUpdate(update).catch(err => {
        warning('bot', `Failed to handle the Telegram update ${update.update_id}: ${describeError(err)}`);
      });
    }
  }

  private async handleUpdate({ message }: TelegramUpdate) {
    if (!message || !isString(message.text)) return;
    const { text, chat } = message;
    if (this.chatId !== undefined && chat.id !== this.chatId) {
      return debug('bot', `@${this.botUsername} ignored a message from the Telegram chat ${chat.id}: it only talks to chat ${this.chatId}`);
    }
    const [, command, username] = text.match(COMMAND) ?? [];
    if (!command) {
      // A plain text binds no chat, which its owner may not expect while the bot has none
      if (this.chatId === undefined) {
        debug(
          'bot',
          `@${this.botUsername} ignored a message from the Telegram chat ${chat.id}: not a command, and only a command binds it`,
        );
      }
      return;
    }
    // In a group, a command can name another bot: it is not for this one. Logged, since with a wrong botUsername the bot ignores the
    // commands tapped in a group's menu, which name it, while the bare commands of a private chat work
    if (username !== undefined && username.toLowerCase() !== this.botUsername) {
      return debug(
        'bot',
        `@${this.botUsername} ignored ${command} addressed to @${username}: if that is this bot, its botUsername option is wrong`,
      );
    }
    if (this.chatId === undefined) {
      this.chatId = chat.id;
      const description = describeChat(message);
      info(
        'bot',
        `@${this.botUsername} now talks only to the Telegram chat ${chat.id}${description ? ` (${description})` : ''}, ` +
          `the first to send it a command. To keep this chat from start-up, set chatId: ${chat.id} in the configuration of its plugin.`,
      );
    }
    if (!this.handleCommand) return;
    // The Start button, how a chat with a bot begins, sends /start: the answer lists the commands
    await this.sendMessage(this.handleCommand(command === '/start' ? '/help' : command));
  }
}
