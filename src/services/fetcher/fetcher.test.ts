import { debug } from '@services/logger';
import { isString, omit } from 'lodash-es';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { FETCHER_MAX_RETRIES, FETCHER_TIMEOUT } from './fetcher.const';
import { fetcher } from './fetcher.service';

vi.mock('@services/logger', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

const fetchMock = vi.fn<typeof fetch>();

/** An answer of the Bot API, with a JSON body, or a text one when the body is a string. */
const answer = (status: number, statusText: string, body: object | string | null) =>
  new Response(isString(body) ? body : JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': isString(body) ? 'text/plain' : 'application/json' },
  });

/** A failure as Telegram answers it: its code is both the HTTP status and the error_code of the body. */
const failure = (status: number, statusText: string, parameters?: object) =>
  answer(status, statusText, { ok: false, error_code: status, description: statusText, parameters });

/** Telegram's flood control, which asks to wait retry_after seconds before another attempt */
const rateLimit = (retryAfter: unknown) => failure(429, 'Too Many Requests', { retry_after: retryAfter });

const networkFailure = () => Promise.reject(new TypeError('fetch failed'));

// How fetch, and the reading of the answer, reject once the signal of the request aborts them: on its timeout, or otherwise
const timedOut = () => new DOMException('The operation timed out.', 'TimeoutError');
const timeoutFailure = () => Promise.reject(timedOut());
const abortFailure = () => Promise.reject(new DOMException('This operation was aborted', 'AbortError'));

// Answers whose body cannot be read: its reading times out, or it says it is JSON but is a proxy's HTML page, or nothing
const timeoutInAnswer = (status = 200, statusText = 'OK') =>
  new Response(new ReadableStream({ pull: controller => controller.error(timedOut()) }), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
const unparsable = (status: number, statusText: string, body = `<html><body>${status} ${statusText}</body></html>`) =>
  new Response(body, { status, statusText, headers: { 'Content-Type': 'application/json' } });

// 2xx answers that tell of a failure in their body only
const refusalIn200 = () => answer(200, 'OK', { ok: false, description: 'refused' });
const rateLimitIn200 = (retryAfter = 5) => answer(200, 'OK', { ok: false, error_code: 429, parameters: { retry_after: retryAfter } });
const failureIn200 = (errorCode: unknown) => answer(200, 'OK', { ok: false, error_code: errorCode });

// When the attempts at a request that always fails are sent, in ms: the first one alone, or followed by FETCHER_MAX_RETRIES
// retries, spaced by the backoff of getRetryDelay (1000, 1584.96 and 2000 ms, which setTimeout cuts to whole milliseconds) or by
// the retry_after of Telegram's flood control: 5 s here, or 60 s, the longest one waited out (FETCHER_MAX_RETRY_AFTER)
const ONCE = [0];
const BACKOFF = [0, 1000, 2584, 4584];
const RETRY_AFTER = [0, 5000, 10000, 15000];
const MAX_RETRY_AFTER = [0, 60_000, 120_000, 180_000];
// The same backoff after attempts that each wait FETCHER_TIMEOUT for an answer that never comes
const NO_ANSWER = BACKOFF.map((sentAt, attempt) => sentAt + attempt * FETCHER_TIMEOUT);

describe('fetcher', () => {
  const url = 'https://dummy.url';
  const payload = { test: 'data' };

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Runs a request to its end, through the waits before its retries, and gives what it resolved or rejected with. */
  const settle = async (request: Promise<unknown>) => {
    const outcome = request.catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    return outcome;
  };

  /** What a call to fetch sent: its URL and options, but for the signal of its timeout, which each attempt has its own */
  const sentRequest = ([input, init]: Parameters<typeof fetch>) => [input, omit(init, 'signal')];

  describe.each([
    // A 200 whose body cannot be read answers a request that went through: a POST is not sent again, it may have been delivered
    { method: 'post', send: (retries?: number) => fetcher.post({ url, payload, retries }), unreadable200: ONCE },
    { method: 'get', send: (retries?: number) => fetcher.get({ url, retries }), unreadable200: BACKOFF },
  ])('$method', ({ send, unreadable200 }) => {
    // A body is read as it came: a JSON null, which says nothing of a failure, threw a TypeError where the fields of one were read
    it.each`
      kind           | body                          | expected
      ${'JSON'}      | ${{ ok: true, result: 'ok' }} | ${{ ok: true, result: 'ok' }}
      ${'text'}      | ${'plain text'}               | ${'plain text'}
      ${'JSON null'} | ${null}                       | ${null}
    `('returns the body of a $kind answer', async ({ body, expected }) => {
      fetchMock.mockResolvedValue(answer(200, 'OK', body));
      expect(await send()).toEqual(expected);
    });

    // The failure of an answer whose body holds no description, or one that is not a string, is described by the JSON of its body: a
    // null body threw a TypeError in its place, and a description that was an object was written [object Object]
    it.each`
      status | statusText        | body                                     | message
      ${400} | ${'Bad Request'}  | ${{ ok: false, description: 'error' }}   | ${'HTTP 400 Bad Request: error'}
      ${404} | ${'Not Found'}    | ${{ ok: false, description: 'missing' }} | ${'HTTP 404 Not Found: missing'}
      ${500} | ${'Server Error'} | ${{ ok: false }}                         | ${'HTTP 500 Server Error: {"ok":false}'}
      ${200} | ${'OK'}           | ${{ ok: false, description: 'refused' }} | ${'HTTP 200 OK: refused'}
      ${500} | ${'Server Error'} | ${null}                                  | ${'HTTP 500 Server Error: null'}
      ${400} | ${'Bad Request'}  | ${{ ok: false, description: {} }}        | ${'HTTP 400 Bad Request: {"ok":false,"description":{}}'}
    `('rejects an answer $status $statusText with "$message"', async ({ status, statusText, body, message }) => {
      fetchMock.mockResolvedValue(answer(status, statusText, body));
      await expect(send(0)).rejects.toThrow(message);
    });

    // The failure is described as every log line describes one (see describeError), by its message: interpolated, it was written by
    // String(), which throws for a value without a prototype from the very catch meant to report it
    it.each`
      outcome                  | reply                                        | message
      ${'an HTML body'}        | ${() => unparsable(401, 'Unauthorized')}     | ${'HTTP 401 Unauthorized: unreadable body ('}
      ${'an empty body'}       | ${() => unparsable(401, 'Unauthorized', '')} | ${'HTTP 401 Unauthorized: unreadable body ('}
      ${'a body read timeout'} | ${() => timeoutInAnswer(502, 'Bad Gateway')} | ${'HTTP 502 Bad Gateway: unreadable body (The operation timed out.)'}
    `('rejects an answer with $outcome with its status: "$message"', async ({ reply, message }) => {
      fetchMock.mockImplementation(async () => reply());
      await expect(send(0)).rejects.toThrow(message);
    });

    it.each`
      outcome                                              | reply                                                | sentAt
      ${'400 Bad Request'}                                 | ${() => failure(400, 'Bad Request')}                 | ${ONCE}
      ${'401 Unauthorized (wrong token)'}                  | ${() => failure(401, 'Unauthorized')}                | ${ONCE}
      ${'403 Forbidden (bot blocked)'}                     | ${() => failure(403, 'Forbidden')}                   | ${ONCE}
      ${'404 Not Found'}                                   | ${() => failure(404, 'Not Found')}                   | ${ONCE}
      ${'409 Conflict (two getUpdates)'}                   | ${() => failure(409, 'Conflict')}                    | ${ONCE}
      ${'200 OK with ok: false'}                           | ${refusalIn200}                                      | ${ONCE}
      ${'500 Internal Server Error'}                       | ${() => failure(500, 'Internal Server Error')}       | ${BACKOFF}
      ${'502 Bad Gateway'}                                 | ${() => failure(502, 'Bad Gateway')}                 | ${BACKOFF}
      ${'503 Service Unavailable'}                         | ${() => failure(503, 'Service Unavailable')}         | ${BACKOFF}
      ${'a network failure'}                               | ${networkFailure}                                    | ${BACKOFF}
      ${'a timeout (TimeoutError)'}                        | ${timeoutFailure}                                    | ${BACKOFF}
      ${'an abort (AbortError)'}                           | ${abortFailure}                                      | ${BACKOFF}
      ${'429 with retry_after 5'}                          | ${() => rateLimit(5)}                                | ${RETRY_AFTER}
      ${'429 with retry_after 60, the longest waited out'} | ${() => rateLimit(60)}                               | ${MAX_RETRY_AFTER}
      ${'429 with retry_after 61'}                         | ${() => rateLimit(61)}                               | ${ONCE}
      ${'429 with retry_after 3600'}                       | ${() => rateLimit(3600)}                             | ${ONCE}
      ${'429 without retry_after'}                         | ${() => failure(429, 'Too Many Requests')}           | ${BACKOFF}
      ${'429 with a negative retry_after'}                 | ${() => rateLimit(-5)}                               | ${BACKOFF}
      ${'429 with a retry_after that is not a number'}     | ${() => rateLimit('5')}                              | ${BACKOFF}
      ${'200 OK with error_code 429'}                      | ${rateLimitIn200}                                    | ${RETRY_AFTER}
      ${'200 OK with error_code 429 and retry_after 3600'} | ${() => rateLimitIn200(3600)}                        | ${ONCE}
      ${'200 OK with an error_code that is not a number'}  | ${() => failureIn200('500')}                         | ${ONCE}
      ${'401 with an HTML body'}                           | ${() => unparsable(401, 'Unauthorized')}             | ${ONCE}
      ${'401 with an empty body'}                          | ${() => unparsable(401, 'Unauthorized', '')}         | ${ONCE}
      ${'403 whose body read times out'}                   | ${() => timeoutInAnswer(403, 'Forbidden')}           | ${ONCE}
      ${'500 with an HTML body'}                           | ${() => unparsable(500, 'Internal Server Error')}    | ${BACKOFF}
      ${'503 whose body read times out'}                   | ${() => timeoutInAnswer(503, 'Service Unavailable')} | ${BACKOFF}
      ${'429 with an HTML body'}                           | ${() => unparsable(429, 'Too Many Requests')}        | ${BACKOFF}
      ${'200 OK whose body read times out'}                | ${timeoutInAnswer}                                   | ${unreadable200}
      ${'200 OK with an HTML body'}                        | ${() => unparsable(200, 'OK')}                       | ${unreadable200}
    `('sends a request that always meets $outcome at $sentAt ms', async ({ reply, sentAt }) => {
      const sent: number[] = [];
      fetchMock.mockImplementation(async () => {
        sent.push(Date.now());
        return reply();
      });
      await settle(send());
      expect(sent).toEqual(sentAt);
    });

    it('sends the same request again on a retry', async () => {
      fetchMock.mockImplementation(async () => failure(500, 'Internal Server Error'));
      await settle(send());
      expect(sentRequest(fetchMock.mock.calls[FETCHER_MAX_RETRIES])).toEqual(sentRequest(fetchMock.mock.calls[0]));
    });

    it('rejects with the error of the last attempt once the retries are spent', async () => {
      let attempts = 0;
      fetchMock.mockImplementation(async () =>
        ++attempts > FETCHER_MAX_RETRIES ? failure(503, 'Service Unavailable') : failure(500, 'Internal Server Error'),
      );
      expect(await settle(send())).toEqual(new Error('HTTP 503 Service Unavailable: Service Unavailable'));
    });

    it.each`
      outcome                      | reply                                        | message
      ${'409 Conflict'}            | ${() => failure(409, 'Conflict')}            | ${'HTTP 409 Conflict: Conflict'}
      ${'503 Service Unavailable'} | ${() => failure(503, 'Service Unavailable')} | ${'HTTP 503 Service Unavailable: Service Unavailable'}
      ${'a network failure'}       | ${networkFailure}                            | ${'fetch failed'}
      ${'a timeout'}               | ${timeoutFailure}                            | ${'The operation timed out.'}
    `('logs the $outcome it gives up on, once, at debug level', async ({ reply, message }) => {
      fetchMock.mockImplementation(async () => reply());
      await settle(send());
      expect(debug).toHaveBeenCalledExactlyOnceWith('fetcher', message);
    });

    it('rethrows a rejection that is not an Error as it is', async () => {
      fetchMock.mockImplementation(() => Promise.reject('offline'));
      expect(await settle(send())).toBe('offline');
    });

    // Only an Error was logged: a rejection of any other value was rethrown without a word
    it('logs a rejection that is not an Error it gives up on, at debug level', async () => {
      fetchMock.mockImplementation(() => Promise.reject('offline'));
      await settle(send());
      expect(debug).toHaveBeenCalledExactlyOnceWith('fetcher', 'offline');
    });

    it.each`
      outcome                               | reply
      ${'a server error'}                   | ${() => failure(500, 'Internal Server Error')}
      ${'a server error with an HTML body'} | ${() => unparsable(502, 'Bad Gateway')}
      ${'a rate limit'}                     | ${() => rateLimit(5)}
      ${'a 60 s rate limit'}                | ${() => rateLimit(60)}
      ${'a network failure'}                | ${networkFailure}
      ${'a timeout'}                        | ${timeoutFailure}
    `('returns the answer of the retry that follows $outcome', async ({ reply }) => {
      fetchMock.mockImplementationOnce(async () => reply()).mockResolvedValueOnce(answer(200, 'OK', { ok: true, result: 'sent' }));
      expect(await settle(send())).toEqual({ ok: true, result: 'sent' });
    });
  });

  it('rejects a POST whose 200 answer cannot be read with an error that tells it may have been delivered', async () => {
    fetchMock.mockImplementation(async () => timeoutInAnswer());
    expect(await settle(fetcher.post({ url, payload }))).toHaveProperty(
      'message',
      'HTTP 200 OK: unreadable body (The operation timed out.). The request may have been delivered, so it is not retried',
    );
  });

  it('rejects a GET whose 200 answer cannot be read, once its retries are spent, with the error of the last one', async () => {
    fetchMock.mockImplementation(async () => timeoutInAnswer());
    expect(await settle(fetcher.get({ url }))).toHaveProperty('message', 'HTTP 200 OK: unreadable body (The operation timed out.)');
  });

  describe('timeout', () => {
    /** AbortSignal.timeout on the fake clock, which vitest does not fake */
    const timeoutOnFakeClock = (ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(timedOut()), ms);
      return controller.signal;
    };
    /** fetch on a black-holed network: no answer ever comes, and the request only ends when its signal aborts it */
    const noAnswer = (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));

    beforeEach(() => {
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(timeoutOnFakeClock);
    });

    afterEach(() => {
      vi.restoreAllMocks(); // The AbortSignal.timeout spy
    });

    it.each`
      request                   | send                                                                   | timeout
      ${'a message'}            | ${() => fetcher.post({ url, payload })}                                | ${FETCHER_TIMEOUT}
      ${'a short poll'}         | ${() => fetcher.get({ url: `${url}/getUpdates?offset=1` })}            | ${FETCHER_TIMEOUT}
      ${'a 50 s long poll'}     | ${() => fetcher.get({ url: `${url}/getUpdates?timeout=50&offset=1` })} | ${FETCHER_TIMEOUT + 50_000}
      ${'an invalid long poll'} | ${() => fetcher.get({ url: `${url}/getUpdates?timeout=soon` })}        | ${FETCHER_TIMEOUT}
    `('gives $request $timeout ms to be answered', async ({ send, timeout }) => {
      fetchMock.mockResolvedValue(answer(200, 'OK', { ok: true }));
      await send();
      expect(AbortSignal.timeout).toHaveBeenCalledWith(timeout);
    });

    it('passes fetch the signal of the timeout', async () => {
      fetchMock.mockResolvedValue(answer(200, 'OK', { ok: true }));
      await fetcher.post({ url, payload });
      expect(fetchMock.mock.calls[0][1]?.signal).toBe(vi.mocked(AbortSignal.timeout).mock.results[0].value);
    });

    it('aborts each attempt that gets no answer after FETCHER_TIMEOUT, and retries it after the backoff', async () => {
      const sent: number[] = [];
      fetchMock.mockImplementation((input, init) => {
        sent.push(Date.now());
        return noAnswer(input, init);
      });
      await settle(fetcher.post({ url, payload }));
      expect(sent).toEqual(NO_ANSWER);
    });

    it('rejects with the TimeoutError of the last attempt once the retries are spent', async () => {
      fetchMock.mockImplementation(noAnswer);
      expect(await settle(fetcher.post({ url, payload }))).toMatchObject({ name: 'TimeoutError' });
    });
  });

  // Bun has no DOM. Without a lib in tsconfig.json, TypeScript loaded lib.dom: Response.json() resolved to any, which the fetcher
  // handed its callers as whatever type they asked for, and a stray document, length or status type-checked, to throw under Bun.
  // Checked by type:check: at run time, expectTypeOf checks nothing.
  describe('types', () => {
    it('types the JSON of an answer as unknown', () => {
      expectTypeOf<ReturnType<Response['json']>>().resolves.toBeUnknown();
    });

    it('declares none of the DOM globals document, length and status', () => {
      expectTypeOf<Extract<keyof typeof globalThis, 'document' | 'length' | 'status'>>().toBeNever();
    });
  });
});
