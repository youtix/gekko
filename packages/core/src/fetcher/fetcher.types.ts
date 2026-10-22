type RequestFetch = {
  url: string;
  payload?: unknown;
  retries?: number;
  attempt?: number;
};

/**
 * Resolves with the body of the answer as it came: the parsed JSON of a JSON answer, whatever value it is, or the text of any other.
 * It was typed as whatever the caller asked for, which nothing checked: the caller checks what it reads (see TelegramBot.getUpdates).
 */
export type Request = ({ payload, url, attempt, retries }: RequestFetch) => Promise<unknown>;

type PostFetch = {
  url: string;
  payload: unknown;
  retries?: number;
  attempt?: number;
};

type GetFetch = {
  url: string;
  retries?: number;
  attempt?: number;
};

/** Both resolve with the body of the answer as it came (see Request) */
export type Fetcher = {
  post: ({ payload, url, attempt, retries }: PostFetch) => Promise<unknown>;
  get: ({ url, attempt, retries }: GetFetch) => Promise<unknown>;
};

/**
 * The fields of a Bot API answer that tell of a failure (https://core.telegram.org/bots/api#making-requests), each of any type in a
 * body read as it came. A body that is not an object (a text, null, a number) has none of them.
 */
export type BotApiAnswer = { ok?: unknown; error_code?: unknown; description?: unknown; parameters?: unknown };

/** The field of a Bot API answer's parameters that the fetcher reads: the retry_after of Telegram's flood control */
export type ResponseParameters = { retry_after?: unknown };
