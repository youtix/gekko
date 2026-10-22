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

/** What the main thread posts to a worker: the variant to backtest */
export type VariantRequest = Pick<Variant, 'variant' | 'configuration'>;

/** What a worker posts back once the backtest of its variant is over, and what runWorker makes of a worker that failed to post it */
export type VariantResult = {
  variant: number;
  status: 'done' | 'failed';
  /** Why it failed, as describeError writes it */
  error?: string;
  /** From the start of the backtest to its end */
  durationMs: number;
};
