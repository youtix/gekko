import { ONE_SECOND } from '@gekko/shared/constants/time.const';

/**
 * How long the finalisation of the plugins waits for the messages still to go out to Telegram, and so holds the exit: the pending
 * notifications of the EventSubscriber and the last logs of Supervision, which are finalised together, so the exit waits that long at
 * most for both. Telegram unreachable without an answer (a black-holed network) would hold them for every attempt of the fetcher, each
 * up to its own timeout. Each plugin declared its own, and a comment asked to keep the two equal.
 */
export const LAST_FLUSH_TIMEOUT = 15 * ONE_SECOND;

// Bot API, sendMessage: a text of "1-4096 characters after entities parsing" (https://core.telegram.org/bots/api#sendmessage).
// Compared with String.length, which counts UTF-16 code units: never fewer than the characters.
export const MAX_MESSAGE_LENGTH = 4096;

// A command is the first token of a text when it is a slash and a name: '/help', or '/help@bot_username' to single out one bot
// in a group (https://core.telegram.org/bots/features#commands). The tokens after it, if any, are its arguments.
export const COMMAND = /^(\/[^\s@]+)(?:@(\S*))?/;
