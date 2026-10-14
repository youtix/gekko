/**
 * The wait in ms before another attempt, after the attempt numbered `attempt` failed, the attempts numbered from 0, the first one:
 * baseDelay × log2(attempt + 2), at most maxDelay. By default 1000 ms after the first attempt, then 1585, 2000 and 2322 ms, and 3000
 * from attempt 6 on. The fetcher and the exchange's retry both number their attempts so: numbered from 1, the first wait would be 1585.
 */
export const getRetryDelay = (attempt: number, baseDelay: number = 1000, maxDelay: number = 3000) =>
  Math.min(baseDelay * Math.log2(attempt + 2), maxDelay);
