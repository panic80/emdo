# Google Calendar OAuth boundary

This module owns Calendar authorization only. Better Auth owns Google identity
sign-in (`openid`, `email`, and `profile`) through a different OAuth client. The
constructor rejects reuse of the identity client ID.

## API wiring

Expose only `GoogleCalendarOAuthRouteService` from the API layer:

- begin authorization: server-derived actor plus `calendar-read` or
  `calendar-event-write` purpose;
- callback: server-derived actor plus Google `state` and either `code` or
  provider error;
- status and disconnect: server-derived actor only.

Do not copy actor, scopes, redirect URIs, OAuth client configuration, or tokens
from a client or model. The exported Zod schemas validate the assembled route
service inputs. The route facade intentionally omits
`acquireAccessTokenForCapability`, which is for the deterministic Calendar
capability executor only.

## Production dependencies

Production assembly must provide:

- a durable `GoogleOAuthFlowStore` whose consume operation is atomic and
  single-use and whose actor invalidation ignores the session while matching
  exact user, household, and private space;
- a durable `GoogleOAuthAuthorizationEpochStore` whose atomic epoch tombstone
  survives credential deletion and is serialized by the same grant lease;
- an `EncryptedGoogleCalendarGrantStore` with exact revision compare-and-set;
- a cross-process `GoogleOAuthGrantLease` keyed by the private Calendar grant;
- a durable sanitized `GoogleOAuthAuditSink`;
- a Google transport that maps provider failures to
  `GoogleOAuthTransportFailure` without logging request or token material.

`RecordedGoogleOAuthTransport` and `InMemoryGoogleOAuthFlowStore` are direct
test/eval imports and are intentionally absent from the production module
surface. This slice performs no live Google calls and reads no credentials.

Every callback is bound to both the credential revision and durable
authorization epoch captured at start. Disconnect advances the epoch before
revocation or deletion, so a stale credential or pending flow remains unusable
after a partial failure. Provider-returned scopes are evidence only: callback
authority is limited to the exact app-owned prior-scope/requested-scope union,
and refresh responses may only reduce that set.
