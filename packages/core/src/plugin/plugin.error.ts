import { GekkoError } from '@gekko/shared/errors/gekko.error';

export class PluginMissingServiceError extends GekkoError {
  constructor(pluginName: string, serviceName: string) {
    super('pipeline', `Missing ${serviceName} in ${pluginName} plugin. Did you forget to inject it in getStaticConfiguration() ?`);
    this.name = 'PluginMissingServiceError';
  }
}
