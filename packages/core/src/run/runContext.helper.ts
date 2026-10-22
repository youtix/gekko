import { parseConfiguration } from '../configuration/configuration.helper';
import { Configuration } from '../configuration/configuration';
import type { RunContext } from './runContext.types';
import { Services } from './services';

/**
 * The context of a run, from a configuration as a file holds it (`raw`: the object a YAML or JSON file parses to, or one built in
 * memory, as Fox builds its variants), checked by the configuration schema. `source` names where it came from in the refusal of an
 * invalid one: `file ./config/backtest.yml` (readConfigurationFile passes it), `variant 12`, or `object` by default.
 */
export const createRunContext = (raw: unknown, source = 'object'): RunContext => {
  const configuration = new Configuration(parseConfiguration(raw, source));
  return { configuration, services: new Services(configuration) };
};
