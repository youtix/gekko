import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { describe, expect, it, vi } from 'vitest';
import { Configuration } from './configuration';
import { createRunContext } from './runContext.helper';
import { Services } from './services';

// Services imports the SQLite storage, whose bun:sqlite Node cannot load: no storage is built here
vi.mock('../storage/sqlite.storage', () => ({ SQLiteStorage: vi.fn() }));

/** A paper trading configuration as a file holds it, before the schema checks it */
const raw = {
  watch: { assets: ['BTC'], currency: 'USDT', timeframe: '1m', mode: 'realtime' },
  exchange: { name: 'paper-binance', simulationBalance: [{ assetName: 'USDT', balance: 1000 }] },
  plugins: [{ name: 'TradingAdvisor' }],
};

describe('createRunContext', () => {
  describe('given a valid configuration', () => {
    it('builds a context whose configuration reads it, as the schema outputs it', () => {
      expect(createRunContext(raw).configuration.getWatch()).toEqual({
        ...raw.watch,
        tickrate: 1000,
        warmup: { candleCount: 0, tickrate: 1000 },
        pairs: [{ symbol: 'BTC/USDT' }],
      });
    });

    it.each`
      part               | expected
      ${'configuration'} | ${Configuration}
      ${'services'}      | ${Services}
    `('builds its $part as a $expected.name', ({ part, expected }) => {
      expect(createRunContext(raw)[part as 'configuration' | 'services']).toBeInstanceOf(expected);
    });

    it('builds its services from its configuration', () => {
      const { configuration, services } = createRunContext(raw);
      expect((services as Services)['configuration']).toBe(configuration);
    });
  });

  describe('given an invalid configuration', () => {
    const invalid = { ...raw, showLogo: 'yes' };

    it('throws a GekkoError', () => {
      expect(() => createRunContext(invalid)).toThrow(GekkoError);
    });

    // The issues as z.prettifyError writes them, one per line with the path of the option at fault
    it.each`
      source                        | name
      ${undefined}                  | ${'object'}
      ${'variant 12'}               | ${'variant 12'}
      ${'file ./config/gekko.json'} | ${'file ./config/gekko.json'}
    `('names its source, $name, given $source, then each issue', ({ source, name }) => {
      expect(() => createRunContext(invalid, source)).toThrow(
        `[CONFIGURATION] Invalid configuration ${name}:\n✖ Invalid input: expected boolean, received string\n  → at showLogo`,
      );
    });
  });
});
