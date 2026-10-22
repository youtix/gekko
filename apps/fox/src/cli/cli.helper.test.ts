import { availableParallelism } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram, parseCommandLine, parseOverrides } from './cli.helper';

describe('parseOverrides', () => {
  it.each`
    description                                         | argv                                                                     | expected
    ${'nothing'}                                        | ${[]}                                                                    | ${{}}
    ${'a single number, as itself'}                     | ${['--strategy.period', '14']}                                           | ${{ strategy: { period: 14 } }}
    ${'a negative decimal'}                             | ${['--strategy.thresholds.down', '-0.5']}                                | ${{ strategy: { thresholds: { down: -0.5 } } }}
    ${'true, a boolean'}                                | ${['--watch.batchSize', 'true']}                                         | ${{ watch: { batchSize: true } }}
    ${'false, a boolean'}                               | ${['--showLogo', 'false']}                                               | ${{ showLogo: false }}
    ${'a text'}                                         | ${['--strategy.src', 'ohlc4']}                                           | ${{ strategy: { src: 'ohlc4' } }}
    ${'a number in an exponent form, as a text'}        | ${['--x', '1e3']}                                                        | ${{ x: '1e3' }}
    ${'a date, as a text'}                              | ${['--watch.daterange.start', '2024-06-01T00:00:00Z']}                   | ${{ watch: { daterange: { start: '2024-06-01T00:00:00Z' } } }}
    ${'a path going up, as a text, not a range'}        | ${['--storage.database', '../db/x.sql']}                                 | ${{ storage: { database: '../db/x.sql' } }}
    ${'a list of numbers'}                              | ${['--strategy.period', '12,24']}                                        | ${{ strategy: { period: [12, 24] } }}
    ${'a list, its items trimmed'}                      | ${['--strategy.period', ' 1 , 2 ']}                                      | ${{ strategy: { period: [1, 2] } }}
    ${'a list of booleans'}                             | ${['--x', 'true,false']}                                                 | ${{ x: [true, false] }}
    ${'a list of texts'}                                | ${['--strategy.src', 'close,ohlc4']}                                     | ${{ strategy: { src: ['close', 'ohlc4'] } }}
    ${'a list of paths'}                                | ${['--storage.database', '../a.sql,../b.sql']}                           | ${{ storage: { database: ['../a.sql', '../b.sql'] } }}
    ${'a range, a step of 1'}                           | ${['--strategy.period', '12..15']}                                       | ${{ strategy: { period: [12, 13, 14, 15] } }}
    ${'a range of whole numbers ending in 0, step 1'}   | ${['--strategy.period', '10..12']}                                       | ${{ strategy: { period: [10, 11, 12] } }}
    ${'a range with a step'}                            | ${['--strategy.period', '12..24:4']}                                     | ${{ strategy: { period: [12, 16, 20, 24] } }}
    ${'a range whose step goes past its end, the end'}  | ${['--strategy.period', '12..24:5']}                                     | ${{ strategy: { period: [12, 17, 22, 24] } }}
    ${'a range of one value'}                           | ${['--strategy.period', '12..12']}                                       | ${{ strategy: { period: [12] } }}
    ${'a range of decimals, a step of their last unit'} | ${['--x', '1.05..1.07']}                                                 | ${{ x: [1.05, 1.06, 1.07] }}
    ${'a range of decimals summed in decimal'}          | ${['--x', '0.1..0.3']}                                                   | ${{ x: [0.1, 0.2, 0.3] }}
    ${'a range of hundreds'}                            | ${['--x', '100..300:100']}                                               | ${{ x: [100, 200, 300] }}
    ${'a range across 0'}                               | ${['--x', '-2..2:2']}                                                    | ${{ x: [-2, 0, 2] }}
    ${'a range with a decimal step'}                    | ${['--x', '0.5..0.75:0.125']}                                            | ${{ x: [0.5, 0.625, 0.75] }}
    ${'a list holding a range'}                         | ${['--strategy.period', '10,20..30:5']}                                  | ${{ strategy: { period: [10, 20, 25, 30] } }}
    ${'the = form'}                                     | ${['--strategy.period=12,24']}                                           | ${{ strategy: { period: [12, 24] } }}
    ${'the = form, its value holding an ='}             | ${['--x=a=b']}                                                           | ${{ x: 'a=b' }}
    ${'a key of the plugins, by index'}                 | ${['--plugins.3.fileName', 'a.csv']}                                     | ${{ plugins: { 3: { fileName: 'a.csv' } } }}
    ${'two keys of one block'}                          | ${['--strategy.thresholds.up', '1', '--strategy.thresholds.down', '-1']} | ${{ strategy: { thresholds: { up: 1, down: -1 } } }}
    ${'two keys whose names start alike'}               | ${['--a.b', '1', '--a.bc', '2']}                                         | ${{ a: { b: 1, bc: 2 } }}
  `('should read $description', ({ argv, expected }) => {
    expect(parseOverrides(argv)).toStrictEqual(expected);
  });

  it.each`
    description                                    | argv                               | message
    ${'an operand'}                                | ${['stray']}                       | ${'[FOX] Unexpected argument "stray": an override is written --<key> <values> (--strategy.period 12,24)'}
    ${'a second value'}                            | ${['--x', '12', '24']}             | ${'[FOX] Unexpected argument "24": an override is written --<key> <values> (--strategy.period 12,24)'}
    ${'a short option'}                            | ${['-x', '1']}                     | ${'[FOX] Unexpected argument "-x": an override is written --<key> <values> (--strategy.period 12,24)'}
    ${'an option without a value, last'}           | ${['--x']}                         | ${'[FOX] --x has no value'}
    ${'an option without a value, before another'} | ${['--x', '--y', '1']}             | ${'[FOX] --x has no value'}
    ${'an option with an empty value'}             | ${['--x=']}                        | ${'[FOX] --x has no value'}
    ${'an option with a blank value'}              | ${['--x', ' ']}                    | ${'[FOX] --x has no value'}
    ${'a list with an empty item'}                 | ${['--x', '1,,2']}                 | ${'[FOX] --x has an empty item in its values "1,,2"'}
    ${'a list ending with a comma'}                | ${['--x', '1,']}                   | ${'[FOX] --x has an empty item in its values "1,"'}
    ${'the end of the options'}                    | ${['--', '1']}                     | ${'[FOX] Invalid option "--": an override names a key of the template, written with dots (--strategy.period)'}
    ${'a key with an empty name'}                  | ${['--a..b', '1']}                 | ${'[FOX] Invalid option "--a..b": an override names a key of the template, written with dots (--strategy.period)'}
    ${'a key ending with a dot'}                   | ${['--a.=1']}                      | ${'[FOX] Invalid option "--a.=1": an override names a key of the template, written with dots (--strategy.period)'}
    ${'a key lodash would skip'}                   | ${['--__proto__.x', '1']}          | ${'[FOX] Invalid option "--__proto__.x": __proto__ is the key of no configuration'}
    ${'the constructor key'}                       | ${['--strategy.constructor', '1']} | ${'[FOX] Invalid option "--strategy.constructor": constructor is the key of no configuration'}
    ${'a key given twice'}                         | ${['--x', '1', '--x', '2']}        | ${'[FOX] --x is given twice'}
    ${'a key given twice, once with ='}            | ${['--x=1', '--x', '2']}           | ${'[FOX] --x is given twice'}
    ${'a key inside one given before'}             | ${['--a', '1', '--a.b', '2']}      | ${'[FOX] --a and --a.b overlap, one holding the other: give one of them'}
    ${'a key holding one given before'}            | ${['--a.b', '1', '--a', '2']}      | ${'[FOX] --a.b and --a overlap, one holding the other: give one of them'}
    ${'a range without an end'}                    | ${['--x', '12..']}                 | ${'[FOX] Invalid range "12.." of --x: a range is written <from>..<to> or <from>..<to>:<step>, of numbers'}
    ${'a range without a start'}                   | ${['--x', '..24']}                 | ${'[FOX] Invalid range "..24" of --x: a range is written <from>..<to> or <from>..<to>:<step>, of numbers'}
    ${'a range with a bound that is no number'}    | ${['--x', 'a..12']}                | ${'[FOX] Invalid range "a..12" of --x: a range is written <from>..<to> or <from>..<to>:<step>, of numbers'}
    ${'a range of three bounds'}                   | ${['--x', '1..2..3']}              | ${'[FOX] Invalid range "1..2..3" of --x: a range is written <from>..<to> or <from>..<to>:<step>, of numbers'}
    ${'a range of three dots'}                     | ${['--x', '12...24']}              | ${'[FOX] Invalid range "12...24" of --x: a range is written <from>..<to> or <from>..<to>:<step>, of numbers'}
    ${'a range of two steps'}                      | ${['--x', '12..24:2:3']}           | ${'[FOX] Invalid range "12..24:2:3" of --x: a range is written <from>..<to> or <from>..<to>:<step>, of numbers'}
    ${'a range going down'}                        | ${['--x', '24..12']}               | ${'[FOX] Invalid range "24..12" of --x: its start, 24, is above its end, 12'}
    ${'a range going down in a list'}              | ${['--x', '1,24..12']}             | ${'[FOX] Invalid range "24..12" of --x: its start, 24, is above its end, 12'}
    ${'a range with a step of 0'}                  | ${['--x', '12..24:0']}             | ${'[FOX] Invalid range "12..24:0" of --x: its step must be a number above 0, got "0"'}
    ${'a range with a negative step'}              | ${['--x', '12..24:-2']}            | ${'[FOX] Invalid range "12..24:-2" of --x: its step must be a number above 0, got "-2"'}
    ${'a range with an empty step'}                | ${['--x', '12..24:']}              | ${'[FOX] Invalid range "12..24:" of --x: its step must be a number above 0, got ""'}
    ${'a range with a step that is no number'}     | ${['--x', '12..24:a']}             | ${'[FOX] Invalid range "12..24:a" of --x: its step must be a number above 0, got "a"'}
  `('should refuse $description', ({ argv, message }) => {
    expect(() => parseOverrides(argv)).toThrow(message);
  });
});

/** The help as commander prints it: helpInformation leaves out what addHelpText adds after the options */
const helpOf = (threads: number) => {
  let help = '';
  createProgram(threads)
    .configureOutput({ writeOut: text => (help += text) })
    .outputHelp();
  return help;
};

describe('createProgram', () => {
  it.each`
    description                                 | text
    ${'the usage'}                              | ${'Usage: fox [options] [--<key> <values>...]'}
    ${'the threads of the machine, by default'} | ${'by default, else 12'}
    ${'how the values of an override are read'} | ${'--strategy.period 12..24:4    12, 16, 20 and 24, a step of 4'}
  `('should describe $description in the help', ({ text }) => {
    expect(helpOf(12)).toContain(text);
  });
});

describe('parseCommandLine', () => {
  const THREADS = 8;

  it.each`
    description                                                  | argv                                                        | env                                 | expected
    ${'the template given by --template-path'}                   | ${['--template-path', 'dema.yml']}                          | ${{}}                               | ${{ templatePath: 'dema.yml', maxWorkers: THREADS, overrides: {} }}
    ${'the template given by -t'}                                | ${['-t', 'dema.yml']}                                       | ${{}}                               | ${{ templatePath: 'dema.yml', maxWorkers: THREADS, overrides: {} }}
    ${'the template given by --template-path='}                  | ${['--template-path=dema.yml']}                             | ${{}}                               | ${{ templatePath: 'dema.yml', maxWorkers: THREADS, overrides: {} }}
    ${'the template given by FOX_TEMPLATE_PATH'}                 | ${[]}                                                       | ${{ FOX_TEMPLATE_PATH: 'tma.yml' }} | ${{ templatePath: 'tma.yml', maxWorkers: THREADS, overrides: {} }}
    ${'the option over FOX_TEMPLATE_PATH'}                       | ${['-t', 'dema.yml']}                                       | ${{ FOX_TEMPLATE_PATH: 'tma.yml' }} | ${{ templatePath: 'dema.yml', maxWorkers: THREADS, overrides: {} }}
    ${'the workers given by --max-workers'}                      | ${['-t', 'dema.yml', '--max-workers', '4']}                 | ${{}}                               | ${{ templatePath: 'dema.yml', maxWorkers: 4, overrides: {} }}
    ${'the workers given by -w'}                                 | ${['-t', 'dema.yml', '-w', '2']}                            | ${{}}                               | ${{ templatePath: 'dema.yml', maxWorkers: 2, overrides: {} }}
    ${'the workers given by FOX_MAX_WORKERS'}                    | ${['-t', 'dema.yml']}                                       | ${{ FOX_MAX_WORKERS: '3' }}         | ${{ templatePath: 'dema.yml', maxWorkers: 3, overrides: {} }}
    ${'the option over FOX_MAX_WORKERS'}                         | ${['-t', 'dema.yml', '-w', '5']}                            | ${{ FOX_MAX_WORKERS: '3' }}         | ${{ templatePath: 'dema.yml', maxWorkers: 5, overrides: {} }}
    ${'the threads of the machine for an empty FOX_MAX_WORKERS'} | ${['-t', 'dema.yml']}                                       | ${{ FOX_MAX_WORKERS: '' }}          | ${{ templatePath: 'dema.yml', maxWorkers: THREADS, overrides: {} }}
    ${'the overrides after the options'}                         | ${['-t', 'dema.yml', '--strategy.period', '12,24']}         | ${{}}                               | ${{ templatePath: 'dema.yml', maxWorkers: THREADS, overrides: { strategy: { period: [12, 24] } } }}
    ${'the overrides before the options'}                        | ${['--strategy.period', '12', '-t', 'dema.yml', '-w', '2']} | ${{}}                               | ${{ templatePath: 'dema.yml', maxWorkers: 2, overrides: { strategy: { period: 12 } } }}
    ${'an override of a negative number'}                        | ${['-t', 'dema.yml', '--strategy.thresholds.down', '-5']}   | ${{}}                               | ${{ templatePath: 'dema.yml', maxWorkers: THREADS, overrides: { strategy: { thresholds: { down: -5 } } } }}
    ${'the overrides after the end of the options'}              | ${['-t', 'dema.yml', '--', '--x', '1']}                     | ${{}}                               | ${{ templatePath: 'dema.yml', maxWorkers: THREADS, overrides: { x: 1 } }}
  `('should read $description', ({ argv, env, expected }) => {
    expect(parseCommandLine(argv, env, THREADS)).toStrictEqual(expected);
  });

  it.each`
    description                               | argv                                    | env                           | message
    ${'no template'}                          | ${[]}                                   | ${{}}                         | ${'[FOX] No template: give its path with --template-path <path> or FOX_TEMPLATE_PATH'}
    ${'an empty FOX_TEMPLATE_PATH'}           | ${[]}                                   | ${{ FOX_TEMPLATE_PATH: '' }}  | ${'[FOX] No template: give its path with --template-path <path> or FOX_TEMPLATE_PATH'}
    ${'--template-path without its value'}    | ${['--strategy.period', '12', '-t']}    | ${{}}                         | ${"[FOX] option '-t, --template-path <path>' argument missing"}
    ${'a count of workers of 0'}              | ${['-t', 'dema.yml', '-w', '0']}        | ${{}}                         | ${'[FOX] --max-workers must be a whole number of at least 1, got "0"'}
    ${'a count of workers that is a decimal'} | ${['-t', 'dema.yml', '-w', '2.5']}      | ${{}}                         | ${'[FOX] --max-workers must be a whole number of at least 1, got "2.5"'}
    ${'an empty count of workers'}            | ${['-t', 'dema.yml', '--max-workers=']} | ${{}}                         | ${'[FOX] --max-workers must be a whole number of at least 1, got ""'}
    ${'a FOX_MAX_WORKERS that is no number'}  | ${['-t', 'dema.yml']}                   | ${{ FOX_MAX_WORKERS: 'all' }} | ${'[FOX] FOX_MAX_WORKERS must be a whole number of at least 1, got "all"'}
    ${'an operand'}                           | ${['stray', '-t', 'dema.yml']}          | ${{}}                         | ${'[FOX] Unexpected argument "stray": an override is written --<key> <values> (--strategy.period 12,24)'}
    ${'an override refused'}                  | ${['-t', 'dema.yml', '--x', '24..12']}  | ${{}}                         | ${'[FOX] Invalid range "24..12" of --x: its start, 24, is above its end, 12'}
  `('should refuse $description', ({ argv, env, message }) => {
    expect(() => parseCommandLine(argv, env, THREADS)).toThrow(message);
  });

  it('should default to the threads of the machine', () => {
    expect(parseCommandLine(['-t', 'dema.yml'], {})?.maxWorkers).toBe(availableParallelism());
  });

  describe('when the help is asked for', () => {
    beforeEach(() => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    it.each`
      option
      ${'--help'}
      ${'-h'}
    `('should give nothing to run for $option', ({ option }) => {
      expect(parseCommandLine(['-t', 'dema.yml', option], {}, THREADS)).toBeUndefined();
    });

    it('should print the usage', () => {
      parseCommandLine(['--help'], {}, THREADS);

      expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('Usage: fox [options] [--<key> <values>...]'));
    });

    it('should not need a template', () => {
      expect(parseCommandLine(['--help'], {}, THREADS)).toBeUndefined();
    });
  });
});
