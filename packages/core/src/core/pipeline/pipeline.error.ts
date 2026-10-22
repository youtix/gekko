import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { showValue } from '@gekko/shared/utils/object/object.utils';
import { listInWords, pluralize } from '@gekko/shared/utils/string/string.utils';

/**
 * An entry of `plugins[]` whose name is not a plugin of the registry: names the plugins, in alphabetical order, and the one it differs
 * from in case alone (`trader` for `Trader`). Fox checks its variants with the refusals of the pipeline, quoting their untaggedMessage at
 * the path of the entry, so that it and Gekko say the same.
 */
export class UnknownPluginError extends GekkoError {
  constructor(name: string, pluginNames: readonly string[]) {
    // Sorted here, for every caller: the namespace of a registry bundled by `bun build` is a plain object, of arbitrary key order
    const names = [...pluginNames].sort();
    const suggestion = names.find(pluginName => pluginName.toLowerCase() === name.toLowerCase());
    const didYouMean = suggestion === undefined ? '' : ` (did you mean ${showValue(suggestion)}?)`;
    super('pipeline', `No plugin is named ${showValue(name)}${didYouMean}: the plugins are ${listInWords(names)}`);
    this.name = 'UnknownPluginError';
  }
}

/** A plugin configured in a mode its static configuration does not list: names the modes it runs in */
export class PluginModeNotSupportedError extends GekkoError {
  constructor(name: string, mode: string, modes: readonly string[]) {
    super('pipeline', `Plugin ${name} does not support ${mode} mode${modes.length ? `, only ${listInWords(modes)}` : ''}`);
    this.name = 'PluginModeNotSupportedError';
  }
}

/** Plugins that emit one event: an event has a single emitter, to whose listeners the pipeline wires it by name */
export class PluginsEmitSameEventError extends GekkoError {
  constructor(pluginNames: readonly string[], events: readonly string[]) {
    super(
      'pipeline',
      `Plugins ${listInWords(pluginNames)} are broadcasting the same ${pluralize('event', events.length)}: ${listInWords(events)}. This behavior is unsupported.`,
    );
    this.name = 'PluginsEmitSameEventError';
  }
}
