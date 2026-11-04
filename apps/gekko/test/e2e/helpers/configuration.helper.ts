import type { RunContext } from '@gekko/core/run/runContext.types';
import type { configurationSchema } from '@gekko/schemas/configuration/configuration.schema';
import type { z } from 'zod';

/** A configuration as its file holds it, before the schema reads it: dates as text, balances and market data as lists */
export type RawConfiguration = z.input<typeof configurationSchema>;

type PaperExchange = Extract<RawConfiguration['exchange'], { name: 'paper-binance' }>;

/**
 * The context of a run of a flow, built from `raw` as the executable builds its own from its file (createRunContext): the configuration
 * as the schema outputs it, its defaults applied, and the services of the run, the storage and the exchange the flow seeds or reads
 * among them. A configuration the loader refuses is refused alike, before anything runs, with a GekkoError listing the issues of the
 * schema (`[CONFIGURATION] Invalid configuration object: …`): a flow runs only a configuration Gekko accepts, with the defaults Gekko
 * gives it. The flows mocked getters over literals, which ran configurations the loader refuses (a `verbose` key, the market data of a
 * pair that is not watched) and went without the defaults (no orderSynchInterval: the orders were polled every millisecond).
 *
 * One context per run: a flow that changes its configuration between two runs builds a new one. Imported when called rather than at the
 * top of the file, as the context loads the logger and ccxt, which the flows mock first: the helper loads nothing of the packages before
 * the mocks of the flow.
 */
export const createFlowContext = async (raw: RawConfiguration): Promise<RunContext> => {
  const { createRunContext } = await import('@gekko/core/run/runContext.helper');
  return createRunContext(raw);
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
