import type { Configuration } from './configuration';
import type { Services } from './services';

/** What a run reads of its configuration: the getters of Configuration, which a test can stand in for with a literal */
export type ConfigurationReader = Pick<
  Configuration,
  'showLogo' | 'getPlugins' | 'getStrategy' | 'getWatch' | 'getStorage' | 'getExchange'
>;

/** The services a run shares, built once from its configuration: the exchange and the storage (see Services) */
export type ServiceProvider = Pick<Services, 'exchange' | 'storage' | 'closeStorage'>;

/**
 * Everything a run reads that no module reads from the environment: its configuration and the services built from it. Built by
 * createRunContext (one per run: the executable's, a Fox worker's, a test's), handed to gekkoPipeline and, by it, to every plugin's
 * constructor and down to the streams, the orders, the exchange and the storage. No module-level singleton holds one.
 */
export type RunContext = {
  readonly configuration: ConfigurationReader;
  readonly services: ServiceProvider;
};
