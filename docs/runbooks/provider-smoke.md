# Provider smoke tests

Provider checks are deployment gates, not ordinary unit tests. Run them with
non-sensitive synthetic inputs and persist only safe metadata: model or
connector ID, status, latency, request ID when safe, and timestamp.

## OpenAI

Verify the configured text, transcription, accuracy-retry, and speech model
against the exact endpoint used in production. Model-catalog access alone does
not prove inference or audio behavior. Audio smoke input must be generated in
memory; dispose transcript and speech bytes before the command exits.

The application must remain usable for local editing, reminders, and approved
deterministic actions when model access is unavailable. The monthly CAD spend
guard must warn at 50 dollars and block new model/audio dispatch at 75 dollars.

## Google

Use a dedicated Calendar OAuth client, not the Better Auth identity client.
Verify PKCE/state, exact redirect, incremental app-owned scopes, refresh,
revocation, disconnect, Calendar reads, a visual-approved conditional write,
and provider readback. Use a dedicated smoke calendar and delete its event only
through another approved conditional action.

## Maps, email, push, and commerce

- Maps: verify deterministic travel-time normalization and the unavailable
  fallback.
- Email and Web Push: use synthetic, non-sensitive notification previews.
- Commerce: enable only an official API or affiliate feed that passes the
  connector conformance suite. Link-out-only retailers remain disabled for
  structured price comparison.

Record every unexecuted provider gate as `not run`, with the missing credential
or external dependency. Never convert it to `passed` from a recorded fixture.
