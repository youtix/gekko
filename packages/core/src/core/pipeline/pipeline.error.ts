import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { pluralize } from '@gekko/shared/utils/string/string.utils';

export class PluginsEmitSameEventError extends GekkoError {
  constructor(pluginNames: string[], events: string[]) {
    const plgNames = pluginNames.join(',');
    const evtNames = events.join(' ');
    super(
      'pipeline',
      `Multiple plugins (${plgNames}) are broadcasting the same ${pluralize('event', events.length)}: ${evtNames}. This behavior is unsupported.`,
    );
    this.name = 'PluginsEmitSameEventError';
  }
}
