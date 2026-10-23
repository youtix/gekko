import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { showValue } from '@gekko/shared/utils/object/object.utils';
import { formatEveryDecimal } from '@gekko/shared/utils/string/string.utils';
import { Command, CommanderError } from 'commander';
import { setWith, uniq } from 'lodash-es';
import { availableParallelism } from 'node:os';
import { FORBIDDEN_KEYS, MAX_VARIANTS, MAX_WORKERS_VARIABLE, PROGRAM_DESCRIPTION, TEMPLATE_PATH_VARIABLE, VALUES_HELP } from '../fox.const';
import type { FoxOptions, OverrideValue, Overrides } from '../fox.types';

/** A number as the command line writes one: digits, a minus sign before them, and a decimal point between them */
const NUMBER = /^-?\d+(\.\d+)?$/;

/** A whole number as the command line writes one */
const WHOLE_NUMBER = /^\d+$/;

/**
 * A number as the command line or String writes it, as the integer of its digits and the decimals that integer is scaled by: 12.50 is
 * 125 at 1 decimal, the trailing zeros of its decimals left out as String leaves them out, 1.5e-7 is 15 at 8 and 1e21 is 1 at -21.
 */
type Decimal = { digits: bigint; decimals: number };

/**
 * Whether an item of a value is a range: it starts like a number, with a digit or a minus sign then a digit, and holds `..`, but no
 * path separator. So `run..2`, `..` and `../db/x.sql` are texts, a path such as `2024..old/x.sql` too, and `12..`, which starts like
 * a range, is refused as one.
 */
const isRange = (item: string) => /^-?\d/.test(item) && item.includes('..') && !/[/\\]/.test(item);

/** A number as the command line (`-12.50`) or String (`1.5e-7`, `1e+21`) writes it, as a Decimal: exactly, whatever its digits */
const parseDecimal = (text: string): Decimal => {
  const [mantissa, exponent = '0'] = text.split('e');
  const [integer, fraction = ''] = mantissa.split('.');
  const decimals = fraction.replace(/0+$/, '');
  return { digits: BigInt(`${integer}${decimals}`), decimals: decimals.length - Number(exponent) };
};

/** The integer `value` makes scaled to `decimals` decimals, which must be at least its own: 1.5 is 15 at 1 decimal, 1500 at 3 */
const scaleTo = ({ digits, decimals: own }: Decimal, decimals: number) => digits * 10n ** BigInt(decimals - own);

/** Whether two Decimals are one number, whatever their scales: 15 at 1 decimal and 150 at 2 are both 1.5 */
const isSameNumber = (a: Decimal, b: Decimal) => {
  const decimals = Math.max(a.decimals, b.decimals);
  return scaleTo(a, decimals) === scaleTo(b, decimals);
};

/**
 * The number `value` stands for: the double nearest to it, and whether that double holds it as it is written, String writing it
 * back. A number keeps some 15 significant digits: 9007199254740993 is read as 9007199254740992 and 0.30000000000000005 as
 * 0.30000000000000004, which the command line would have set in its place without a word.
 */
const toNumber = (value: Decimal) => {
  const number = Number(`${value.digits}e${-value.decimals}`);
  return { number, isHeld: Number.isFinite(number) && isSameNumber(parseDecimal(String(number)), value) };
};

/** Why a number of the command line is refused when no number holds it as written, and what it would have been read as */
const describeUnheld = (number: number) => `more digits than a number keeps, which reads it as ${formatEveryDecimal(number)}`;

/**
 * A single value as the command line writes it at `option`: true and false are booleans, a number is a number, anything else is a
 * text. A number that no number holds as it is written is refused, rather than set as another.
 */
const toValue = (option: string, text: string): OverrideValue => {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (!NUMBER.test(text)) return text;
  const { number, isHeld } = toNumber(parseDecimal(text));
  if (isHeld) return number;
  throw new GekkoError(
    'fox',
    `Invalid value ${showValue(text)} of ${option}: it holds ${describeUnheld(number)}: write it with fewer digits`,
  );
};

/** `scaled`, a number scaled to `decimals` decimals, written as the command line writes a number: -5 at 2 decimals is -0.05 */
const writeScaled = (scaled: bigint, decimals: number) => {
  const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(decimals + 1, '0');
  const point = digits.length - decimals;
  const fraction = digits.slice(point).replace(/0+$/, '');
  return `${scaled < 0n ? '-' : ''}${digits.slice(0, point)}${fraction && `.${fraction}`}`;
};

/**
 * The values of a range, `<from>..<to>` or `<from>..<to>:<step>`: from its start, a step at a time, up to its end, both bounds included
 * (`12..24:5` is 12, 17, 22 and 24). Without a step, it is a unit of the last decimal of the bounds: 1 for `12..24`, 0.01 for
 * `0.5..0.75`. The range is counted and its values worked out in integers, the bounds and the step scaled to their decimals, so that
 * each value is the decimal written, not a binary sum (`0.1..0.3` holds 0.3, `0.6..3000.3:0.3` its 10000 values). Refused before any
 * value is made: a range of more than MAX_VARIANTS values, and a range holding a value that no number holds as it is written, which Fox
 * would have tried in place of another, a bound (9007199254740993, read as 9007199254740992) or a value its step makes (bounds of 17
 * significant digits, which take a step of 1e-17 by default; a step below what its values can change by; whole numbers beyond 2 ** 53,
 * where a number no longer changes by 1).
 */
const parseRange = (option: string, range: string): number[] => {
  const refuse = (reason: string) => new GekkoError('fox', `Invalid range ${showValue(range)} of ${option}: ${reason}`);
  const [bounds, stepText, ...afterStep] = range.split(':');
  const [fromText, toText, ...afterEnd] = bounds.split('..');
  if (afterEnd.length || afterStep.length || !NUMBER.test(fromText) || !NUMBER.test(toText))
    throw refuse('a range is written <from>..<to> or <from>..<to>:<step>, of numbers');
  const [from, to] = [fromText, toText].map(parseDecimal);
  const boundDecimals = Math.max(from.decimals, to.decimals);
  if (scaleTo(from, boundDecimals) > scaleTo(to, boundDecimals)) throw refuse(`its start, ${fromText}, is above its end, ${toText}`);
  const step = stepText !== undefined && NUMBER.test(stepText) ? parseDecimal(stepText) : undefined;
  if (stepText !== undefined && !(step && step.digits > 0n)) throw refuse(`its step must be a number above 0, got ${showValue(stepText)}`);
  // A range of whole numbers steps by 1, those ending in zeros too (20..30): the integer part of a number counts no decimal
  const decimals = Math.max(boundDecimals, step?.decimals ?? 0);
  const [start, end] = [from, to].map(bound => scaleTo(bound, decimals));
  const increment = step ? scaleTo(step, decimals) : 1n;
  /** The number of a bound, refused when no number holds it as written */
  const boundNumber = (value: bigint, name: string, text: string) => {
    const { number, isHeld } = toNumber({ digits: value, decimals });
    if (isHeld) return number;
    throw refuse(`its ${name}, ${text}, holds ${describeUnheld(number)}: write it with fewer digits`);
  };
  /** The number of a value the step makes, refused when no number holds it as written */
  const steppedNumber = (value: bigint) => {
    const { number, isHeld } = toNumber({ digits: value, decimals });
    if (isHeld) return number;
    throw refuse(
      `its step of ${writeScaled(increment, decimals)} makes ${writeScaled(value, decimals)}, ${describeUnheld(number)}: write the bounds with fewer digits, or give a larger step`,
    );
  };
  const first = boundNumber(start, 'start', fromText);
  const last = boundNumber(end, 'end', toText);
  // The value after the start before the count: a step too small for the digits of the bounds (0.30000000000000004..0.5, whose step
  // is 1e-17 by default) makes values no number holds, of which the count would only say that they are too many
  if (start + increment < end) steppedNumber(start + increment);
  // The steps below the end, rounded up (a step that goes past the end leaves the end to be tried on its own), then the end
  const count = (end - start + increment - 1n) / increment + 1n;
  if (count > BigInt(MAX_VARIANTS))
    throw refuse(`it holds ${count} values, more than the ${MAX_VARIANTS} variants Fox makes at most: narrow it, or give it a larger step`);
  const values = [first];
  for (let value = start + increment; value < end; value += increment) values.push(steppedNumber(value));
  // The end is always tried, also when the step goes past it
  if (end > start) values.push(last);
  return values;
};

/**
 * The values `text` sets at `option`: a single value as itself, a list (items separated by commas) or a range as the array of their
 * values. An item of a list can be a range (`10,20..30:5`). A value that two items give (`10,10..12`, `1..10:3,10..30:10`) is tried
 * once, at its first place: twice, it made two variants of one backtest, labelled alike.
 */
const parseValues = (option: string, text: string): OverrideValue | OverrideValue[] => {
  const items = text.split(',').map(item => item.trim());
  if (items.some(item => item === '')) {
    throw new GekkoError(
      'fox',
      items.length === 1 ? `${option} has no value` : `${option} has an empty item in its values ${showValue(text)}`,
    );
  }
  if (items.length === 1 && !isRange(items[0])) return toValue(option, items[0]);
  return uniq(items.flatMap(item => (isRange(item) ? parseRange(option, item) : [toValue(option, item)])));
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
 * and `--strategy.thresholds.up`), and a malformed range. A bare `--`, the end of Fox's own options, is skipped wherever it is:
 * commander drops the first one when no override comes before it, and leaves it among the overrides otherwise.
 */
export const parseOverrides = (argv: readonly string[]): Overrides => {
  const overrides: Overrides = {};
  const keys: string[] = [];
  const args = argv.filter(argument => argument !== '--');
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
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
    const next = args[index + 1];
    if (equals === -1 && (next === undefined || next.startsWith('--'))) throw new GekkoError('fox', `${option} has no value`);
    const text = equals === -1 ? args[++index] : argument.slice(equals + 1);
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
    // what it refuses. Anything else is no refusal of the command line, and passes on as it is, for its stack to be reported
    if (!(err instanceof CommanderError)) throw err;
    if (err.exitCode === 0) return undefined;
    throw new GekkoError('fox', err.message.replace(/^error: /, ''));
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
