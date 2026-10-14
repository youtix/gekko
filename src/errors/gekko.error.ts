import { Tag } from '@models/tag.types';
import { upperCase } from 'lodash-es';

/**
 * A failure Gekko expects and explains in one line, its message starting with the tag of the part of Gekko that throws it, upper-cased
 * in brackets: "[STORAGE] Cannot open the database …". `options.cause` keeps the failure it wraps, which main() appends to its report.
 * A line that quotes the error under a tag of its own, a log line or another GekkoError, quotes `untaggedMessage` (see describeError):
 * without it, the tag had to be cut off the message with a regular expression, or the line showed two tags.
 */
export class GekkoError extends Error {
  /** The part of Gekko that throws it */
  readonly tag: Tag;
  /** Its message without the tag */
  readonly untaggedMessage: string;

  constructor(tag: Tag, message: string, options?: ErrorOptions) {
    super(`[${upperCase(tag)}] ${message}`, options);
    this.name = 'GekkoError';
    this.tag = tag;
    this.untaggedMessage = message;
  }
}
