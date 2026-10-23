import { describe, expect, it } from 'vitest';
import { candleWriterSchema } from './candleWriter.schema';

describe('candleWriterSchema', () => {
  it('accepts its name alone', () => {
    expect(candleWriterSchema.parse({ name: 'CandleWriter' })).toEqual({ name: 'CandleWriter' });
  });

  // insertThreshold belongs to the storage section
  it.each`
    scenario                                        | options                       | keys
    ${'an option of the storage (insertThreshold)'} | ${{ insertThreshold: 100 }}   | ${['insertThreshold']}
    ${'two unknown options'}                        | ${{ batch: 10, flush: true }} | ${['batch', 'flush']}
  `('refuses $scenario', ({ options, keys }) => {
    expect(candleWriterSchema.safeParse({ name: 'CandleWriter', ...options }).error?.issues).toMatchObject([
      { code: 'unrecognized_keys', keys, path: [] },
    ]);
  });
});
