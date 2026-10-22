import { loadConfigurationFile } from '@gekko/core/configuration/configuration.helper';
import type { PluginRegistry } from '@gekko/core/core/pipeline/pipeline.types';
import * as pluginRegistry from '@gekko/plugins/index';
import { configurationSchema } from '@gekko/schemas/configuration/configuration.schema';
import type { Configuration } from '@gekko/schemas/configuration/configuration.types';
import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { showValue } from '@gekko/shared/utils/object/object.utils';
import { listInWords } from '@gekko/shared/utils/string/string.utils';
import * as strategyRegistry from '@gekko/strategies/index';
import type { StrategyConstructor } from '@gekko/strategies/strategy.types';
import { cloneDeep, isPlainObject, merge, omit, setWith } from 'lodash-es';
import { z } from 'zod';
import type { OverrideValue, Overrides, Template, Variant } from '../fox.types';

/** An option of the command line and the values it tries: a single value is a list of one */
type Choice = { path: string[]; values: OverrideValue[] };

/** A problem of a variant, at the path of the configuration it is about */
type Issue = { message: string; path: PropertyKey[] };

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

/**
 * The variants of `template`, one for each combination of the values of the overrides: the cartesian product of their lists and ranges,
 * the first option's values changing last (variant 1 takes the first value of every option, variant 2 the second value of the last
 * option), numbered from 1. Each is a deep copy of the template with its values merged over it (lodash's merge, so that a key set
 * inside a block keeps the block's other keys), and is labelled with the values that tell it from the others, the options of a single
 * value left out. Without overrides, the template is the one variant.
 */
export const generateVariants = (template: Template, overrides: Overrides): Variant[] => {
  const choices = choicesOf(overrides);
  const combinations = choices.reduce<OverrideValue[][]>(
    (partials, { values }) => partials.flatMap(partial => values.map(value => [...partial, value])),
    [[]],
  );
  return combinations.map((values, index) => ({
    variant: index + 1,
    label: choices
      .flatMap(({ path, values: tried }, position) => (tried.length > 1 ? [`--${path.join('.')} ${values[position]}`] : []))
      .join(' '),
    // setWith with Object builds plain objects for the keys of the path, numbers included: merged into an array of the template (a
    // plugin, `plugins.3.fileName`), an object of index keys sets that item and keeps the others
    configuration: merge(
      cloneDeep(template),
      choices.reduce((variant, { path }, position) => setWith(variant, path, values[position], Object), {}),
    ),
  }));
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

/** A plugin entry checked by the schema of its plugin, as the pipeline checks it */
const pluginIssues = (entry: { name: string }, index: number): Issue[] => {
  // Its own keys only: bundled by `bun build`, the namespace of the registry is a plain object, which inherits 'constructor'
  if (!Object.hasOwn(PLUGINS, entry.name)) {
    const names = Object.keys(PLUGINS).sort();
    return [
      { message: `No plugin is named ${showValue(entry.name)}: the plugins are ${listInWords(names)}`, path: ['plugins', index, 'name'] },
    ];
  }
  const { schema } = PLUGINS[entry.name].getStaticConfiguration();
  return prefixIssues(['plugins', index], schema?.safeParse(entry).error?.issues ?? []);
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
