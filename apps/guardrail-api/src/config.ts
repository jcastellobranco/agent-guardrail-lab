import { z } from 'zod';

const HttpUrl = z
  .string()
  .url()
  .refine((s) => ['http:', 'https:'].includes(new URL(s).protocol));

// Proxy mode allowlist, e.g. {"transfer_money":"http://mock-tool:9000/tools/transfer_money"}.
const ToolUpstreams = z
  .string()
  .default('{}')
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'TOOL_UPSTREAMS_JSON must be JSON' });
      return z.NEVER;
    }
  })
  .pipe(z.record(HttpUrl));

const Config = z.object({
  INFERENCE_URL: z
    .string()
    .url()
    .refine((s) => ['http:', 'https:'].includes(new URL(s).protocol))
    .default('http://127.0.0.1:8001'),
  INFERENCE_HEADROOM_MS: z.coerce.number().int().min(0).max(1000).default(5),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  HOST: z.string().default('127.0.0.1'),
  JWT_ISSUER: z.string().default('agent-guardrail-lab'),
  JWT_AUDIENCE: z.string().default('guardrail-api'),
  JWT_PUBLIC_KEY_PATH: z.string().default('.dev-keys/public.pem'),
  JWT_KEY_ID: z.string().default('dev-key'),
  POLICY_BUNDLE_PATH: z.string().default('.dev-keys/bundle.json'),
  SILO_TENANT: z.string().default('tenant-a'),
  LATENCY_BUDGET_MS: z.coerce.number().int().min(1).max(5000).default(50),
  MAX_POLICY_AGE_MS: z.coerce.number().int().positive().default(86400000),
  TOOL_UPSTREAMS_JSON: ToolUpstreams,
  TOOL_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1).max(60000).default(5000),
  PROXY_FLAGGED_CALLS: z.enum(['forward', 'block']).default('forward'),
});
export const readConfig = () => Config.parse(process.env);
