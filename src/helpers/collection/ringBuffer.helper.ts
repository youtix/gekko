/** A sum that starts from its first item, as lodash's does: one that starts from 0 turns a sum of -0 into 0 */
export const addFromFirst = (sum: number | undefined, item: number) => (sum === undefined ? item : sum + item);
