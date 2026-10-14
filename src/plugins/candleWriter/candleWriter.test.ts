import { GekkoError } from '@errors/gekko.error';
import { Storage } from '@services/storage/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CandleWriter } from './candleWriter';
import { candleWriterSchema } from './candleWriter.schema';

vi.mock('@services/configuration/configuration', () => {
  const Configuration = vi.fn(function () {
    return {
      getWatch: vi.fn(() => ({
        pairs: [{ symbol: 'BTC/USDT', timeframe: '1m' }],
        warmup: {},
      })),
      getStrategy: vi.fn(() => ({})),
      showLogo: vi.fn(),
      getPlugins: vi.fn(),
      getStorage: vi.fn(),
      getExchange: vi.fn(),
    };
  });
  return { config: new Configuration() };
});

describe('CandleWriter', () => {
  let writer: CandleWriter;
  let fakeStorage: Storage;
  beforeEach(() => {
    const config = { name: 'CandleWriter' };
    writer = new CandleWriter(config);
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
