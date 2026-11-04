import { CandleBucket } from '@gekko/shared/models/event.types';
import { Plugin } from '@gekko/core/plugin/plugin';
import type { RunContext } from '@gekko/core/run/runContext.types';
import { candleWriterSchema } from '@gekko/schemas/plugins/candleWriter.schema';
import { CandleWriterConfig } from './candleWriter.types';

export class CandleWriter extends Plugin {
  constructor({ name }: CandleWriterConfig, context: RunContext) {
    super(name, context);
  }

  // --------------------------------------------------------------------------
  //                           PLUGIN LIFECYCLE HOOKS
  // --------------------------------------------------------------------------

  protected processInit(): void {
    /* noop */
  }

  protected processOneMinuteBucket(bucket: CandleBucket): void {
    this.getStorage().addBucket(bucket);
  }

  protected processFinalize(): void {
    // close() inserts the buffered candles first. Not caught: when it cannot, the run fails, saying which minutes were not written.
    this.getStorage().close();
  }

  public static getStaticConfiguration() {
    return {
      name: 'CandleWriter',
      schema: candleWriterSchema,
      modes: ['realtime', 'importer'],
      dependencies: [],
      inject: ['storage'],
      eventsHandlers: [],
      eventsEmitted: [],
    } as const;
  }
}
