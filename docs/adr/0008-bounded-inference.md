# ADR 0008: Bounded inference, no queue on the synchronous decision path

Status: accepted for milestone 2.

The Guardrail API uses the remaining request deadline minus a configurable response reserve, races inference against a timer, and aborts the HTTP request when finished or timed out. The Python service admits one forward pass at a time and rejects overflow with 503. A dedicated executor keeps PyTorch off the HTTP event loop; it also protects the shared mutable forward-hook state. A client-side abort does not necessarily interrupt a running CPU forward pass. The slot remains held until actual completion.

Deterministic blocks bypass inference entirely. A flag survives a lower-severity model score or fail-open degradation. Invalid/partial scores, unknown versions, input limits, unavailable service and timeout apply the policy's fail mode. Auth, missing policies and incomplete deterministic rules remain fail closed. No retry is attempted within the hot path. Default deadline is 50 ms, not a real-time guarantee or measured SLO. Local CPU inference may miss it frequently.

Alternative: a bounded microbatch queue may raise throughput under concurrency but increases waiting time and changes deadline behavior. Separate workers or model replicas increase capacity at a memory cost. Revisit in milestone 6 using real p50/p95/p99 results.
