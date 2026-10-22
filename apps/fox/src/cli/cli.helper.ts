import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { addPrecise } from '@gekko/shared/utils/math/math.utils';
import { countDecimals } from '@gekko/shared/utils/math/round.utils';
import { showValue } from '@gekko/shared/utils/object/object.utils';
import { Command, type CommanderError } from 'commander';
import { setWith } from 'lodash-es';
import { availableParallelism } from 'node:os';
import { FORBIDDEN_KEYS, MAX_WORKERS_VARIABLE, PROGRAM_DESCRIPTION, TEMPLATE_PATH_VARIABLE, VALUES_HELP } from '../fox.const';
import type { FoxOptions, OverrideValue, Overrides } from '../fox.types';

/** A number as the command line writes one: digits, a minus sign before them, and a decimal point between them */
const NUMBER = /^-?\d+(\.\d+)?$/;

/** A whole number as the command line writes one */
const WHOLE_NUMBER = /^\d+$/;

/**
 * Whether an item of a value is a range: it holds `..`, but no path separator, so that a path such as ../db/x.sql stays a text.
 */
const isRange = (item: string) => item.includes('..') && !/[/\\]/.test(item);

/** A single value as the command line writes it: true and false are booleans, a number is a number, anything else is a text */
const toValue = (text: string): OverrideValue => {
  if (text === 'true') return true;
  if (text === 'false') return false;
  return NUMBER.test(text) ? Number(text) : text;
};

/**
 * The values of a range, `<from>..<to>` or `<from>..<to>:<step>`: from its start, a step at a time, up to its end, both bounds included
 * (`12..24:5` is 12, 17, 22 and 24). Without a step, it is a unit of the last decimal of the bounds: 1 for `12..24`, 0.01 for
 * `0.5..0.75`. Each value is added up in decimal (addPrecise), so that `0.1..0.3` holds 0.3, which binary sums would miss.
 */
const parseRange = (option: string, range: string): number[] => {
  const refuse = (reason: string) => new GekkoError('fox', `Invalid range ${showValue(range)} of ${option}: ${reason}`);
  const [bounds, step, ...afterStep] = range.split(':');
  const [from, to, ...afterEnd] = bounds.split('..');
  if (afterEnd.length || afterStep.length || !NUMBER.test(from) || !NUMBER.test(to))
    throw refuse('a range is written <from>..<to> or <from>..<to>:<step>, of numbers');
  const start = Number(from);
  const end = Number(to);
  if (start > end) throw refuse(`its start, ${from}, is above its end, ${to}`);
  if (step !== undefined && !(NUMBER.test(step) && Number(step) > 0))
    throw refuse(`its step must be a number above 0, got ${showValue(step)}`);
  // countDecimals is negative for a whole number ending in zeros (-1 for 20): a range of whole numbers steps by 1, not by 10
  const increment = step === undefined ? 10 ** -Math.max(0, countDecimals(start), countDecimals(end)) : Number(step);
  const values: number[] = [];
  for (let value = start; value < end; value = addPrecise(value, increment)) values.push(value);
  // The end is always tried, also when the step goes past it
  values.push(end);
  return values;
};

/**
 * The values `text` sets at `option`: a single value as itself, a list (items separated by commas) or a range as the array of their
 * values. An item of a list can be a range (`10,20..30:5`).
 */
const parseValues = (option: string, text: string): OverrideValue | OverrideValue[] => {
  const items = text.split(',').map(item => item.trim());
  if (items.some(item => item === '')) {
    throw new GekkoError(
      'fox',
      items.length === 1 ? `${option} has no value` : `${option} has an empty item in its values ${showValue(text)}`,
    );
  }
  if (items.length === 1 && !isRange(items[0])) return toValue(items[0]);
  return items.flatMap(item => (isRange(item) ? parseRange(option, item) : [toValue(item)]));
};

/** The key of an override, `strategy.period` for `--strategy.period` and `--strategy.period=12`, checked */
const parseKey = (argument: string, key: string): string[] => {
  const path = key.split('.');
  if (path.some(name => name === ''))
    throw new GekkoError(
      'fox',
      `Invalid option ${showValue(argument)}: an override names a key of the template, written with dots (--strategy.period)`,
    );
  const forbidden = path.find(name => FORBIDDEN_KEYS.includes(name));
  if (forbidden) throw new GekkoError('fox', `Invalid option ${showValue(argument)}: ${forbidden} is the key of no configuration`);
  return path;
};

/**
 * The overrides of the command line: what is left of it once commander has read Fox's own options. Each is `--<key> <values>` or
 * `--<key>=<values>`, its key a path of the template written with dots, its values a single value, a list or a range (see parseValues).
 * `--strategy.period 12,24` is `{ strategy: { period: [12, 24] } }`, `--strategy.period 12..24` the 13 values of the range and
 * `--strategy.period 12` 12 alone. A GekkoError refuses an argument that is neither an override nor its values (a value written after
 * the first, `--strategy.period 12 24`), an override without values, a key given twice or inside another one (`--strategy.thresholds`
 * and `--strategy.thresholds.up`), and a malformed range.
 */
export const parseOverrides = (argv: readonly string[]): Overrides => {
  const overrides: Overrides = {};
  const keys: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--'))
      throw new GekkoError(
        'fox',
        `Unexpected argument ${showValue(argument)}: an override is written --<key> <values> (--strategy.period 12,24)`,
      );
    const equals = argument.indexOf('=');
    const key = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    const path = parseKey(argument, key);
    const option = `--${key}`;
    const given = keys.find(other => other === key || other.startsWith(`${key}.`) || key.startsWith(`${other}.`));
    if (given === key) throw new GekkoError('fox', `${option} is given twice`);
    if (given) throw new GekkoError('fox', `--${given} and ${option} overlap, one holding the other: give one of them`);
    keys.push(key);
    // Without =, the values are the next argument, unless it is another option: a negative number starts with a single dash
    const next = argv[index + 1];
    if (equals === -1 && (next === undefined || next.startsWith('--'))) throw new GekkoError('fox', `${option} has no value`);
    const text = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    setWith(overrides, path, parseValues(option, text), Object);
  }
  return overrides;
};

/**
 * Fox's command line: its two options, the help, and the overrides, which commander leaves in `args`, unknown options and their values
 * alike, for parseOverrides to read. commander throws instead of exiting (exitOverride), and prints none of its errors, which
 * parseCommandLine reports as a GekkoError, as Fox reports every other failure.
 */
export const createProgram = (threads: number) =>
  new Command('fox')
    .usage('[options] [--<key> <values>...]')
    .description(PROGRAM_DESCRIPTION)
    .option(
      '-t, --template-path <path>',
      `the template, a backtest configuration (.yml, .yaml, .json or .json5); ${TEMPLATE_PATH_VARIABLE} by default`,
    )
    .option(
      '-w, --max-workers <count>',
      `the most variants backtested at once; ${MAX_WORKERS_VARIABLE} by default, else ${threads}, the threads of the machine`,
    )
    .addHelpText('after', VALUES_HELP)
    .allowUnknownOption()
    .allowExcessArguments()
    .exitOverride()
    .configureOutput({ outputError: () => {} });

/** A count of workers, as --max-workers or FOX_MAX_WORKERS writes it: a whole number of at least 1 */
const toMaxWorkers = (text: string, source: string) => {
  if (!WHOLE_NUMBER.test(text.trim()) || Number(text) < 1)
    throw new GekkoError('fox', `${source} must be a whole number of at least 1, got ${showValue(text)}`);
  return Number(text);
};

/** The most variants backtested at once: --max-workers, else FOX_MAX_WORKERS when it is set and not empty, else `threads` */
const resolveMaxWorkers = (option: string | undefined, variable: string | undefined, threads: number) => {
  if (option !== undefined) return toMaxWorkers(option, '--max-workers');
  if (variable) return toMaxWorkers(variable, MAX_WORKERS_VARIABLE);
  return threads;
};

/**
 * What the command line asks of Fox, its options given on the command line or else by their environment variable: the template
 * (required), the most variants backtested at once (by default the threads of the machine, `threads`), and the overrides. Undefined
 * once the help is printed (--help), for Fox to exit with code 0. A GekkoError refuses what commander refuses (an option without its
 * value), a missing template, a count of workers that is not a whole number above 0 and the overrides parseOverrides refuses.
 */
export const parseCommandLine = (
  argv: readonly string[],
  env: Record<string, string | undefined>,
  threads = availableParallelism(),
): FoxOptions | undefined => {
  const program = createProgram(threads);
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    // Under exitOverride, commander throws a CommanderError where it would have exited: with code 0 once it printed the help, 1 for
    // what it refuses (it has no action handler or argument parser to throw anything else)
    const { exitCode, message } = err as CommanderError;
    if (exitCode === 0) return undefined;
    throw new GekkoError('fox', message.replace(/^error: /, ''));
  }
  const { templatePath, maxWorkers } = program.opts<{ templatePath?: string; maxWorkers?: string }>();
  const template = templatePath || env[TEMPLATE_PATH_VARIABLE];
  if (!template) throw new GekkoError('fox', `No template: give its path with --template-path <path> or ${TEMPLATE_PATH_VARIABLE}`);
  return {
    templatePath: template,
    maxWorkers: resolveMaxWorkers(maxWorkers, env[MAX_WORKERS_VARIABLE], threads),
    overrides: parseOverrides(program.args),
  };
};
