import { LogLevel } from './logLevel.types';
import { Tag } from './tag.types';

export type StrategyInfo = {
  timestamp: EpochTimeStamp;
  tag: Tag;
  level: LogLevel;
  message: string;
};
