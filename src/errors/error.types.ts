/** The value an order asked for, before the order layer rounded it to the step of the market, and that step when the market has one */
export type Rounding = { requested: number; step?: number };
