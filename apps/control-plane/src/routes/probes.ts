import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ProbeArtifactSchema, ProbeSegment } from '@lab/contracts';
import { probeArtifacts } from '@lab/database';
import type { ControlDatabase } from '../config.js';

const params = z.object({ probeId: ProbeSegment, version: ProbeSegment });

/** Admin upload of trained probe artifacts. Versions are immutable once published. */
export function registerProbeRoutes(admin: FastifyInstance, db: ControlDatabase) {
  admin.get('/probes', async () =>
    db
      .select({
        probeId: probeArtifacts.probeId,
        version: probeArtifacts.version,
        sha256: probeArtifacts.sha256,
        createdAt: probeArtifacts.createdAt,
      })
      .from(probeArtifacts),
  );

  admin.put('/probes/:probeId/versions/:version', async (req, reply) => {
    const { probeId, version } = params.parse(req.params);
    const artifact = ProbeArtifactSchema.parse(req.body);
    if (artifact.probeId !== probeId || artifact.version !== version) {
      return reply.code(400).send({ error: 'SCOPE' });
    }
    // Store the canonical serialization: these exact bytes are what gets signed later.
    const payload = JSON.stringify(artifact);
    const sha256 = createHash('sha256').update(payload).digest('hex');

    await db
      .insert(probeArtifacts)
      .values({ probeId, version, payload, sha256 })
      .onConflictDoNothing();
    const [stored] = await db
      .select({ sha256: probeArtifacts.sha256 })
      .from(probeArtifacts)
      .where(and(eq(probeArtifacts.probeId, probeId), eq(probeArtifacts.version, version)));

    // Re-uploading identical content is idempotent; different content under a version is not.
    if (stored?.sha256 !== sha256) return reply.code(409).send({ error: 'ARTIFACT_IMMUTABLE' });
    return { probeId, version, sha256 };
  });
}
