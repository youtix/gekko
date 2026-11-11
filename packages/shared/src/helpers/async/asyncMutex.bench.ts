import { bench } from '../../utils/bench/bench.mock';
import { describe } from 'vitest';
import { AsyncMutex } from './asyncMutex';

describe('AsyncMutex Performance', () => {
  // What the simulator does for every bucket and every exchange call: a synchronous section, the lock nearly always free
  bench('runExclusive with sync fn (uncontended)', async () => {
    const mutex = new AsyncMutex();
    await mutex.runExclusive(() => 42);
  });

  bench('runExclusive with async fn (uncontended)', async () => {
    const mutex = new AsyncMutex();
    await mutex.runExclusive(async () => 42);
  });

  bench('sequential runExclusive (10 operations)', async () => {
    const mutex = new AsyncMutex();
    for (let i = 0; i < 10; i++) await mutex.runExclusive(() => 42);
  });

  bench('concurrent runExclusive (10 contenders)', async () => {
    const mutex = new AsyncMutex();
    await Promise.all(Array.from({ length: 10 }, () => mutex.runExclusive(() => 42)));
  });

  bench('concurrent runExclusive (100 contenders)', async () => {
    const mutex = new AsyncMutex();
    await Promise.all(Array.from({ length: 100 }, () => mutex.runExclusive(() => 42)));
  });
});
