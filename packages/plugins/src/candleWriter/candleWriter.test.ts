import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { createPluginContext } from '@gekko/core/plugin/plugin.mock';
import { Storage } from '@gekko/core/storage/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CandleWriter } from './candleWriter';
import { candleWriterSchema } from '@gekko/schemas/plugins/candleWriter.schema';

describe('CandleWriter', () => {
  let writer: CandleWriter;
  let fakeStorage: Storage;
  beforeEach(() => {
    // A realtime run on BTC/USDT, whose candles the writer stores
    const context = createPluginContext({
      watch: { mode: 'realtime', pairs: [{ symbol: 'BTC/USDT' }], warmup: { candleCount: 0, tickrate: 1000 } },
    });
    writer = new CandleWriter({ name: 'CandleWriter' }, context);
    fakeStorage = { addBucket: vi.fn(), close: vi.fn() } as unknown as Storage;
    writer.getStorage = (): Storage => fakeStorage;
  });

  describe('constructor', () => {
    it('should create an instance with the given name', () => {
      expect(writer['pluginName']).toBe('CandleWriter');
    });
  });

  describe('processInit', () => {
    it('leaves the storage alone', () => {
      writer['processInit']();
      expect([fakeStorage.addBucket, fakeStorage.close].flatMap(mock => vi.mocked(mock).mock.calls)).toEqual([]);
    });
  });

  describe('processOneMinuteBucket', () => {
    it('should add candles from bucket to the storage', () => {
      const candle = {
        id: undefined,
        open: 100,
        close: 105,
        high: 110,
        low: 95,
        volume: 1000,
        start: 1620000000000,
      };
      const bucket = new Map([['BTC/USDT', candle]]);
      writer['processOneMinuteBucket'](bucket as any);
      expect(fakeStorage.addBucket).toHaveBeenCalledWith(bucket);
    });
  });

  describe('processFinalize', () => {
    it('closes the storage, which inserts the buffered candles', () => {
      writer['processFinalize']();
      expect(fakeStorage.close).toHaveBeenCalled();
    });

    // The failure of the run: an import whose last candles were not written ends with code 1, saying which minutes are missing
    it('fails when the storage cannot write the buffered candles', () => {
      const failure = new GekkoError('storage', 'Could not write the buffered candles');
      vi.mocked(fakeStorage.close).mockImplementation(() => {
        throw failure;
      });
      expect(() => writer['processFinalize']()).toThrow(failure);
    });
  });

  describe('getStaticConfiguration', () => {
    const config = CandleWriter.getStaticConfiguration();

    it('should return the correct schema', () => {
      expect(config.schema).toBe(candleWriterSchema);
    });

    it('should return modes equal to ["realtime", "importer"]', () => {
      expect(config.modes).toEqual(['realtime', 'importer']);
    });

    it('should return dependencies as an empty array', () => {
      expect(config.dependencies).toEqual([]);
    });

    it('should return inject equal to ["storage"]', () => {
      expect(config.inject).toEqual(['storage']);
    });

    it('should return eventsHandlers as an empty array', () => {
      expect(config.eventsHandlers).toEqual([]);
    });

    it('should return eventsEmitted as an empty array', () => {
      expect(config.eventsEmitted).toEqual([]);
    });

    it('should return name equal to CandleWriter.name', () => {
      expect(config.name).toBe(CandleWriter.name);
    });
  });
});
