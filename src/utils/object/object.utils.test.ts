import { describe, expect, it } from 'vitest';
import { shallowObjectDiff } from './object.utils';

describe('shallowObjectDiff', () => {
  it.each`
    description                              | a                  | b                  | expected
    ${'a value that changed'}                | ${{ x: 1 }}        | ${{ x: 2 }}        | ${{ x: 2 }}
    ${'a key only in a'}                     | ${{ x: 1 }}        | ${{}}              | ${{ x: 1 }}
    ${'a key only in b'}                     | ${{}}              | ${{ y: 'foo' }}    | ${{ y: 'foo' }}
    ${'an equal value'}                      | ${{ x: 1 }}        | ${{ x: 1 }}        | ${{}}
    ${'NaN on both sides'}                   | ${{ n: NaN }}      | ${{ n: NaN }}      | ${{}}
    ${'-0 against 0'}                        | ${{ z: -0 }}       | ${{ z: 0 }}        | ${{ z: 0 }}
    ${'equal arrays, two references'}        | ${{ arr: [1, 2] }} | ${{ arr: [1, 2] }} | ${{ arr: [1, 2] }}
    ${'equal objects, two references'}       | ${{ o: { k: 1 } }} | ${{ o: { k: 1 } }} | ${{ o: { k: 1 } }}
    ${'a key of Object.prototype only in a'} | ${{ toString: 1 }} | ${{}}              | ${{ toString: 1 }}
  `('should give $expected for $description', ({ a, b, expected }) => {
    expect(shallowObjectDiff(a, b)).toEqual(expected);
  });

  it('produces the same set of diff keys regardless of argument order', () => {
    const a = { p: 1, q: 2 };
    const b = { p: 1, q: 3, r: 4 };

    const keysAB = Object.keys(shallowObjectDiff(a, b)).sort();
    const keysBA = Object.keys(shallowObjectDiff(b, a)).sort();

    expect(keysAB).toEqual(keysBA);
  });

  it('ignores symbol-named properties (not in Object.keys)', () => {
    const s = Symbol('secret');
    const a = { [s]: 123 };
    const b = {};

    expect(shallowObjectDiff(a, b)).toEqual({});
  });

  it.each`
    a       | b
    ${null} | ${{}}
    ${{}}   | ${undefined}
    ${null} | ${undefined}
  `('should throw a TypeError for $a and $b', ({ a, b }) => {
    expect(() => shallowObjectDiff(a, b)).toThrow(TypeError);
  });
});
