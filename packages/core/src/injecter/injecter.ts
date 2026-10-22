import { config } from '../configuration/configuration';
import { getCurrentRunContext, setCurrentRunContext } from '../run/currentRun.helper';
import { Services } from '../run/services';

// Transitional, for the monorepo wave: the `inject` singleton the modules not yet converted to a RunContext read. It hands out the
// services of the run in progress (setCurrentRunContext) or, for a run started without one, those built from the configuration the
// `config` singleton reads. This module goes once no module imports it.

let fallback: Services | undefined;

const currentServices = () => getCurrentRunContext()?.services ?? (fallback ??= new Services(config));

/** @deprecated Transitional: take the exchange or the storage from `context.services` instead (see CLAUDE.md). */
export const inject = {
  storage: () => currentServices().storage(),
  closeStorage: () => currentServices().closeStorage(),
  exchange: () => currentServices().exchange(),
  /** Forgets the run in progress and the services built so far. Use only in tests. */
  reset: () => {
    setCurrentRunContext(undefined);
    fallback = undefined;
  },
};
