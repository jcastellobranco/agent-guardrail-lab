import type { database } from '@lab/database';

export type Config = {
  adminToken: string;
  syncTokens: ReadonlyMap<string, string>;
  jwtPem: string;
  bundlePem: string;
  jwtKid: string;
  bundleKid: string;
  issuer: string;
  audience: string;
  bundleTtlMs: number;
};

export type ControlDatabase = ReturnType<typeof database>['db'];
