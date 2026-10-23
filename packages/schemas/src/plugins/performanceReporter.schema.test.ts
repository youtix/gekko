import { describe, expect, it } from 'vitest';
import { performanceReporterSchema } from './performanceReporter.schema';

const name = 'PerformanceReporter';
const defaults = { filePath: process.cwd(), fileName: 'performance_reports.csv' };
const custom = { filePath: './reports', fileName: 'run.csv' };
const labelled = { label: '--exchange.marketData.0.marketData.fee.maker 0.01' };

describe('performanceReporterSchema', () => {
  it.each`
    scenario                               | options                       | expected
    ${'no option, with the defaults'}      | ${{}}                         | ${{ name, ...defaults }}
    ${'every option'}                      | ${{ ...custom, ...labelled }} | ${{ name, ...custom, ...labelled }}
    ${'a label, with the defaults'}        | ${labelled}                   | ${{ name, ...defaults, ...labelled }}
    ${'a label holding the CSV separator'} | ${{ label: 'fee;0.01' }}      | ${{ name, ...defaults, label: 'fee;0.01' }}
  `('accepts $scenario', ({ options, expected }) => {
    expect(performanceReporterSchema.parse({ name, ...options })).toStrictEqual(expected);
  });

  it.each`
    scenario                          | options                          | issue
    ${'a misspelt option (filename)'} | ${{ filename: 'run.csv' }}       | ${{ code: 'unrecognized_keys', keys: ['filename'], path: [] }}
    ${'two unknown options'}          | ${{ path: './', format: 'csv' }} | ${{ code: 'unrecognized_keys', keys: ['path', 'format'], path: [] }}
    ${'an empty file name'}           | ${{ fileName: '' }}              | ${{ code: 'too_small', path: ['fileName'], message: 'File name must not be empty' }}
    ${'an empty label'}               | ${{ label: '' }}                 | ${{ code: 'too_small', path: ['label'], message: 'Label must not be empty' }}
    ${'a label that is no text'}      | ${{ label: 12 }}                 | ${{ code: 'invalid_type', path: ['label'], message: 'Invalid input: expected string, received number' }}
  `('refuses $scenario', ({ options, issue }) => {
    expect(performanceReporterSchema.safeParse({ name, ...options }).error?.issues).toMatchObject([issue]);
  });
});
