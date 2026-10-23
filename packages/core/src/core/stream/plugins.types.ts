import { Plugin } from '../../plugin/plugin';

/** A plugin that failed on a bucket or in its finalisation, and what it threw */
export type PluginFailure = { plugin: Plugin; reason: unknown };
