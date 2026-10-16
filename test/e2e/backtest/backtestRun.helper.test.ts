import { describe, expect, it } from 'bun:test';
import { withOrderNumbers } from './backtestRun.helper';

const FIRST = '25810394-f8d2-4b9c-91a9-a652b381e5d2';
const SECOND = 'f41f652e-db65-4e92-8cb8-329b0ba349ce';

describe('backtestRun.helper', () => {
  describe('withOrderNumbers', () => {
    it.each([
      [
        'each order by the rank its id first appears at, from 1, in every message naming it',
        [`[${SECOND}] Creating`, `[${FIRST}] sized`, `[${SECOND}] filled`],
        ['[order 1] Creating', '[order 2] sized', '[order 1] filled'],
      ],
      ['every order a message names', [`Order ${FIRST} canceled, ${SECOND} placed`], ['Order order 1 canceled, order 2 placed']],
      ['no order in a message without an order id', ['Strategy warmup done'], ['Strategy warmup done']],
    ])('should name %s', (_case, messages, named) => {
      expect(withOrderNumbers(messages)).toEqual(named);
    });
  });
});
