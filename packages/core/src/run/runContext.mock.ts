import { vi } from 'vitest';
import type { ConfigurationReader, RunContext, ServiceProvider } from './runContext.types';

/** The getters and the services a test gives the context it builds: those the code under test reads */
export type RunContextMockParts = { configuration?: Partial<ConfigurationReader>; services?: Partial<ServiceProvider> };

/**
 * The context of a run, as a literal, for a unit test: the getters and the services given, each other one a vi.fn() that returns
 * nothing. A test that changes what a getter returns passes vi.fn() getters whose return values it sets in beforeEach or in the test
 * (mockReset clears them before each test), as the order suites do with the mode of the watch.
 */
export const createRunContextMock = ({ configuration = {}, services = {} }: RunContextMockParts = {}): RunContext => ({
  configuration: {
    showLogo: vi.fn(),
    getPlugins: vi.fn(),
    getStrategy: vi.fn(),
    getWatch: vi.fn(),
    getStorage: vi.fn(),
    getExchange: vi.fn(),
    ...configuration,
  },
  services: { exchange: vi.fn(), storage: vi.fn(), closeStorage: vi.fn(), ...services },
});
