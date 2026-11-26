import { importSPKI, jwtVerify } from 'jose';
import { AgentClaimsSchema } from '@lab/contracts';
import type { TokenVerifier } from '../application/ports.js';
import { HttpError } from '../domain/errors.js';
type PublicKey = Awaited<ReturnType<typeof importSPKI>>;
export class JwtVerifier implements TokenVerifier {
  private constructor(
    private readonly keys: ReadonlyMap<string, PublicKey>,
    private readonly issuer: string,
    private readonly audience: string,
  ) {}
  static async fromPem(keys: Record<string, string>, issuer: string, audience: string) {
    const entries = await Promise.all(
      Object.entries(keys).map(
        async ([kid, pem]) => [kid, await importSPKI(pem, 'EdDSA')] as const,
      ),
    );
    if (!entries.length) throw new Error('At least one trusted key is required');
    return new JwtVerifier(new Map(entries), issuer, audience);
  }
  async verify(token: string) {
    try {
      if (token.length > 8192) throw new Error('Oversized token');
      const { payload } = await jwtVerify(
        token,
        (header) => {
          if (header.alg !== 'EdDSA' || !header.kid) throw new Error('Unexpected key');
          const key = this.keys.get(header.kid);
          if (!key) throw new Error('Unknown key');
          return key;
        },
        {
          algorithms: ['EdDSA'],
          issuer: this.issuer,
          audience: this.audience,
          requiredClaims: ['sub', 'iat', 'exp', 'jti'],
          maxTokenAge: '5m',
        },
      );
      const claims = AgentClaimsSchema.parse(payload);
      if (
        claims.sub !== claims.agentId ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 300
      )
        throw new Error('Invalid agent claims');
      return claims;
    } catch {
      throw new HttpError(401, 'INVALID_TOKEN');
    }
  }
}
