# Production Voice Provider Design

**Date:** 2026-08-15

**Status:** Approved under the repository owner's standing authorization to proceed without repeated clarification.

## Goal

Turn the existing fail-closed `voice.provider` placeholder into a real, API-only production binding without weakening the durable audio receipt, authenticated request, spend, privacy, or evidence boundaries. The batch composes the already-tested OpenAI audio adapter and transport; it does not claim live-provider, browser, staging, or production acceptance merely because local tests pass.

## Chosen approach

Use a complete vertical composition:

1. Inspect untrusted audio in a short-lived worker thread using byte-signature detection plus `music-metadata` duration parsing. The worker receives a copied/transferred buffer, never a path, and is terminated on a strict deadline.
2. Create a request-bound spend guard over `PostgresSpendLedger`. All authorization and request hashes are derived from the authenticated principal and canonical operation data, never from client input.
3. Use a strict, versioned integer-CAD pricing document supplied through API-only configuration. The calculator always rounds each positive operation up to the next CAD cent because the current durable ledger stores minor units.
4. Adapt the existing `OpenAiAudioAdapter` and `OpenAiFetchAudioTransport` to `VoiceGateway`, preserving their reserve-before-dispatch, dispatch fencing, settlement, late-result disposal, and transient-byte zeroization behavior.
5. Expose the voice binding only when both the durable voice receipt surface and trusted authentication are composed. Synthetic staging and any partially configured environment remain unavailable.

Two alternatives were rejected. Trusting browser duration or MIME would make untrusted claims authoritative. Narrowing production to WAV would contradict the established WebM browser path and public API contract. Completing the full agent runtime first was deferred because its seventeen authority seams are not one coherent, reviewable batch.

## Architecture

### Trusted media inspection

`createProductionAudioInspector` owns no persistent storage. It first enforces the existing byte limit, normalizes the declared media type, and copies the bytes into a dedicated worker. The worker:

- uses `file-type` magic-byte detection as a best-effort type classifier;
- parses duration and audio format from the same in-memory bytes with `music-metadata` using `duration: true` and `skipCovers: true`;
- accepts only the six existing declared media types and their explicit detected aliases;
- requires a finite positive duration at or below 60 seconds and a parsed audio stream;
- returns only `{verifiedContentType, durationMs}`;
- zeroes its owned view in `finally` and never logs metadata or input bytes.

The parent terminates the worker after a short fixed deadline and maps parse, timeout, mismatch, and malformed-result failures to bounded rejection codes. It never writes a temporary file. Current official package documentation confirms that `music-metadata` supports in-memory `parseBuffer`, duration extraction, and WebM/Ogg/MP4/WAV/MPEG families; `file-type` recommends a worker plus timeout for untrusted server input.

### Request-bound provider gateway

The production voice service keeps only immutable provider configuration, the OpenAI transport, the audio inspector, the pricing calculator, and the scoped database pool. Each `transcribe` or `speak` call:

1. parses a fresh authenticated principal and exact request ID;
2. derives an authorization hash from household, user, session, request, grant, collection-scope fingerprint, operation, execution, and reservation;
3. derives a request hash from the canonical provider input, using an SHA-256 audio digest rather than retaining audio bytes for transcription;
4. creates a `PostgresSpendLedger` and a narrow `OpenAiAudioSpendGuard` for that request;
5. creates an `OpenAiAudioAdapter` with the shared transport and immutable pricing calculator;
6. maps only bounded adapter results into `VoiceGateway` results.

The gateway does not cache principals, grants, audio, text, or provider responses. Transcription bytes remain owned by the route and are copied/zeroed again inside the adapter. Speech response ownership transfers exactly once to the route; any mapping or response failure disposes the bytes before returning.

### Pricing and spend

Pricing is deployment data, not a source-code constant. `EMDO_OPENAI_AUDIO_PRICING_B64URL` contains strict base64url JSON with:

- `schemaVersion: 1`;
- an opaque safe `pricingVersion`;
- positive integer CAD-micros-per-minute rates for both transcription models;
- positive integer CAD-micros-per-million-characters rates for each allowed speech model.

The calculator uses integer arithmetic and ceiling division. Transcription estimate and settlement use server-verified duration; speech estimate and settlement use validated input characters. Every positive operation becomes at least one CAD cent, so sub-cent costs are never silently rounded down. The durable database retains the existing CAD 50 warning and CAD 75 hard monthly limit.

A forward migration adds an exact readiness function for the existing spend ledger and functions. It verifies forced RLS, owner/role attributes, fixed `search_path`, `row_security=on`, and the intended EXECUTE-only application ACL. It does not change historical spend behavior.

### Configuration, readiness, and shutdown

Voice configuration is all-or-nothing and API-only:

- `EMDO_OPENAI_AUDIO_API_KEY`;
- `EMDO_OPENAI_SPEECH_MODEL`;
- `EMDO_OPENAI_AUDIO_PRICING_B64URL`.

Partial, malformed, oversized, duplicated, or unsupported configuration fails closed during composition. The key is never copied into worker or browser configuration, never emitted in diagnostics, and never mounted into worker/synthetic-staging environments.

`voice.provider` readiness is true only when configuration is valid, the inspector self-check succeeds, the exact spend database probe succeeds, and the bounded OpenAI model-catalog check succeeds. The catalog check is cached briefly with one in-flight promise, bounded by timeout, and explicitly claims catalog access only. Credentialed transcription and speech endpoint smoke receipts remain separate acceptance evidence.

Shutdown rejects new voice operations, waits for active gateway calls to drain, then disposes transport/config references. Database pool ownership remains with durable service composition and closes only after voice draining completes.

## Failure handling

- Invalid media, duration, MIME mismatch, or invalid provider input returns a bounded non-retryable error before provider dispatch.
- Configuration, inspector, network, timeout, or invalid provider response returns a bounded retryable provider error without leaking body text.
- Spend block returns the existing safe monthly-limit error.
- Any reserve, dispatch-mark, settle, durable receipt, or ambiguous provider state fails closed and retains the existing reconciliation signal.
- Receipt release/indeterminate persistence failures are not swallowed. Once the route has entered a durable command, a failed terminal transition becomes a bounded indeterminate response rather than a false success.
- Transient audio buffers are zeroed on every normal, exceptional, timeout, late-result, and response-write path that still owns them.

## Verification boundaries

TDD will cover:

- real in-memory WAV parsing plus injected format-family cases, mismatch, malformed data, missing duration, over-duration, worker timeout, and zeroization behavior;
- strict pricing parsing, integer ceiling, overflow, model separation, and no price fallback;
- exact request-bound spend hashes and reserve/dispatch/settle/release mapping;
- configuration absence/partiality, auth-gated assembly, readiness caching, drain-before-close, and safe diagnostics;
- voice route behavior when durable terminal persistence fails;
- package exports, pruned API build dependency closure, TypeScript, lint, and formatting;
- an isolated PostgreSQL 17 test for the new readiness/ACL function and the existing spend lifecycle.

Provider smoke, real browser WebM recording/storage, synthetic staging, and authenticated production proof remain separate gates. This batch may make `voice.provider` locally ready, but it does not complete the overall MVP or authorize a release.
