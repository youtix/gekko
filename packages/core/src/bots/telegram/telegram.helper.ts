import { MAX_MESSAGE_LENGTH } from './telegram.const';
import { TelegramMessage } from './telegram.types';

/**
 * Cuts a text into consecutive slices that each fit in a message: concatenated, they give the text back. A slice ends just
 * after the last line break in reach, so that log lines and stack frames stay whole. A line longer than a message is cut at
 * the limit, or one code unit short of it when a surrogate pair (an emoji, say) straddles it.
 */
export const splitIntoMessages = (text: string) => {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_MESSAGE_LENGTH) {
    const lineEnd = rest.lastIndexOf('\n', MAX_MESSAGE_LENGTH - 1) + 1; // 0 when no line break is in reach
    const straddles = rest.codePointAt(MAX_MESSAGE_LENGTH - 1)! > 0xffff; // A pair starts on the last code unit in reach
    const end = lineEnd > 0 ? lineEnd : straddles ? MAX_MESSAGE_LENGTH - 1 : MAX_MESSAGE_LENGTH;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return [...parts, rest];
};

/**
 * How the logs name the chat of a message, besides its id: 'private chat with @user', 'group "Title"', or undefined when the message
 * does not tell. A name its owner typed is written as a JSON string, whose escapes keep it on one line.
 */
export const describeChat = ({ chat, from }: TelegramMessage) => {
  if (chat.type === 'private') {
    const username = chat.username ?? from?.username;
    if (username) return `private chat with @${username}`;
    return from?.first_name ? `private chat with ${JSON.stringify(from.first_name)}` : 'private chat';
  }
  // A group, a supergroup or a channel
  return chat.type && chat.title ? `${chat.type} ${JSON.stringify(chat.title)}` : chat.type;
};
