import { Tag } from '@models/tag.types';
import { GekkoError } from './gekko.error';

/**
 * The graceful stop of a run (the circuit breaker): the plugins are finalised, and Gekko exits with 0. Tagged by its thrower, as every
 * GekkoError is: tagged 'core' whoever threw it, the stop of the circuit breaker read "[CORE] Max consecutive order errors reached (5)"
 * in the interruption of the reports, on Telegram and in the exit log, though the strategy's orders had tripped it.
 */
export class ApplicationStopError extends GekkoError {
  constructor(tag: Tag, message: string) {
    super(tag, message);
    this.name = 'ApplicationStopError';
  }
}
