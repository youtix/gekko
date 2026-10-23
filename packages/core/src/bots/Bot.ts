import { ONE_SECOND } from '@gekko/shared/constants/time.const';
import { describeError } from '@gekko/shared/errors/error.helper';
import { error } from '../logger/logger';
import { wait } from '@gekko/shared/utils/process/process.utils';
import { MAX_BACKOFF_FACTOR } from './bots.const';
import { HandleCommand } from './bots.types';

export abstract class Bot {
  protected handleCommand?: HandleCommand;
  private isListening: boolean;

  constructor(handleCommand?: HandleCommand) {
    this.handleCommand = handleCommand;
    this.isListening = false;
  }

  protected abstract checkUpdates(): Promise<void>;

  /**
   * Checks for updates every `interval` ms until close(). Never rejects: the callers float the promise, and a failed check (the
   * network down, a reply that could not be sent) must not end the polling for the rest of the process. A failure is logged and
   * the loop backs off: the wait doubles after each failed check, up to MAX_BACKOFF_FACTOR intervals, and is back to `interval`
   * after a successful one. A second by default.
   */
  public async listen(interval = ONE_SECOND) {
    this.isListening = true;
    let delay = interval;
    while (this.isListening) {
      try {
        await this.checkUpdates();
        delay = interval;
      } catch (err) {
        delay = Math.min(delay * 2, interval * MAX_BACKOFF_FACTOR);
        // Never throws, even for a value without a prototype: the failure would escape and end the loop after all
        error('bot', `Failed to check for updates, next check in ${delay} ms: ${describeError(err)}`);
      }
      await wait(delay);
    }
  }

  /** The loop stops once the check or the wait in progress is over. */
  public close() {
    this.isListening = false;
  }
}
