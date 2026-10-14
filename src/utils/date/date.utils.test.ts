import { describe, expect, it } from 'vitest';
import { useTimeZone } from './date.mock';
import { splitIntervals, startOfMinuteUTC, toISOString, toTimestamp } from './date.utils';

describe('date utils', () => {
  describe('toISOString', () => {
    // Date.prototype.toISOString throws a RangeError on a date that is not one: a message or a report built with it must not throw
    it.each`
      description                                  | timestamp        | expected
      ${'a timestamp'}                             | ${1704346468838} | ${'2024-01-04T05:34:28.838Z'}
      ${'the epoch'}                               | ${0}             | ${'1970-01-01T00:00:00.000Z'}
      ${'the last date there is'}                  | ${8.64e15}       | ${'+275760-09-13T00:00:00.000Z'}
      ${'no timestamp'}                            | ${undefined}     | ${'Unknown Date'}
      ${'null'}                                    | ${null}          | ${'Unknown Date'}
      ${'NaN'}                                     | ${Number.NaN}    | ${'Unknown Date'}
      ${'Infinity'}                                | ${Infinity}      | ${'Unknown Date'}
      ${'-Infinity'}                               | ${-Infinity}     | ${'Unknown Date'}
      ${'a timestamp past the last date there is'} | ${8.64e15 + 1}   | ${'Unknown Date'}
    `('returns $expected for $description', ({ timestamp, expected }) => {
      expect(toISOString(timestamp)).toBe(expected);
    });
  });

  describe('toTimestamp', () => {
    it.each`
      description           | iso8601String                      | expected
      ${'a UTC date'}       | ${'2024-01-04T05:34:28.838Z'}      | ${1704346468838}
      ${'an offset date'}   | ${'2024-01-04T06:34:28.838+01:00'} | ${1704346468838}
      ${'no date'}          | ${undefined}                       | ${0}
      ${'text, not a date'} | ${'garbage'}                       | ${Number.NaN}
    `('returns $expected for $description', ({ iso8601String, expected }) => {
      expect(toTimestamp(iso8601String)).toBe(expected);
    });

    // A day alone is read in UTC, where a day and a time without a zone would be read in local time: the configuration takes a
    // daterange bound written as a day for its midnight UTC
    describe('on a host in America/New_York', () => {
      useTimeZone('America/New_York');

      it('returns 1704326400000, its midnight UTC, for a day alone, 2024-01-04', () => {
        expect(toTimestamp('2024-01-04')).toBe(1704326400000);
      });
    });
  });

  describe('startOfMinuteUTC', () => {
    it.each`
      description                      | timestamp                     | expected
      ${'the start of a minute'}       | ${'2024-03-15T10:20:00.000Z'} | ${'2024-03-15T10:20:00.000Z'}
      ${'an instant within a minute'}  | ${'2024-03-15T10:20:30.500Z'} | ${'2024-03-15T10:20:00.000Z'}
      ${'the last millisecond of one'} | ${'2024-03-15T10:20:59.999Z'} | ${'2024-03-15T10:20:00.000Z'}
      ${'an instant before the epoch'} | ${'1969-12-31T23:59:59.999Z'} | ${'1969-12-31T23:59:00.000Z'}
    `('returns $expected for $description, $timestamp', ({ timestamp, expected }) => {
      expect(startOfMinuteUTC(Date.parse(timestamp))).toBe(Date.parse(expected));
    });

    it('returns NaN for NaN', () => {
      expect(startOfMinuteUTC(Number.NaN)).toBe(Number.NaN);
    });

    // On 2026-10-25 Paris goes from 03:00 CEST back to 02:00 CET: the hour from 01:00Z to 02:00Z is the second pass of 02:00-03:00
    describe('on a host in Europe/Paris', () => {
      useTimeZone('Europe/Paris');

      it.each`
        description                                             | timestamp                     | expected
        ${'the second pass of the hour repeated when DST ends'} | ${'2026-10-25T01:30:20.500Z'} | ${'2026-10-25T01:30:00.000Z'}
        ${'the first instant of that second pass'}              | ${'2026-10-25T01:00:00.000Z'} | ${'2026-10-25T01:00:00.000Z'}
        ${'the last millisecond of that second pass'}           | ${'2026-10-25T01:59:59.999Z'} | ${'2026-10-25T01:59:00.000Z'}
        ${'the first pass of that hour'}                        | ${'2026-10-25T00:30:20.000Z'} | ${'2026-10-25T00:30:00.000Z'}
        ${'a UTC wall time Paris skipped when DST started'}     | ${'2026-03-29T02:30:20.000Z'} | ${'2026-03-29T02:30:00.000Z'}
      `('returns $expected for $description, $timestamp', ({ timestamp, expected }) => {
        expect(startOfMinuteUTC(Date.parse(timestamp))).toBe(Date.parse(expected));
      });
    });
  });

  describe('splitIntervals', () => {
    /** A chunk from the start of its first minute to the last millisecond of its last minute, both written out */
    const chunk = (start: string, end: string) => ({ start: Date.parse(start), end: Date.parse(end) });

    it.each`
      startDate                 | endDate                       | batchSize | chunks                                       | expected
      ${'2020-01-01T00:00:00Z'} | ${'2020-01-01T00:15:00Z'}     | ${1000}   | ${'one chunk of 16 minutes'}                 | ${[chunk('2020-01-01T00:00:00Z', '2020-01-01T00:15:59.999Z')]}
      ${'2020-01-01T00:00:00Z'} | ${'2020-01-01T16:00:00Z'}     | ${1000}   | ${'one chunk of 961 minutes'}                | ${[chunk('2020-01-01T00:00:00Z', '2020-01-01T16:00:59.999Z')]}
      ${'2020-01-01T00:00:00Z'} | ${'2020-01-01T17:00:00Z'}     | ${1000}   | ${'chunks of 1000 and 21 minutes'}           | ${[chunk('2020-01-01T00:00:00Z', '2020-01-01T16:39:59.999Z'), chunk('2020-01-01T16:40:00Z', '2020-01-01T17:00:59.999Z')]}
      ${'2020-01-01T00:00:00Z'} | ${'2020-01-02T09:20:00Z'}     | ${1000}   | ${'chunks of 1000, 1000 and 1 minutes'}      | ${[chunk('2020-01-01T00:00:00Z', '2020-01-01T16:39:59.999Z'), chunk('2020-01-01T16:40:00Z', '2020-01-02T09:19:59.999Z'), chunk('2020-01-02T09:20:00Z', '2020-01-02T09:20:59.999Z')]}
      ${'2024-01-01T10:20:00Z'} | ${'2024-01-01T10:20:00Z'}     | ${1000}   | ${'one chunk of 1 minute (equal bounds)'}    | ${[chunk('2024-01-01T10:20:00Z', '2024-01-01T10:20:59.999Z')]}
      ${'2024-01-01T10:20:30Z'} | ${'2024-01-01T10:20:45Z'}     | ${1000}   | ${'one chunk of 1 minute (the same minute)'} | ${[chunk('2024-01-01T10:20:00Z', '2024-01-01T10:20:59.999Z')]}
      ${'2024-01-01T10:20:30Z'} | ${'2024-01-01T10:22:15.500Z'} | ${1000}   | ${'one chunk of their 3 whole minutes'}      | ${[chunk('2024-01-01T10:20:00Z', '2024-01-01T10:22:59.999Z')]}
    `('splits $startDate -> $endDate by $batchSize minutes into $chunks', ({ startDate, endDate, batchSize, expected }) => {
      expect(splitIntervals(Date.parse(startDate), Date.parse(endDate), batchSize)).toEqual(expected);
    });

    // A whole number of batches: the last chunk is a whole batch too
    it('splits two whole days, by the default batch of a day, into two chunks of a day', () => {
      expect(splitIntervals(Date.parse('2024-01-01T00:00:00Z'), Date.parse('2024-01-02T23:59:00Z'))).toEqual([
        chunk('2024-01-01T00:00:00Z', '2024-01-01T23:59:59.999Z'),
        chunk('2024-01-02T00:00:00Z', '2024-01-02T23:59:59.999Z'),
      ]);
    });

    // On 2025-10-26 Paris goes from 03:00 CEST back to 02:00 CET: the hour from 01:00Z to 02:00Z is the second pass of 02:00-03:00
    describe('on a host in Europe/Paris', () => {
      useTimeZone('Europe/Paris');

      it.each`
        startDate                 | endDate                   | batchSize | chunks                                               | expected
        ${'2025-10-26T00:00:00Z'} | ${'2025-10-26T02:59:00Z'} | ${60}     | ${'the three hours around the change, hour by hour'} | ${[chunk('2025-10-26T00:00:00Z', '2025-10-26T00:59:59.999Z'), chunk('2025-10-26T01:00:00Z', '2025-10-26T01:59:59.999Z'), chunk('2025-10-26T02:00:00Z', '2025-10-26T02:59:59.999Z')]}
        ${'2025-10-26T01:30:00Z'} | ${'2025-10-26T03:00:00Z'} | ${1440}   | ${'one chunk from 01:30Z, in the hour repeated'}     | ${[chunk('2025-10-26T01:30:00Z', '2025-10-26T03:00:59.999Z')]}
        ${'2025-10-23T01:30:00Z'} | ${'2025-10-26T01:30:00Z'} | ${1440}   | ${'4321 minutes up to 01:30Z, in the hour repeated'} | ${[chunk('2025-10-23T01:30:00Z', '2025-10-24T01:29:59.999Z'), chunk('2025-10-24T01:30:00Z', '2025-10-25T01:29:59.999Z'), chunk('2025-10-25T01:30:00Z', '2025-10-26T01:29:59.999Z'), chunk('2025-10-26T01:30:00Z', '2025-10-26T01:30:59.999Z')]}
        ${'2025-10-26T00:58:41Z'} | ${'2025-10-26T01:00:07Z'} | ${1440}   | ${'one chunk of 3 minutes across the change'}        | ${[chunk('2025-10-26T00:58:00Z', '2025-10-26T01:00:59.999Z')]}
        ${'2025-10-26T01:00:00Z'} | ${'2025-10-26T01:59:00Z'} | ${1440}   | ${'the second pass of the hour, not the first'}      | ${[chunk('2025-10-26T01:00:00Z', '2025-10-26T01:59:59.999Z')]}
      `('splits $startDate -> $endDate by $batchSize minutes into $chunks', ({ startDate, endDate, batchSize, expected }) => {
        expect(splitIntervals(Date.parse(startDate), Date.parse(endDate), batchSize)).toEqual(expected);
      });
    });
  });
});
