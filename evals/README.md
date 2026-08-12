# EMDO agent eval harness

This directory contains the executable, provider-free regression suite for the
manager and specialist runtime. Run it from the repository root:

```sh
pnpm evals
pnpm exec tsc --project evals/tsconfig.json --noEmit
```

`src/runner.ts` is the only evaluator. It drives an injected
`AgentEvalDriver` through the same `start` and `resume` phases used by an
orchestrator adapter, snapshots bounded trace data, and checks declarative
assertions from `src/cases.ts`. The runner has no model-provider or domain
client dependency.

`fixtures/reference-driver.ts` is deterministic test infrastructure. It proves
the harness and model-routing policy without an API key; it is not evidence
that OpenAI, Google, Maps, or commerce providers are reachable. A production
runtime adapter in `src/orchestrator-driver.ts` normalizes app-owned local trace
events into the same contract. `orchestrator-integration.test.ts` runs central
cases through the production `AgentOrchestrator`, including bounded parallel
dispatch, dependency waves, partial failure, model routing, and encrypted
approval checkpoint resume with a proposal-decision gateway. Live provider
smoke and contract tests remain separate release gates.

`production-safety-integration.test.ts` runs the same central safety cases
through the live deny-by-default toolbox registry, the deterministic CAD sum,
the commerce-offer normalizer, and production contract schemas. The injection
case submits the actual forbidden capability IDs to the strict registry and
accepts only the exact `capability-not-allowlisted` denial; it does not claim
that a live model was sampled.

The orchestrator integration binds the authoritative disclosure gateway to the
exact run, grant version, purpose, provider, and dispatch-time expiry. It binds
each disclosed record to its authoritative data class and exact field set,
proves zero model I/O for cross-run and expired grants, submits a deliberate
typed-text resume probe, and verifies one-time authenticated visual resume. The
real OpenAI Agents SDK facade and execution provider are exercised with a fake
SDK runner to prove turn-wide provider-write limits without an API key: a
second write abandons the exact prepared proposal and creates no checkpoint or
provider action. A failed approval-interruption trace write must likewise
cancel the encrypted checkpoint and abandon the proposal before returning.

Live OpenAI/model behavior, Google, Maps, and commerce provider smoke tests
remain separate deployment gates and must not be inferred from this
provider-free suite.

The suite covers:

- single-domain routing, three-way independent dispatch, and dependency waves;
- deny-by-default capabilities and indirect prompt injection containment;
- derived-value evidence lineage, freshness, and one-run field disclosure;
- partial specialist failure synthesis;
- Luna-to-Terra fallback, safety-required Terra failure, and dual
  unavailability while local features remain usable;
- authenticated visual approval interruption, exact one-time resume, and the
  rule that typed text cannot approve a provider write;
- single-write-per-turn enforcement, exact prepared-proposal abandonment, and
  checkpoint/audit failure cleanup.

The mandatory command discovers every central eval test plus the package-local
scheduler and shopping deterministic suites. Finance behavior is covered by
the central CAD lineage cases, while the suite registry test resolves the
manager, scheduler, finance, and shopping manifest eval references.

Driver exceptions and timeouts become redacted eval failures. Runtime-owned
objects are copied before validation and are never retained or frozen by the
harness.
