/** A sum that starts from its first item, as lodash's does: one that starts from 0 turns a sum of -0 into 0 */
export const addFromFirst = (sum: number | undefined, item: number) => (sum === undefined ? item : sum + item);

/** A value as a refusal names it: a string quoted, so that '3' does not read as the number 3 */
export const show = (value: unknown) => (typeof value === 'string' ? JSON.stringify(value) : String(value));
