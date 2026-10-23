import { Command } from 'commander';
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
    ${'a path starting like a range, as a text'}        | ${['--storage.database', '2024..old/x.sql']}                             | ${{ storage: { database: '2024..old/x.sql' } }}
    ${'a text holding two dots, as a text'}             | ${['--plugins.3.label', 'run..2']}                                       | ${{ plugins: { 3: { label: 'run..2' } } }}
    ${'a text holding two dots, in the = form'}         | ${['--plugins.3.label=baseline..v2']}                                    | ${{ plugins: { 3: { label: 'baseline..v2' } } }}
    ${'two dots alone, as a text'}                      | ${['--x', '..']}                                                         | ${{ x: '..' }}
    ${'two dots before a number, as a text'}            | ${['--x', '..24']}                                                       | ${{ x: '..24' }}
    ${'a minus sign before two dots, as a text'}        | ${['--x', '-..5']}                                                       | ${{ x: '-..5' }}
    ${'a number of 17 digits that a number keeps'}      | ${['--x', '0.30000000000000004']}                                        | ${{ x: 0.30000000000000004 }}
    ${'a list of numbers'}                              | ${['--strategy.period', '12,24']}                                        | ${{ strategy: { period: [12, 24] } }}
    ${'a list, its items trimmed'}                      | ${['--strategy.period', ' 1 , 2 ']}                                      | ${{ strategy: { period: [1, 2] } }}
    ${'a list of booleans'}                             | ${['--x', 'true,false']}                                                 | ${{ x: [true, false] }}
    ${'a list of texts'}                                | ${['--strategy.src', 'close,ohlc4']}                                     | ${{ strategy: { src: ['close', 'ohlc4'] } }}
    ${'a list of paths'}                                | ${['--storage.database', '../a.sql,../b.sql']}                           | ${{ storage: { database: ['../a.sql', '../b.sql'] } }}
    ${'a list giving a text twice, once'}               | ${['--strategy.src', 'close,ohlc4,close']}                               | ${{ strategy: { src: ['close', 'ohlc4'] } }}
    ${'a list giving a number two ways, once'}          | ${['--x', '1,1.0']}                                                      | ${{ x: [1] }}
    ${'a list and a range sharing a value, once'}       | ${['--strategy.period', '10,10..12']}                                    | ${{ strategy: { period: [10, 11, 12] } }}
    ${'two ranges sharing a bound, once'}               | ${['--strategy.period', '1..10:3,10..30:10']}                            | ${{ strategy: { period: [1, 4, 7, 10, 20, 30] } }}
    ${'a range then its end, once'}                     | ${['--strategy.period', '12..24:5,24']}                                  | ${{ strategy: { period: [12, 17, 22, 24] } }}
    ${'a range, a step of 1'}                           | ${['--strategy.period', '12..15']}                                       | ${{ strategy: { period: [12, 13, 14, 15] } }}
    ${'a range of whole numbers ending in 0, step 1'}   | ${['--strategy.period', '10..12']}                                       | ${{ strategy: { period: [10, 11, 12] } }}
    ${'a range with a step'}                            | ${['--strategy.period', '12..24:4']}                                     | ${{ strategy: { period: [12, 16, 20, 24] } }}
    ${'a range whose step goes past its end, the end'}  | ${['--strategy.period', '12..24:5']}                                     | ${{ strategy: { period: [12, 17, 22, 24] } }}
    ${'a range of one value'}                           | ${['--strategy.period', '12..12']}                                       | ${{ strategy: { period: [12] } }}
    ${'a range of decimals, a step of their last unit'} | ${['--x', '1.05..1.07']}                                                 | ${{ x: [1.05, 1.06, 1.07] }}
    ${'a range of decimals summed in decimal'}          | ${['--x', '0.1..0.3']}                                                   | ${{ x: [0.1, 0.2, 0.3] }}
    ${'a range of 4 decimals, a step of 0.0001'}        | ${['--x', '0.0001..0.0003']}                                             | ${{ x: [0.0001, 0.0002, 0.0003] }}
    ${'a range of hundreds'}                            | ${['--x', '100..300:100']}                                               | ${{ x: [100, 200, 300] }}
    ${'a range across 0'}                               | ${['--x', '-2..2:2']}                                                    | ${{ x: [-2, 0, 2] }}
    ${'a range of negative decimals'}                   | ${['--x', '-0.5..-0.3']}                                                 | ${{ x: [-0.5, -0.4, -0.3] }}
    ${'a range of bounds written with zeros around'}    | ${['--x', '0012..14.00']}                                                | ${{ x: [12, 13, 14] }}
    ${'a range stepping by the last decimal written'}   | ${['--x', '1.50..1.70']}                                                 | ${{ x: [1.5, 1.6, 1.7] }}
    ${'a range of 16 digits that numbers keep'}         | ${['--x', '1.000000000000001..1.000000000000003']}                       | ${{ x: [1.000000000000001, 1.000000000000002, 1.000000000000003] }}
    ${'a range with a decimal step'}                    | ${['--x', '0.5..0.75:0.125']}                                            | ${{ x: [0.5, 0.625, 0.75] }}
    ${'a list holding a range'}                         | ${['--strategy.period', '10,20..30:5']}                                  | ${{ strategy: { period: [10, 20, 25, 30] } }}
    ${'the = form'}                                     | ${['--strategy.period=12,24']}                                           | ${{ strategy: { period: [12, 24] } }}
    ${'the = form, its value holding an ='}             | ${['--x=a=b']}                                                           | ${{ x: 'a=b' }}
    ${'a key of the plugins, by index'}                 | ${['--plugins.3.fileName', 'a.csv']}                                     | ${{ plugins: { 3: { fileName: 'a.csv' } } }}
    ${'two keys of one block'}                          | ${['--strategy.thresholds.up', '1', '--strategy.thresholds.down', '-1']} | ${{ strategy: { thresholds: { up: 1, down: -1 } } }}
    ${'two keys whose names start alike'}               | ${['--a.b', '1', '--a.bc', '2']}                                         | ${{ a: { b: 1, bc: 2 } }}
    ${'the end of the options first, skipped'}          | ${['--', '--x', '1']}                                                    | ${{ x: 1 }}
    ${'the end of the options between two, skipped'}    | ${['--x', '1', '--', '--y', '2']}                                        | ${{ x: 1, y: 2 }}
    ${'the end of the options before a value, skipped'} | ${['--strategy.src', '--', '-tma']}                                      | ${{ strategy: { src: '-tma' } }}
  `('should read $description', ({ argv, expected }) => {
    expect(parseOverrides(argv)).toStrictEqual(expected);
  });

  // 0.6 + 9999 × 0.3 is 3000.3: in binary, (3000.3 - 0.6) / 0.3 is 9999.000000000002, which would count one value more than the cap
  it('should read a range of as many values as the cap, counted in decimal', () => {
    expect(parseOverrides(['--x', '0.6..3000.3:0.3']).x).toHaveLength(10_000);
  });

  it.each`
    description                                    | argv                                | message
    ${'an operand'}                                | ${['stray']}                        | ${'[FOX] Unexpected argument "stray": an override is written --<key> <values> (--strategy.period 12,24)'}
    ${'a second value'}                            | ${['--x', '12', '24']}              | ${'[FOX] Unexpected argument "24": an override is written --<key> <values> (--strategy.period 12,24)'}
    ${'a short option'}                            | ${['-x', '1']}                      | ${'[FOX] Unexpected argument "-x": an override is written --<key> <values> (--strategy.period 12,24)'}
    ${'an option without a value, last'}           | ${['--x']}                          | ${'[FOX] --x has no value'}
    ${'an option without a value, before another'} | ${['--x', '--y', '1']}              | ${'[FOX] --x has no value'}
    ${'an option with an empty value'}             | ${['--x=']}                         | ${'[FOX] --x has no value'}
    ${'an option with a blank value'}              | ${['--x', ' ']}                     | ${'[FOX] --x has no value'}
    ${'a list with an empty item'}                 | ${['--x', '1,,2']}                  | ${'[FOX] --x has an empty item in its values "1,,2"'}
    ${'a list ending with a comma'}                | ${['--x', '1,']}                    | ${'[FOX] --x has an empty item in its values "1,"'}
    ${'a value after the end of the options'}      | ${['--', '1']}                      | ${'[FOX] Unexpected argument "1": an override is written --<key> <values> (--strategy.period 12,24)'}
    ${'a key without a name'}                      | ${['--=1']}                         | ${'[FOX] Invalid option "--=1": an override names a key of the template, written with dots (--strategy.period)'}
    ${'a key with an empty name'}                  | ${['--a..b', '1']}                  | ${'[FOX] Invalid option "--a..b": an override names a key of the template, written with dots (--strategy.period)'}
    ${'a key ending with a dot'}                   | ${['--a.=1']}                       | ${'[FOX] Invalid option "--a.=1": an override names a key of the template, written with dots (--strategy.period)'}
    ${'a key lodash would skip'}                   | ${['--__proto__.x', '1']}           | ${'[FOX] Invalid option "--__proto__.x": __proto__ is the key of no configuration'}
    ${'the constructor key'}                       | ${['--strategy.constructor', '1']}  | ${'[FOX] Invalid option "--strategy.constructor": constructor is the key of no configuration'}
    ${'a key given twice'}                         | ${['--x', '1', '--x', '2']}         | ${'[FOX] --x is given twice'}
    ${'a key given twice, once with ='}            | ${['--x=1', '--x', '2']}            | ${'[FOX] --x is given twice'}
    ${'a key inside one given before'}             | ${['--a', '1', '--a.b', '2']}       | ${'[FOX] --a and --a.b overlap, one holding the other: give one of them'}
    ${'a key holding one given before'}            | ${['--a.b', '1', '--a', '2']}       | ${'[FOX] --a.b and --a overlap, one holding the other: give one of them'}
    ${'a number no number keeps'}                  | ${['--x', '9007199254740993']}      | ${'[FOX] Invalid value "9007199254740993" of --x: it holds more digits than a number keeps, which reads it as 9007199254740992: write it with fewer digits'}
    ${'an item no number keeps'}                   | ${['--x', '1,0.30000000000000005']} | ${'[FOX] Invalid value "0.30000000000000005" of --x: it holds more digits than a number keeps, which reads it as 0.30000000000000004: write it with fewer digits'}
    ${'a range without an end'}                    | ${['--x', '12..']}                  | ${'[FOX] Invalid range "12.." of --x: a range is written <from>..<to> or <from>..<to>:<step>, of numbers'}
    ${'a range with an end that is no number'}     | ${['--x', '12..a']}                 | ${'[FOX] Invalid range "12..a" of --x: a range is written <from>..<to> or <from>..<to>:<step>, of numbers'}
    ${'a range of three bounds'}                   | ${['--x', '1..2..3']}               | ${'[FOX] Invalid range "1..2..3" of --x: a range is written <from>..<to> or <from>..<to>:<step>, of numbers'}
    ${'a range of three dots'}                     | ${['--x', '12...24']}               | ${'[FOX] Invalid range "12...24" of --x: a range is written <from>..<to> or <from>..<to>:<step>, of numbers'}
    ${'a range of two steps'}                      | ${['--x', '12..24:2:3']}            | ${'[FOX] Invalid range "12..24:2:3" of --x: a range is written <from>..<to> or <from>..<to>:<step>, of numbers'}
    ${'a range going down'}                        | ${['--x', '24..12']}                | ${'[FOX] Invalid range "24..12" of --x: its start, 24, is above its end, 12'}
    ${'a range going down in a list'}              | ${['--x', '1,24..12']}              | ${'[FOX] Invalid range "24..12" of --x: its start, 24, is above its end, 12'}
    ${'a range with a step of 0'}                  | ${['--x', '12..24:0']}              | ${'[FOX] Invalid range "12..24:0" of --x: its step must be a number above 0, got "0"'}
    ${'a range with a negative step'}              | ${['--x', '12..24:-2']}             | ${'[FOX] Invalid range "12..24:-2" of --x: its step must be a number above 0, got "-2"'}
    ${'a range with an empty step'}                | ${['--x', '12..24:']}               | ${'[FOX] Invalid range "12..24:" of --x: its step must be a number above 0, got ""'}
    ${'a range with a step that is no number'}     | ${['--x', '12..24:a']}              | ${'[FOX] Invalid range "12..24:a" of --x: its step must be a number above 0, got "a"'}
  `('should refuse $description', ({ argv, message }) => {
    expect(() => parseOverrides(argv)).toThrow(message);
  });

  describe('when a range holds a value that no number keeps, or more values than the cap', () => {
    /** The reason Fox gives for a bound that no number holds as written */
    const unheldBound = (name: string, bound: string, read: string) =>
      `its ${name}, ${bound}, holds more digits than a number keeps, which reads it as ${read}: write it with fewer digits`;
    /** The reason Fox gives for a value of the range, made by its step, that no number holds as written */
    const unheldValue = (step: string, value: string, read: string) =>
      `its step of ${step} makes ${value}, more digits than a number keeps, which reads it as ${read}: write the bounds with fewer digits, or give a larger step`;
    /** The reason Fox gives for a range of more values than the cap */
    const tooMany = (count: string) =>
      `it holds ${count} values, more than the 10000 variants Fox makes at most: narrow it, or give it a larger step`;

    it.each`
      description                                                  | range                                             | reason
      ${'a start no number keeps'}                                 | ${'9.999999999999999..10'}                        | ${unheldBound('start', '9.999999999999999', '9.999999999999998')}
      ${'an end no number keeps, read as 2 ** 53'}                 | ${'9007199254740990..9007199254740993'}           | ${unheldBound('end', '9007199254740993', '9007199254740992')}
      ${'an end no number keeps, read as the start'}               | ${'100000000000000000000..100000000000000000001'} | ${unheldBound('end', '100000000000000000001', '100000000000000000000')}
      ${'an end beyond the largest number'}                        | ${`0..1${'0'.repeat(400)}`}                       | ${unheldBound('end', `1${'0'.repeat(400)}`, 'Infinity')}
      ${'a default step of 17 decimals, lost on its start'}        | ${'0.30000000000000004..0.5'}                     | ${unheldValue('0.00000000000000001', '0.30000000000000005', '0.30000000000000004')}
      ${'a step under the precision of its start'}                 | ${'1..2:0.0000000000000001'}                      | ${unheldValue('0.0000000000000001', '1.0000000000000001', '1')}
      ${'a step under the spacing of numbers between kept bounds'} | ${'9.999999999999991..9.999999999999998'}         | ${unheldValue('0.000000000000001', '9.999999999999992', '9.999999999999991')}
      ${'bounds from 2 ** 53'}                                     | ${'9007199254740992..9007199254740994'}           | ${unheldValue('1', '9007199254740993', '9007199254740992')}
      ${'bounds reaching 2 ** 53, lost on its way'}                | ${'9007199254740990..9007199254740994'}           | ${unheldValue('1', '9007199254740993', '9007199254740992')}
      ${'bounds below -(2 ** 53)'}                                 | ${'-9007199254740994..-9007199254740990'}         | ${unheldValue('1', '-9007199254740993', '-9007199254740992')}
      ${'more values than the cap'}                                | ${'2..100001'}                                    | ${tooMany('100000')}
      ${'one decimal value more than the cap'}                     | ${'0.6..3000.6:0.3'}                              | ${tooMany('10001')}
      ${'a step too small for so wide a range'}                    | ${'0..1:0.0000000001'}                            | ${tooMany('10000000001')}
      ${'a step too small for a number to count its values'}       | ${`0..1:0.${'0'.repeat(319)}1`}                   | ${tooMany(`1${'0'.repeat(319)}1`)}
    `('should refuse $description', ({ range, reason }) => {
      expect(() => parseOverrides(['--x', range])).toThrow(`[FOX] Invalid range "${range}" of --x: ${reason}`);
    });
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
    description                                  | text
    ${'the usage'}                               | ${'Usage: fox [options] [--<key> <values>...]'}
    ${'the threads of the machine, by default'}  | ${'by default, else 12'}
    ${'how the values of an override are read'}  | ${'--strategy.period 12..24:4    12, 16, 20 and 24, a step of 4'}
    ${'the = form of a value read as an option'} | ${'--strategy.src=-tma           the = form, for a value that starts with -t, -w or -h'}
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
    ${'the end of the options after an override'}                | ${['-t', 'dema.yml', '--x', '1', '--', '--y', '2']}         | ${{}}                               | ${{ templatePath: 'dema.yml', maxWorkers: THREADS, overrides: { x: 1, y: 2 } }}
    ${'a value like -t after the end of the options'}            | ${['-t', 'dema.yml', '--strategy.src', '--', '-tma']}       | ${{}}                               | ${{ templatePath: 'dema.yml', maxWorkers: THREADS, overrides: { strategy: { src: '-tma' } } }}
    ${'a value like -t in the = form'}                           | ${['-t', 'dema.yml', '--strategy.src=-tma']}                | ${{}}                               | ${{ templatePath: 'dema.yml', maxWorkers: THREADS, overrides: { strategy: { src: '-tma' } } }}
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

  // commander throws nothing else under exitOverride today: an argument parser or a hook added to the program could
  describe("when the command line's reader fails otherwise than by refusing it", () => {
    /** What parsing the command line throws, whatever it is: a thrown undefined included */
    const thrownBy = (argv: string[]) => {
      try {
        parseCommandLine(argv, {}, THREADS);
      } catch (err) {
        return { thrown: err };
      }
      return { thrown: 'nothing' };
    };

    it.each`
      description                    | failure
      ${'an Error'}                  | ${new TypeError('unexpected')}
      ${'a text'}                    | ${'a text'}
      ${'undefined'}                 | ${undefined}
      ${'an object without message'} | ${{ code: 'x' }}
    `('should pass on $description as it is', ({ failure }) => {
      vi.spyOn(Command.prototype, 'parse').mockImplementation(() => {
        throw failure;
      });

      expect(thrownBy(['-t', 'dema.yml']).thrown).toBe(failure);
    });
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
