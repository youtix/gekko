/** A configuration as a file holds it, before the schema checks it: the template, and each variant made from it */
export type Template = Record<string, unknown>;

/** A value the command line sets: a number, a boolean or a text, as parseOverrides reads what it writes */
export type OverrideValue = string | number | boolean;

/**
 * The overrides of the command line, shaped as the configuration they override: `--strategy.period 12,24` is
 * `{ strategy: { period: [12, 24] } }`. A key holds a single value, the values of a list or a range (an array, one variant each), or
 * the keys below it.
 */
export type Overrides = { [key: string]: OverrideValue | OverrideValue[] | Overrides };

/** What the command line asks of Fox */
export type FoxOptions = {
  /** The template, a backtest configuration, as --template-path or FOX_TEMPLATE_PATH gives its path */
  templatePath: string;
  /** The most variants backtested at once */
  maxWorkers: number;
  overrides: Overrides;
};

/** One configuration Fox backtests: the template, with one value of each override set at its key */
export type Variant = {
  /** Its number, from 1, in the order generateVariants makes them */
  variant: number;
  /** The values that tell it from the other variants, as the command line writes them (`--strategy.period 14`): '' for none */
  label: string;
  configuration: Template;
};

/**
 * What the main thread posts to a worker: the variant to backtest, and the lock of stdout the main thread shares (shareWriteLock),
 * under which the worker writes its lines (useWriteLock), so that no thread's line lands among the parts of another's
 */
export type VariantRequest = Pick<Variant, 'variant' | 'configuration'> & { writeLock: SharedArrayBuffer };

/** What a worker posts back once the backtest of its variant is over, and what runWorker makes of a worker that failed to post it */
export type VariantResult = VariantOutcome & {
  variant: number;
  /** From the start of the backtest to its end */
  durationMs: number;
};

/**
 * How the backtest of a variant ended, as the bot's main() ends a run: done; stopped, as the bot stops in good order and exits 0 (the
 * circuit breaker's ApplicationStopError, whatever rejection the run left unhandled and whatever close of its storage failed, but not
 * after an uncaught exception, on which the bot exits 1 at once); or failed, as the bot exits 1
 */
export type VariantOutcome =
  | { status: 'done' }
  | {
      status: 'stopped';
      /**
       * Why it stopped: the message of the ApplicationStopError with its tag, as the bot logs it, then the other failures as
       * describeError writes them, separated by semicolons (`[STRATEGY] Max consecutive order errors reached (5); Unhandled rejection: …`)
       */
      reason: string;
    }
  | {
      status: 'failed';
      /** Why it failed, as describeError writes each failure, separated by semicolons */
      error: string;
      /**
       * What its message does not say, as the bot's main() logs the failure (describeFailure): the stack of a failure that is not a
       * GekkoError (an exception in a strategy's hook) and the causes of any, down to the root, the errors of an AggregateError included
       * (a strategy's exception in end(), which the pipeline wraps). Left out for a GekkoError without a cause, whose message says it all.
       */
      stack?: string;
    };
