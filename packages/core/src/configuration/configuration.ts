import { Configuration } from '../run/configuration';
import { getCurrentRunContext } from '../run/currentRun.helper';
import type { ConfigurationReader } from '../run/runContext.types';
import { readConfigurationFromEnvironment } from './configuration.helper';

// Transitional, for the monorepo wave: the `config` singleton the modules not yet converted to a RunContext read. It reads the
// configuration of the run in progress (setCurrentRunContext) or, for a run started without one (the executable until its main()
// builds one), the file GEKKO_CONFIG_FILE_PATH names, as the singleton did. This module goes once no module imports it: the class
// lives in run/configuration.ts, the file helpers in configuration.helper.ts.

let fallback: Configuration | undefined;

const currentConfiguration = () =>
  getCurrentRunContext()?.configuration ?? (fallback ??= new Configuration(readConfigurationFromEnvironment()));

/** @deprecated Transitional: receive the configuration through the RunContext instead (constructor injection, see CLAUDE.md). */
export const config: ConfigurationReader = {
  showLogo: () => currentConfiguration().showLogo(),
  getPlugins: () => currentConfiguration().getPlugins(),
  getStrategy: () => currentConfiguration().getStrategy(),
  getWatch: () => currentConfiguration().getWatch(),
  getStorage: () => currentConfiguration().getStorage(),
  getExchange: () => currentConfiguration().getExchange(),
};
