import { describe, expect, it } from 'vitest';
import { ApplicationStopError } from './applicationStop.error';
import { GekkoError } from './gekko.error';

const REASON = 'Max consecutive order errors reached (5)';

describe('ApplicationStopError', () => {
  // Tagged 'core' whoever threw it, the stop of the circuit breaker named the core in the reports, on Telegram and in the exit log
  it.each`
    form                   | error                                           | message
    ${'given a tag'}       | ${new ApplicationStopError('strategy', REASON)} | ${`[STRATEGY] ${REASON}`}
    ${'given another tag'} | ${new ApplicationStopError('trader', REASON)}   | ${`[TRADER] ${REASON}`}
  `('prefixes its message with the tag of its thrower, $form: $message', ({ error, message }) => {
    expect(error.message).toBe(message);
  });

  it('is named ApplicationStopError', () => {
    expect(new ApplicationStopError('strategy', REASON).name).toBe('ApplicationStopError');
  });

  // The pipeline tells the graceful stop from a crash by its class, and reports it as any GekkoError, on one line
  it('is a GekkoError', () => {
    expect(new ApplicationStopError('strategy', REASON)).toBeInstanceOf(GekkoError);
  });
});
