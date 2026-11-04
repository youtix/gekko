/**
 * The most minutes in a row the gap filler fills with empty candles for a pair, missing alone or with every other pair (7 days): a
 * longer gap is an error, not weeks of flat candles. A pair's exchange history that skips more is refused as it is read, before
 * any of it is filled.
 */
export const MAX_GAP_FILL_MINUTES = 7 * 24 * 60;
