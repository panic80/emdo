import { describe, expect, it } from 'vitest';

describe('Google Calendar OAuth package surface', () => {
  it('exports production route, broker, and encrypted-vault boundaries without recorded or in-memory adapters', async () => {
    const api = await import('./index.js');

    expect(api).toHaveProperty('GoogleCalendarOAuthService');
    expect(api).toHaveProperty('GoogleCalendarOAuthError');
    expect(api).toHaveProperty('GoogleOAuthTransportFailure');
    expect(api).toHaveProperty('createGoogleCalendarOAuthRouteService');
    expect(api).toHaveProperty(
      'createUnavailableGoogleCalendarOAuthRouteService',
    );
    expect(api).toHaveProperty('GoogleCalendarAuthorizationStartInputSchema');
    expect(api).toHaveProperty('GoogleCalendarOAuthCallbackInputSchema');
    expect(api).toHaveProperty('GoogleCalendarConnectionActorInputSchema');
    expect(api).toHaveProperty('EncryptedGoogleCalendarCredentialVault');
    expect(api).not.toHaveProperty('RecordedGoogleOAuthTransport');
    expect(api).not.toHaveProperty('InMemoryGoogleOAuthFlowStore');
  });
});
