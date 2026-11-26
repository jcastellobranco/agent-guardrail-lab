import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InferenceRequestSchema, InferenceResponseSchema } from '../src/index.js';
const fixture = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/inference-contract.json', import.meta.url), 'utf8'),
) as Record<'requests' | 'responses', { valid: boolean; value: unknown }[]>;
describe('cross-language inference contract', () => {
  it.each(fixture.requests)('request fixture %#', ({ valid, value }) =>
    expect(InferenceRequestSchema.safeParse(value).success).toBe(valid),
  );
  it.each(fixture.responses)('response fixture %#', ({ valid, value }) =>
    expect(InferenceResponseSchema.safeParse(value).success).toBe(valid),
  );
});
