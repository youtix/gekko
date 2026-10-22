import type { RunContext } from './runContext.types';

let current: RunContext | undefined;

/**
 * @deprecated Transitional, for the monorepo wave: makes `context` the one the `config` and `inject` singletons read, so that the
 * modules not yet converted to receive a RunContext read the same configuration and services as those that are. The pipeline sets it
 * when it is given a context. Removed with the singletons once no module imports them.
 */
export const setCurrentRunContext = (context: RunContext | undefined) => {
  current = context;
};

/** @deprecated Transitional (see setCurrentRunContext): the context of the run in progress, undefined before the pipeline set one */
export const getCurrentRunContext = () => current;
