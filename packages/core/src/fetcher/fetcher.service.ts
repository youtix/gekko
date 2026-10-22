import { ONE_SECOND } from '@gekko/shared/constants/time.const';
import { describeError } from '@gekko/shared/errors/error.helper';
import { debug } from '../logger/logger';
import { getRetryDelay } from '@gekko/shared/utils/fetch/fetch.utils';
import { wait } from '@gekko/shared/utils/process/process.utils';
import { isNumber, isObject, isString } from 'lodash-es';
import { FETCHER_MAX_RETRIES, FETCHER_MAX_RETRY_AFTER, FETCHER_TIMEOUT } from './fetcher.const';
import { BotApiAnswer, Fetcher, Request, ResponseParameters } from './fetcher.types';

/**
 * How long an attempt may take: FETCHER_TIMEOUT, on top of the wait of a long poll. Telegram holds a getUpdates open for its
 * `timeout` seconds while it has no update to answer with: aborted sooner, every poll of a quiet chat would fail.
 */
const getTimeout = (url: string) => {
  const longPoll = Number(new URL(url).searchParams.get('timeout')); // 0 without one, NaN when not a number: no wait added
  return FETCHER_TIMEOUT + (longPoll > 0 ? longPoll * ONE_SECOND : 0);
};

/**
 * The wait in ms before another attempt at a request that failed with this code, or undefined when there is no point in one. A
 * 429 waits the retry_after seconds that Telegram's flood control gives, or the backoff without a usable one (missing, not a
 * number, NaN or negative). A retry_after past FETCHER_MAX_RETRY_AFTER is not waited out: the 429 is thrown at once. The code of a
 * 2xx is the error_code of its body, which can hold anything: one that is not a number is no code, and the failure is thrown at once.
 */
const getHttpRetryDelay = (attempt: number, code: unknown, retryAfter?: unknown) => {
  if (code === 429 && isNumber(retryAfter) && retryAfter >= 0) {
    const delay = retryAfter * ONE_SECOND;
    return delay <= FETCHER_MAX_RETRY_AFTER ? delay : undefined;
  }
  if (code === 429 || (isNumber(code) && code >= 500)) return getRetryDelay(attempt);
  return undefined;
};

/**
 * Retry policy: a request is sent again, up to `retries` more times, only after a failure that may pass. Without an answer (fetch
 * rejects: a network failure, or a timeout once an attempt outlasts getTimeout), it is sent again after the backoff of
 * getRetryDelay. Once an answer comes, its status decides, whatever its body, which can only tell more:
 * - a server error (5xx) is sent again after the backoff;
 * - a rate limit (429), after the retry_after seconds that Telegram's flood control gives in the body, or else after the backoff,
 *   but it is thrown at once when it asks for more than FETCHER_MAX_RETRY_AFTER;
 * - a 2xx whose body says ok: false counts as its error_code, and is thrown at once without one;
 * - a 2xx whose body cannot be read or parsed answers a request that went through: a GET is sent again after the backoff
 *   (getUpdates, at the same offset, loses nothing), a POST is thrown at once, since its message may have been delivered.
 * Any other failure would be met again, so it is thrown at once: a 4xx such as 400 (bad request), 401 (wrong token), 403 (bot
 * blocked by the user) or 409 (another getUpdates consumer of the token), whatever its body (a proxy's HTML page, an empty one).
 * The error given up on is logged once.
 */
const request: Request = async ({ url, payload, attempt = 0, retries = FETCHER_MAX_RETRIES }) => {
  let retryDelay: number | undefined = getRetryDelay(attempt); // Until an answer comes, a failure can only be a network one
  try {
    const config = payload
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      : undefined;

    // The signal aborts the reading of the answer too, should it stall
    const response = await fetch(url, { ...config, signal: AbortSignal.timeout(getTimeout(url)) });
    const httpStatus = `HTTP ${response.status} ${response.statusText}`;

    // Answered: from here on, the status decides whatever becomes of the body. A 2xx answers a request that went through: should
    // its body fail to be read, a POST is not sent again, as its message may have been delivered already.
    const mayHaveBeenDelivered = response.ok && !!payload;
    if (!response.ok) retryDelay = getHttpRetryDelay(attempt, response.status);
    else if (mayHaveBeenDelivered) retryDelay = undefined;

    const contentType = response.headers.get('Content-Type');
    const isJson = contentType && contentType.includes('application/json');
    const data = await (isJson ? response.json() : response.text()).catch((err: unknown) => {
      const notRetried = mayHaveBeenDelivered ? '. The request may have been delivered, so it is not retried' : '';
      throw new Error(`${httpStatus}: unreadable body (${describeError(err)})${notRetried}`, { cause: err });
    });

    // Any JSON value or a text: the fields of a failure are read where it is an object. Typed any (by lib.dom), it was read as an
    // object whatever it was, and a JSON null threw a TypeError here, in place of what the answer said
    const answer: BotApiAnswer = isObject(data) ? data : {};
    if (!response.ok || answer.ok === false) {
      // The body tells more: a 2xx carries the code of its failure there alone, as Telegram's error_code, and a 429 the
      // retry_after of the flood control
      const parameters: ResponseParameters = isObject(answer.parameters) ? answer.parameters : {};
      retryDelay = getHttpRetryDelay(attempt, response.ok ? answer.error_code : response.status, parameters.retry_after);
      const errorDetails = isString(answer.description) && answer.description ? answer.description : JSON.stringify(data);
      throw new Error(`${httpStatus}: ${errorDetails}`);
    }

    return data;
  } catch (err) {
    if (retryDelay === undefined || attempt >= retries) {
      // At debug level: every caller logs what it could not fetch, at the level it deserves (a notification not sent, a poll
      // failed), and a bot blocked for hours would otherwise write one error line per request, which Supervision forwards
      debug('fetcher', describeError(err));
      throw err;
    }

    await wait(retryDelay);
    return request({ url, payload, retries, attempt: attempt + 1 });
  }
};

export const fetcher: Fetcher = { post: request, get: request };
