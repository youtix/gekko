import { GekkoError } from '@gekko/shared/errors/gekko.error';

/**
 * The exchange refused the order: amount, price or cost out of its rules, insufficient funds, malformed request. Sent again, it
 * would be refused again, so the order ends rejected.
 */
export class InvalidOrder extends GekkoError {
  constructor(message: string, options?: ErrorOptions) {
    super('exchange', message, options);
    this.name = 'InvalidOrder';
  }
}

/** The exchange does not know the order: it was never placed, or it is already filled or canceled. */
export class OrderNotFound extends GekkoError {
  constructor(message: string, options?: ErrorOptions) {
    super('exchange', message, options);
    this.name = 'OrderNotFound';
  }
}

/**
 * A transport-level failure (timeout, 5xx, rate limit, DNS...) that outlived the retries, or that hit a call which is never
 * retried (order creation, order cancelation). The exchange may or may not have processed the request: the caller decides
 * whether the outcome can be learned later (polling) or must be reported as unknown.
 */
export class ExchangeNetworkError extends GekkoError {
  constructor(message: string, options?: ErrorOptions) {
    super('exchange', message, options);
    this.name = 'ExchangeNetworkError';
  }
}

/**
 * The creation of an order went through, or may have, but left nothing to follow the order by: the exchange answered it with neither
 * a status nor an id, or with a failure that is not a refusal (an internal error of the exchange, an answer ccxt could not read), or
 * the state of the order it created could not be read back. Not a refusal: the order may be live on the exchange, and placed again
 * it could be doubled. The orders end with it as with a creation lost on the network (see Order.orderErroredAtCreation). The
 * read-back of a creation used to throw its own failure: an InvalidOrder made the order a refusal, and any other one an error said to
 * have placed nothing.
 */
export class OrderOutcomeUnknown extends GekkoError {
  constructor(message: string, options?: ErrorOptions) {
    super('exchange', message, options);
    this.name = 'OrderOutcomeUnknown';
  }
}
