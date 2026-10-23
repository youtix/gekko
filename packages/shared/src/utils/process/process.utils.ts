import packageJson from '../../../../../package.json';

export const logVersion = () => {
  // Under Bun, process.version is the Node version Bun emulates, not Bun's own version.
  const runtime = process.versions.bun ? `Bun version: v${process.versions.bun}` : `Node version: ${process.version}`;
  return `Gekko version: v${packageJson.version}, ${runtime}`;
};

export const wait = (waitingTime: number) => new Promise(resolve => setTimeout(resolve, waitingTime));

/**
 * Blocks the thread for `ms` milliseconds; a delay that is not above 0 waits nothing. NaN, and undefined from an untyped caller, got
 * past a `ms <= 0` guard, and Atomics.wait took them for no timeout at all: the thread, signal handlers included, blocked for good.
 */
export const waitSync = (ms: number) => {
  if (!(ms > 0)) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
};
