import { Exchange } from '@gekko/shared/models/exchange.types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../configuration/configuration';
import { setCurrentRunContext } from '../run/currentRun.helper';
import { createRunContextMock } from '../run/runContext.mock';
import { Services } from '../run/services';
import { Storage } from '../storage/storage';
import { inject } from './injecter';

// The services the transitional `inject` falls back on, for a run started without a context: built by the shim, faked here
vi.mock('../run/services', () => ({
  Services: vi.fn(function () {
    return { exchange: vi.fn(() => 'fallback exchange'), storage: vi.fn(() => 'fallback storage'), closeStorage: vi.fn() };
  }),
}));

// The transitional shim of the monorepo wave: it hands out the services of the run in progress, else those it builds from the
// transitional `config`, and goes with it once no module imports it
describe('inject', () => {
  beforeEach(() => {
    inject.reset();
  });

  describe('during a run the pipeline set the context of', () => {
    const exchange = {} as Exchange;
    const storage = {} as Storage;
    const closeStorage = vi.fn();

    beforeEach(() => {
      setCurrentRunContext(createRunContextMock({ services: { exchange: () => exchange, storage: () => storage, closeStorage } }));
    });

    it.each`
      service       | expected
      ${'exchange'} | ${exchange}
      ${'storage'}  | ${storage}
    `('hands out the $service of the run', ({ service, expected }) => {
      expect(inject[service as 'exchange' | 'storage']()).toBe(expected);
    });

    it('closes the storage of the run', () => {
      inject.closeStorage();
      expect(closeStorage).toHaveBeenCalledOnce();
    });

    it('builds no services of its own', () => {
      inject.exchange();
      expect(Services).not.toHaveBeenCalled();
    });

    it('forgets the run once reset', () => {
      inject.reset();
      expect(inject.exchange()).toBe('fallback exchange');
    });
  });

  describe('without a run in progress', () => {
    it.each`
      service       | expected
      ${'exchange'} | ${'fallback exchange'}
      ${'storage'}  | ${'fallback storage'}
    `('hands out the $service of the services it builds from the transitional configuration', ({ service, expected }) => {
      expect(inject[service as 'exchange' | 'storage']()).toBe(expected);
    });

    it('builds those services from the transitional configuration, once', () => {
      inject.exchange();
      inject.storage();
      expect(Services).toHaveBeenCalledExactlyOnceWith(config);
    });

    it('builds them again once reset', () => {
      inject.exchange();
      inject.reset();
      inject.exchange();
      expect(Services).toHaveBeenCalledTimes(2);
    });
  });
});
