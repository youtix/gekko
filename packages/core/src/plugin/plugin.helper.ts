import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { config } from '../configuration/configuration';
import type { RunContext } from '../run/runContext.types';

const noService = (): never => {
  throw new GekkoError('core', 'This plugin was built without a RunContext: it has no services to hand out');
};

/**
 * @deprecated Transitional, for the monorepo wave: the context of a plugin built without one, a unit test of a plugin not yet
 * converted. It reads the `config` singleton and has no services: such a plugin gets its exchange and its storage through setExchange
 * and setStorage, which the pipeline calls, and reads nothing of `context.services`. Not the injecter, whose services load the SQLite
 * storage and, with it, bun:sqlite, which vitest cannot.
 */
export const transitionalContext = (): RunContext => ({
  configuration: config,
  services: { exchange: noService, storage: noService, closeStorage: noService },
});
