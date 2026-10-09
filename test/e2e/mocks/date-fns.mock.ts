import { ONE_MINUTE } from '@constants/time.const';

/**
 * The date-fns functions that count minutes and that the code still imports, on the ONE_MINUTE the realtime flows shorten. The streams
 * and the pipeline floor their minutes with startOfMinuteUTC, which reads ONE_MINUTE itself.
 */
export const mockDateFns = {
  addMinutes: (date: number | Date, amount: number) => {
    return new Date(new Date(date).getTime() + amount * ONE_MINUTE);
  },
  // Rounded toward 0 as date-fns rounds it (−30 s is 0 minutes, not −1), and never −0
  differenceInMinutes: (laterDate: number | Date, earlierDate: number | Date) => {
    const minutes = Math.trunc((new Date(laterDate).getTime() - new Date(earlierDate).getTime()) / ONE_MINUTE);
    return minutes === 0 ? 0 : minutes;
  },
};
