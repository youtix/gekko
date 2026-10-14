import { describeError } from '@errors/error.utils';
import { error } from '@services/logger';
import { wait } from '@utils/process/process.utils';
import { HandleCommand } from './bots.types';

// After a failed check, each wait doubles, up to this many intervals (a minute with the default interval): a network that stays
// down is then tried, and its failure logged, about once a minute rather than at every interval.
const MAX_BACKOFF_FACTOR = 60;

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
   * after a successful one. A second by default, written in ms and not as ONE_SECOND, which the realtime e2e flows shrink to 1 ms:
   * their Telegram, a mock that answers at once, would be polled every millisecond.
   */
  public async listen(interval = 1000) {
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
