import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The files `bun run type:check` reads, from tsconfig.json as tsc reads it. The default include left out version.cjs, whose
// version.d.cts outranks it, and tsconfig's former exclude left out vitest.config.ts: neither was type-checked.
const ROOT = path.resolve(import.meta.dirname, '../..');
const parsed = ts.getParsedCommandLineOfConfigFile(path.join(ROOT, 'tsconfig.json'), undefined, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: diagnostic => {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  },
});

describe('type check', () => {
  it.each`
    file
    ${'vitest.config.ts'}
    ${'scripts/release/version.cjs'}
  `('should read $file', ({ file }) => {
    expect(parsed?.fileNames).toContain(path.join(ROOT, file));
  });
});
