import { loadConfigurationFile } from '@gekko/core/configuration/configuration.helper';
import type { PluginRegistry } from '@gekko/core/core/pipeline/pipeline.types';
import { warning } from '@gekko/core/logger/logger';
import * as pluginRegistry from '@gekko/plugins/index';
import { configurationSchema } from '@gekko/schemas/configuration/configuration.schema';
import type { Configuration } from '@gekko/schemas/configuration/configuration.types';
import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { showValue } from '@gekko/shared/utils/object/object.utils';
import { formatEveryDecimal, listInWords, pluralize } from '@gekko/shared/utils/string/string.utils';
import * as strategyRegistry from '@gekko/strategies/index';
import type { StrategyConstructor } from '@gekko/strategies/strategy.types';
import { cloneDeep, get, isPlainObject, merge, omit, range, setWith } from 'lodash-es';
import { z } from 'zod';
import { MAX_VARIANTS, REPORTER_PLUGIN } from '../fox.const';
import type { OverrideValue, Overrides, Template, Variant } from '../fox.types';

/** An option of the command line and the values it tries: a single value is a list of one */
type Choice = { path: string[]; values: OverrideValue[] };

/** A problem of a variant, at the path of the configuration it is about */
type Issue = { message: string; path: PropertyKey[] };

/** A key that names an item of a list: its index, as JavaScript writes one (0, 12), not 01, -1, 1e0, length or a name */
const LIST_INDEX = /^(0|[1-9]\d*)$/;

// Annotated, not cast: the compiler checks that every export of the registries is a plugin class, or a strategy class whose schema, if
// any, is a zod schema
const PLUGINS: PluginRegistry = pluginRegistry;
const STRATEGIES: Record<string, StrategyConstructor> = strategyRegistry;

/**
 * The template at `path`, read as Gekko reads a configuration file (loadConfigurationFile: .yml, .yaml, .json or .json5). The loader's
 * refusals are its own (an extension it does not read, a file that does not parse, an empty one); a file it cannot read (none at the
 * path) and a file that holds no mapping of sections are refused here.
 */
export const loadTemplate = (path: string): Template => {
  let content: unknown;
  try {
    content = loadConfigurationFile(path);
  } catch (err) {
    if (err instanceof GekkoError) throw err;
    throw new GekkoError('fox', `Cannot read the template ${path}: ${describeError(err)}`, { cause: err });
  }
  if (!isPlainObject(content))
    throw new GekkoError(
      'fox',
      `Invalid template ${path}: a configuration is a mapping of its sections (watch, exchange, plugins…), got ${showValue(content)}`,
    );
  return content as Template;
};

/** The options of the overrides and their values, depth-first in the order of their keys, as the command line gave them */
const choicesOf = (overrides: Overrides, parent: string[] = []): Choice[] =>
  Object.entries(overrides).flatMap(([key, value]) => {
    const path = [...parent, key];
    if (Array.isArray(value)) return [{ path, values: value }];
    if (typeof value === 'object') return choicesOf(value, path);
    return [{ path, values: [value] }];
  });

/** Whether a plugin entry of a configuration, as a file holds it, is a PerformanceReporter's */
const isReporterEntry = (entry: unknown): entry is Record<string, unknown> =>
  isPlainObject(entry) && get(entry, 'name') === REPORTER_PLUGIN;

/** The PerformanceReporter entries of a configuration, as a file holds it: none when its plugins are not a list */
const reportersOf = (configuration: Template) =>
  Array.isArray(configuration.plugins) ? configuration.plugins.filter(isReporterEntry) : [];

/** The indexes that name the items of a list of `length` items, as a refusal writes them: 0, 0 or 1, then 0 to <last> */
const describeIndexes = (length: number) => {
  if (!length) return 'it is empty: 0 adds an item';
  return length > 2 ? `0 to ${length - 1}` : range(length).join(' or ');
};

/**
 * Refuses, before any variant is made, an option whose path enters a list of the template by a key that is not an index: lodash's
 * merge kept such a key (a symbol, an asset, the name of a plugin, 01, -1) on the array, as a property that no configuration reads, so
 * that every variant ran the template's value under the label of the value asked for, and `length` cut the list short. The template's
 * lists are the only ones to check: an option never builds one (setWith with Object), and an index past the last item adds one.
 */
const checkListKeys = (template: Template, choices: readonly Choice[]) => {
  for (const { path } of choices) {
    let node: unknown = template;
    for (const [depth, key] of path.entries()) {
      if (Array.isArray(node) && !LIST_INDEX.test(key)) {
        const list = path.slice(0, depth).join('.');
        throw new GekkoError('fox', `--${path.join('.')}: ${list} is a list, name its item by its index (${describeIndexes(node.length)})`);
      }
      // Below a value that is not an object, or a key the template lacks, the option builds what it sets: no list of the template is there
      if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) break;
      node = (node as Record<string, unknown>)[key];
    }
  }
};

/** Refuses overrides that would make more than MAX_VARIANTS variants, before any is made, naming the values of each option */
const checkVariantCount = (choices: readonly Choice[]) => {
  const count = choices.reduce((product, { values }) => product * values.length, 1);
  if (count <= MAX_VARIANTS) return;
  const factors = choices
    .filter(({ values }) => values.length > 1)
    .map(({ path, values }) => `${values.length} values of --${path.join('.')}`)
    .join(' × ');
  throw new GekkoError(
    'fox',
    `The overrides make ${formatEveryDecimal(count)} variants (${factors}), more than the ${MAX_VARIANTS} Fox makes at most: give them fewer values`,
  );
};

/**
 * The variants of `template`, one for each combination of the values of the overrides: the cartesian product of their lists and ranges,
 * the first option's values changing last (variant 1 takes the first value of every option, variant 2 the second value of the last
 * option), numbered from 1. Each is a deep copy of the template with its values merged over it (lodash's merge, so that a key set
 * inside a block keeps the block's other keys), and is labelled with the values that tell it from the others, the options of a single
 * value left out. Without overrides, the template is the one variant. A GekkoError refuses, before any variant is made, an option that
 * names an item of a list of the template by anything but its index (see checkListKeys), and more than MAX_VARIANTS variants.
 *
 * A labelled variant's PerformanceReporter entries take its label, which the reporter writes after the id of its row (the values of
 * the strategy block): without it, the rows of variants that differ outside that block (a fee, a balance) could not be told apart. An
 * entry with a label of its own keeps it.
 */
export const generateVariants = (template: Template, overrides: Overrides): Variant[] => {
  const choices = choicesOf(overrides);
  checkListKeys(template, choices);
  checkVariantCount(choices);
  const combinations = choices.reduce<OverrideValue[][]>(
    (partials, { values }) => partials.flatMap(partial => values.map(value => [...partial, value])),
    [[]],
  );
  return combinations.map((values, index) => {
    const label = choices
      .flatMap(({ path, values: tried }, position) => (tried.length > 1 ? [`--${path.join('.')} ${values[position]}`] : []))
      .join(' ');
    // setWith with Object builds plain objects for the keys of the path, numbers included: merged into an array of the template (a
    // plugin, `plugins.3.fileName`), an object of index keys sets that item and keeps the others (checkListKeys refused any other key)
    const configuration: Template = merge(
      cloneDeep(template),
      choices.reduce((variant, { path }, position) => setWith(variant, path, values[position], Object), {}),
    );
    if (label) for (const entry of reportersOf(configuration)) if (entry.label === undefined) entry.label = label;
    return { variant: index + 1, label, configuration };
  });
};

const prefixIssues = (prefix: PropertyKey[], issues: readonly Issue[]): Issue[] =>
  issues.map(({ message, path }) => ({ message, path: [...prefix, ...path] }));

/**
 * The strategy block checked as the StrategyManager checks it, without its name, by the schema of the strategy the TradingAdvisor's
 * strategyName selects. Not a strategy loaded from a strategyPath, which the worker's StrategyManager checks as it starts, nor a
 * strategy that declares no schema, whose block is never checked.
 */
const strategyIssues = (plugins: Configuration['plugins'], strategy: Configuration['strategy']): Issue[] => {
  const index = plugins.findIndex(({ name }) => name === 'TradingAdvisor');
  if (index === -1) return [];
  const { strategyName, strategyPath } = plugins[index];
  // A strategyName that is not a text is the TradingAdvisor schema's to refuse
  if (strategyPath !== undefined || typeof strategyName !== 'string') return [];
  if (!Object.hasOwn(STRATEGIES, strategyName)) {
    const names = Object.keys(STRATEGIES).sort();
    return [
      {
        message: `No strategy is named ${showValue(strategyName)}: the strategies are ${listInWords(names)}`,
        path: ['plugins', index, 'strategyName'],
      },
    ];
  }
  const { schema } = STRATEGIES[strategyName];
  return prefixIssues(['strategy'], schema?.safeParse(omit(strategy, 'name')).error?.issues ?? []);
};

/** The events a plugin entry's plugin emits: none for a name the registry does not hold, which pluginIssues refuses */
const eventsOf = ({ name }: { name: string }) => (Object.hasOwn(PLUGINS, name) ? PLUGINS[name].getStaticConfiguration().eventsEmitted : []);

/**
 * A plugin entry checked as the pipeline checks it: its name, which the registry must hold, the modes of its plugin, which must
 * include backtest (checkPluginsModesCompatibility: the CandleWriter, the EventSubscriber and Supervision do not), its options by the
 * schema of its plugin, and the events its plugin emits, which no plugin of an entry before it may emit (checkPluginsDuplicateEvents:
 * the PortfolioAnalyzer and the RoundTripAnalyzer both emit performanceReport).
 */
const pluginIssues = (entry: { name: string }, index: number, plugins: readonly { name: string }[]): Issue[] => {
  const at = ['plugins', index, 'name'];
  // Its own keys only: bundled by `bun build`, the namespace of the registry is a plain object, which inherits 'constructor'
  if (!Object.hasOwn(PLUGINS, entry.name)) {
    const names = Object.keys(PLUGINS).sort();
    return [{ message: `No plugin is named ${showValue(entry.name)}: the plugins are ${listInWords(names)}`, path: at }];
  }
  const { schema, modes } = PLUGINS[entry.name].getStaticConfiguration();
  const issues: Issue[] = modes.includes('backtest')
    ? []
    : [{ message: `Plugin ${entry.name} does not support backtest mode, only ${listInWords(modes)}`, path: at }];
  issues.push(...prefixIssues(['plugins', index], schema?.safeParse(entry).error?.issues ?? []));
  const emitted = eventsOf(entry);
  const earlier = plugins.slice(0, index).findIndex(other => eventsOf(other).some(event => emitted.includes(event)));
  if (earlier === -1) return issues;
  const shared = emitted.filter(event => eventsOf(plugins[earlier]).includes(event));
  const emitters = `${plugins[earlier].name} (plugins[${earlier}]) and ${entry.name}`;
  const message = `Plugins ${emitters} are broadcasting the same ${pluralize('event', shared.length)}: ${listInWords(shared)}. This behavior is unsupported.`;
  return [...issues, { message, path: at }];
};

/**
 * What would stop the backtest of a variant before it starts: the configuration as the schema checks it (parseConfiguration, which
 * the worker's createRunContext applies again), a mode other than backtest, then the strategy block and each plugin entry as the
 * StrategyManager and the pipeline check them. Each issue at its path from the root of the configuration (`strategy.period`,
 * `plugins[3].fileName`).
 */
const issuesOf = (configuration: Template): Issue[] => {
  const result = configurationSchema.safeParse(configuration);
  if (!result.success) return result.error.issues;
  const { watch, plugins, strategy } = result.data;
  // In realtime a variant would trade until stopped, and an import writes candles: Fox compares backtests
  const modeIssues =
    watch.mode === 'backtest'
      ? []
      : [{ message: `Fox backtests its variants: watch.mode must be backtest, got ${showValue(watch.mode)}`, path: ['watch', 'mode'] }];
  return [...modeIssues, ...strategyIssues(plugins, strategy), ...plugins.flatMap(pluginIssues)];
};

/**
 * Checks every variant before any is backtested, so that a sweep that would fail on its last variant fails at once: the first variant
 * with an issue (see issuesOf) is refused with a GekkoError naming it, its values and every issue it has, each with its path.
 */
export const validateVariants = (variants: readonly Variant[]) => {
  for (const { variant, label, configuration } of variants) {
    const issues = issuesOf(configuration);
    if (issues.length)
      throw new GekkoError('fox', `Variant ${variant}${label ? ` (${label})` : ''} is invalid:\n${z.prettifyError({ issues })}`);
  }
};

/**
 * Warns, once, of the variants without a PerformanceReporter, all of them when the template has none: no CSV row will record their
 * figures. Not refused: an analyzer logs its report at info level, and prints it as a table with enableConsoleTable, in the output of
 * each worker.
 */
export const warnOfUnreportedVariants = (variants: readonly Variant[]) => {
  const unreported = variants.filter(({ configuration }) => !reportersOf(configuration).length).map(({ variant }) => String(variant));
  const count = unreported.length;
  if (!count) return;
  warning(
    'fox',
    count === variants.length
      ? `The template has no ${REPORTER_PLUGIN}: no CSV row will record the figures of its ${pluralize('variant', count)}`
      : `${pluralize('Variant', count)} ${listInWords(unreported)} ${pluralize('has', count, 'have')} no ${REPORTER_PLUGIN}: no CSV row will record ${pluralize('its', count, 'their')} figures`,
  );
};
