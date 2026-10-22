/** The environment variable that gives the template when --template-path does not */
export const TEMPLATE_PATH_VARIABLE = 'FOX_TEMPLATE_PATH';

/** The environment variable that gives the most variants backtested at once when --max-workers does not */
export const MAX_WORKERS_VARIABLE = 'FOX_MAX_WORKERS';

/** What Fox does, one paragraph, which commander wraps to the width of the terminal */
export const PROGRAM_DESCRIPTION = [
  'Backtests the variants of a Gekko configuration template, several at a time. Each --<key> <values> option sets the key of the',
  'template its path names, written with dots (--strategy.period): a single value sets it in every variant, and a list or a range of',
  'values makes a variant of each, one per combination of the values of every option.',
].join(' ');

/** The help printed after the options: how the values of an override are written */
export const VALUES_HELP = `
Values:
  --strategy.period 14          14, in every variant
  --strategy.period 12,24       12 and 24, a variant each
  --strategy.period 12..24      every number from 12 to 24, both included, a step of 1
  --strategy.period 12..24:4    12, 16, 20 and 24, a step of 4
  --strategy.period 10,20..30:5 a list holding a range: 10, 20, 25 and 30
  --strategy.src close,ohlc4    texts (true and false are booleans, a path such as ../db/x.sql a text)

Example:
  fox --template-path apps/fox/templates/dema.yml --strategy.period 10..30:5 --strategy.thresholds.up 50,100

Fox logs at the level GEKKO_LOG_LEVEL sets, error by default: set it to info to follow the variants.`;

/** The worker's module beside worker.helper.ts, where a run from source finds it */
export const WORKER_MODULE = './gekko.worker.ts';

/**
 * The worker's module in the compiled executable, which embeds it as an entry point of its own (see build:exec): Bun resolves it from
 * the root of the bundle, the directory of src/fox.ts, whatever module creates the worker
 */
export const COMPILED_WORKER_MODULE = './worker/gekko.worker.ts';

/** How the URL of a module of the compiled executable starts: Bun serves its modules from a virtual file system */
export const COMPILED_MODULE_URL_PREFIX = 'file:///$bunfs/';

/** The keys lodash's set and merge skip without a word: an override of one would set nothing */
export const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
