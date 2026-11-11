import { vi } from 'vitest';
import { createRunContextMock } from '../run/runContext.mock';
import type { ConfigurationReader, RunContext, ServiceProvider } from '../run/runContext.types';

/** What a getter of the configuration returns */
type Section<Getter extends keyof ConfigurationReader> = ReturnType<ConfigurationReader[Getter]>;

/**
 * The sections of a configuration a test gives the plugin it builds: each as the getter of its name returns it, or, for the watch and
 * the exchange, the part of it the code under test reads (the pairs and the warmup of the watch, the synchronization intervals of the
 * exchange)
 */
export type PluginContextSections = {
  watch?: Partial<Section<'getWatch'>>;
  strategy?: Section<'getStrategy'>;
  exchange?: Partial<Section<'getExchange'>>;
};

/**
 * The context of a run, as a literal, for a plugin under test (createRunContextMock, given its getters by section): the getters of the
 * watch, the strategy block and the exchange section, those a plugin reads, each a vi.fn() that returns the section given (undefined
 * for one left out, the watch included: a plugin reads it as it is built), each other getter and each service a vi.fn() that returns
 * nothing unless `services` gives it, the exchange the orders of a Trader reach, say. Built in beforeEach or in the test: the getters
 * keep the implementation given here through mockReset.
 */
export const createPluginContext = (
  { watch, strategy, exchange }: PluginContextSections = {},
  services: Partial<ServiceProvider> = {},
): RunContext =>
  createRunContextMock({
    configuration: {
      getStrategy: vi.fn(() => strategy),
      getWatch: vi.fn(() => watch as Section<'getWatch'>),
      getExchange: vi.fn(() => exchange as Section<'getExchange'>),
    },
    services,
  });
