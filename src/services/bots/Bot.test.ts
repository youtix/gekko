import { error } from '@services/logger';
import { sum } from 'lodash-es';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bot } from './Bot';

vi.mock('@services/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));

class TestBot extends Bot {
  public checkUpdates = vi.fn<() => Promise<void>>();
}

describe('Bot', () => {
  let bot: TestBot;

  beforeEach(() => {
    vi.useFakeTimers();
    bot = new TestBot();
    bot.checkUpdates.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    // Ends the loop of the test, which would otherwise stay suspended on a timer of the fake clock about to be discarded
    bot.close();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  describe('listen', () => {
    it('checks for updates every interval', async () => {
      bot.listen(200);
      await vi.advanceTimersByTimeAsync(400);
      expect(bot.checkUpdates).toHaveBeenCalledTimes(3);
    });

    it('checks for updates every second by default', async () => {
      bot.listen();
      await vi.advanceTimersByTimeAsync(2000);
      expect(bot.checkUpdates).toHaveBeenCalledTimes(3);
    });

    it('stops checking for updates once closed', async () => {
      bot.listen(100);
      bot.close();
      await vi.advanceTimersByTimeAsync(300);
      expect(bot.checkUpdates).toHaveBeenCalledOnce();
    });

    it.each`
      outcome        | check
      ${'succeeded'} | ${() => Promise.resolve()}
      ${'failed'}    | ${() => Promise.reject(new Error('Network down'))}
    `('resolves once closed after a check that $outcome', async ({ check }) => {
      bot.checkUpdates.mockImplementation(check);
      const listening = bot.listen(100);
      bot.close();
      await vi.advanceTimersByTimeAsync(200);
      await expect(listening).resolves.toBeUndefined();
    });

    // The gaps are the waits between consecutive checks, with an interval of 100 ms: doubled after each failed check, up to
    // 60 intervals, and back to one interval after a successful check
    it.each`
      outcomes                                      | gaps
      ${['ok', 'ok', 'ok']}                         | ${[100, 100]}
      ${['fail', 'fail', 'fail', 'ok']}             | ${[200, 400, 800]}
      ${['fail', 'fail', 'ok', 'fail', 'ok', 'ok']} | ${[200, 400, 100, 200, 100]}
      ${Array(8).fill('fail')}                      | ${[200, 400, 800, 1600, 3200, 6000, 6000]}
    `('waits $gaps ms between checks that go $outcomes', async ({ outcomes, gaps }) => {
      const checkTimes: number[] = [];
      bot.checkUpdates.mockImplementation(async () => {
        checkTimes.push(Date.now());
        if (outcomes[checkTimes.length - 1] === 'fail') throw new Error('Network down');
      });
      bot.listen(100);
      await vi.advanceTimersByTimeAsync(sum(gaps));
      const actualGaps = checkTimes.slice(1, outcomes.length).map((time, i) => time - checkTimes[i]);
      expect(actualGaps).toEqual(gaps);
    });

    describe('when a check fails', () => {
      // A string as it is, which util.inspect quoted
      it.each`
        rejection                                              | reason
        ${new Error('Network down')}                           | ${'Network down'}
        ${'socket hang up'}                                    | ${'socket hang up'}
        ${{ status: 502 }}                                     | ${'{ status: 502 }'}
        ${Object.assign(Object.create(null), { status: 502 })} | ${'[Object: null prototype] { status: 502 }'}
      `('logs the failure with the bot tag and $reason as the reason', async ({ rejection, reason }) => {
        bot.checkUpdates.mockRejectedValueOnce(rejection);
        bot.listen(100);
        await vi.advanceTimersByTimeAsync(0);
        expect(error).toHaveBeenCalledExactlyOnceWith('bot', `Failed to check for updates, next check in 200 ms: ${reason}`);
      });

      it('checks for updates again', async () => {
        bot.checkUpdates.mockRejectedValueOnce(new Error('Network down'));
        bot.listen(100);
        await vi.advanceTimersByTimeAsync(200);
        expect(bot.checkUpdates).toHaveBeenCalledTimes(2);
      });
    });
  });
});
