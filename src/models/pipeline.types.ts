import type { Plugin } from '@plugins/plugin';
import { z } from 'zod';

/**
 * The options of a plugin: its entry of the configuration as its own schema outputs it (see validatePluginsSchema), with its defaults
 * applied. Every entry has a name, which every plugin schema, strict, declares.
 */
export type PluginParameters = { name: string; [option: string]: unknown };

/**
 * A plugin class as createPlugins builds it, from its options. Each class takes the output of its own schema, which the pipeline pairs
 * with it by name at run time: a pairing no type of the union of the plugin classes expresses, a call on that union taking only an
 * object that holds the options of every plugin at once. Asserting the class to this type still refuses a constructor that takes
 * anything but an object of options.
 */
export type PluginConstructor = new (parameters?: PluginParameters) => Plugin;

/** The options of gekkoPipeline, which main() runs without any */
export type GekkoPipelineOptions = {
  /** Ends the run once aborted (see gekkoPipeline) */
  signal?: AbortSignal;
};

export type PipelineContext = {
  name: string;
  plugin?: Plugin;
  /** Its options, once validatePluginsSchema has parsed its entry: undefined for a plugin without schema */
  parameters?: PluginParameters;
  eventsEmitted?: string[];
  eventsHandlers?: string[];
  dependencies?: string[];
  inject?: string[];
  modes?: string[];
  schema?: z.ZodTypeAny;
}[];
