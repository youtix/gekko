import { Asset } from './utility.types';

export type BalanceDetail = {
  free: number;
  used: number;
  total: number;
};

export type Portfolio = Map<Asset, BalanceDetail>;
