import type { configurationSchema } from '@gekko/schemas/configuration/configuration.schema';
import { mock } from 'bun:test';
import { some } from 'lodash-es';
import { z } from 'zod';

/** A configuration as its file holds it, before the schema reads it: dates as text, balances and market data as lists */
export type RawConfiguration = z.input<typeof configurationSchema>;

type PaperExchange = Extract<RawConfiguration['exchange'], { name: 'paper-binance' }>;

/**
 * Mocks the configuration singleton with the configuration `raw` gives, read through the schema as the loader reads a file, its getters
 * handing out the sections the schema returns: a flow runs only a configuration Gekko accepts, with the defaults Gekko gives it. The
 * flows mocked getters over literals, which ran configurations the loader refuses (a `verbose` key, the market data of a pair that is
 * not watched) and went without the defaults (no orderSynchInterval: the orders were polled every millisecond).
 *
 * `raw` is read on every call of a getter, so that a test sets the configuration of its next run by changing what `raw` reads. The
 * schema is loaded by the factory of the mock, which Bun runs when the configuration is first imported, after the other mocks of the
 * file: the helper loads nothing of src before them.
 */
export const mockConfiguration = (raw: RawConfiguration | (() => RawConfiguration)) => {
  const read = typeof raw === 'function' ? raw : () => raw;
  mock.module('@gekko/core/configuration/configuration', async () => {
    const { configurationSchema } = await import('@gekko/schemas/configuration/configuration.schema');
    const parse = () => {
      const result = configurationSchema.safeParse(read());
      if (!result.success) throw new Error(`Invalid configuration of the flow:\n${z.prettifyError(result.error)}`);
      return result.data;
    };
    return {
      config: {
        showLogo: () => parse().showLogo,
        getPlugins: () => parse().plugins,
        getStrategy: () => parse().strategy,
        getWatch: () => parse().watch,
        getExchange: () => parse().exchange,
        // The rule of Configuration.getStorage: a storage in backtest mode or with a CandleWriter only. Handed out in every mode, it let
        // a realtime flow without a CandleWriter pass with a plugin that needs a storage, where Gekko fails at start-up with such a
        // configuration ("Missing or unknown storage")
        getStorage: () => {
          const { storage, watch, plugins } = parse();
          return storage && (watch.mode === 'backtest' || some(plugins, { name: 'CandleWriter' })) ? storage : undefined;
        },
      },
    };
  });
};

/** A watch.daterange as a file writes it, from bounds in epoch milliseconds */
export const rawDaterange = ({ start, end }: { start: number; end: number }) => ({
  start: new Date(start).toISOString(),
  end: new Date(end).toISOString(),
});

/**
 * The paper exchange of the realtime flows, with these balances and the synchronization periods the schema gives, real ones on the fake
 * clock of the flows: the Trader reads the balances again every ten minutes, besides its start and the order events, and an open order
 * is polled every twenty seconds. A scenario that needs another period sets it beside these.
 */
export const paperExchange = (simulationBalance: PaperExchange['simulationBalance']): PaperExchange => ({
  name: 'paper-binance',
  simulationBalance,
});
