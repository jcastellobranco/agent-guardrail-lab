# @lab/sdk

A small TypeScript client for the guardrail.

```ts
import { GuardrailClient, GuardrailBlockedError } from '@lab/sdk';

const guardrail = new GuardrailClient({
  baseUrl: 'http://127.0.0.1:8000',
  token: () => tokenStore.current(), // called once per attempt, so refreshed tokens are used
  timeoutMs: 250, // total budget across retries
});

// Advisory: you get the decision and must enforce it.
const decision = await guardrail.check({ agentId, tool: 'transfer_money', arguments });

// Safer: the tool callback runs only for allow (and flag, unless allowFlagged is false).
await guardrail.guard(call, () => transferMoney(call.arguments));

// Enforcing: the guardrail itself forwards the call (see "Proxy mode" in the root README).
const result = await guardrail.proxy('transfer_money', { agentId, arguments });
```

## Failure rules

- **Errors are never decisions.** Timeouts, non-200 responses, connection failures and responses that fail `DecisionSchema` validation all throw `GuardrailError`. No code path returns `allow` on failure.
- **Only 503 and connection failures are retried.** Backoff is exponential with full jitter (`random() × initialBackoffMs × 2^attempt`), and every attempt stays inside the single `timeoutMs` deadline. Auth, validation and policy errors (400/401/403/413) fail immediately, because retrying can't change them.
- Retries are safe because checking has no side effect beyond an extra audit record. A retried `proxy` call could execute a tool twice if the first response was lost after forwarding, so prefer idempotent tools, or set `maxRetries: 0` for proxy clients.

`check` is advisory: a caller that skips the SDK skips the guardrail. Use `proxy` and network isolation when bypass must be impossible.
