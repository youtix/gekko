import { describe, expect, it } from 'vitest';
import { performanceReporterSchema } from './performanceReporter.schema';

const name = 'PerformanceReporter';
const defaults = { filePath: process.cwd(), fileName: 'performance_reports.csv' };
const custom = { filePath: './reports', fileName: 'run.csv' };

describe('performanceReporterSchema', () => {
  it.each`
    scenario                          | options   | expected
    ${'no option, with the defaults'} | ${{}}     | ${{ name, ...defaults }}
    ${'every option'}                 | ${custom} | ${{ name, ...custom }}
  `('accepts $scenario', ({ options, expected }) => {
    expect(performanceReporterSchema.parse({ name, ...options })).toEqual(expected);
  });

  it.each`
    scenario                          | options                          | issue
    ${'a misspelt option (filename)'} | ${{ filename: 'run.csv' }}       | ${{ code: 'unrecognized_keys', keys: ['filename'], path: [] }}
    ${'two unknown options'}          | ${{ path: './', format: 'csv' }} | ${{ code: 'unrecognized_keys', keys: ['path', 'format'], path: [] }}
    ${'an empty file name'}           | ${{ fileName: '' }}              | ${{ code: 'too_small', path: ['fileName'], message: 'File name must not be empty' }}
  `('refuses $scenario', ({ options, issue }) => {
    expect(performanceReporterSchema.safeParse({ name, ...options }).error?.issues).toMatchObject([issue]);
  });
});
