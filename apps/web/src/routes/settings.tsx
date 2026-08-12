import { useEffect, useState } from 'react';

import type { SettingsView } from '@emdo/contracts/browser';

import { Button } from '../components/button.js';
import { Icon } from '../components/icon.js';
import { Page, PageHeader } from '../components/page.js';
import { useAuth } from '../features/auth/auth-context.js';
import { useDomainData } from '../features/domains/domain-data.js';
import { useExperienceApi } from '../features/experience/experience-api.js';
import { NotificationPreferencesForm } from '../features/notifications/preferences-form.js';
import { LogoutPanel } from '../features/sync/logout-panel.js';

const calendarStatus = (calendar: SettingsView['calendar']) => {
  switch (calendar.status) {
    case 'connected':
      return calendar.lastSyncedAt ? 'Connected and synced' : 'Connected';
    case 'syncing':
      return 'Syncing';
    case 'retry-pending':
      return 'Retry pending';
    case 'disconnected':
      return 'Disconnected';
    case 'unavailable':
      return 'Unavailable';
  }
};

export function SettingsRoute() {
  const api = useExperienceApi();
  const auth = useAuth();
  const domain = useDomainData();
  const [settings, setSettings] = useState<SettingsView>();
  const [settingsUnavailable, setSettingsUnavailable] = useState(false);
  const [passkeyName, setPasskeyName] = useState('This device');
  const [passkeyStatus, setPasskeyStatus] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void api
      .readSettings({ signal: controller.signal })
      .then(setSettings, () => {
        if (!controller.signal.aborted) setSettingsUnavailable(true);
      });
    return () => controller.abort();
  }, [api]);

  const offlineState =
    domain.state === 'ready' || domain.state === 'offline-ready'
      ? 'Ready'
      : domain.state === 'initializing'
        ? 'Loading'
        : 'Locked';

  return (
    <Page>
      <PageHeader
        title="Settings"
        description="Household access, connections, offline data, and notifications."
      />
      <div className="settings-layout">
        <section
          className="settings-section"
          aria-labelledby="household-settings-heading"
        >
          <h2 id="household-settings-heading">Household</h2>
          {settings ? (
            <dl>
              <div>
                <dt>Household</dt>
                <dd>{settings.household.name}</dd>
              </div>
              <div>
                <dt>Your role</dt>
                <dd>{settings.household.role}</dd>
              </div>
              <div>
                <dt>Private spaces</dt>
                <dd>
                  {settings.privateSpaces.length === 0
                    ? 'None'
                    : settings.privateSpaces.map(({ name }) => name).join(', ')}
                </dd>
              </div>
            </dl>
          ) : settingsUnavailable ? (
            <p role="status">Household settings are unavailable.</p>
          ) : (
            <p role="status">Loading household settings…</p>
          )}
        </section>
        <section
          className="settings-section"
          aria-labelledby="connection-settings-heading"
        >
          <h2 id="connection-settings-heading">Connections</h2>
          <div className="connection-row">
            <span>
              <Icon name="calendar" />
              <span>
                <strong>Google Calendar</strong>
                <small>Identity and Calendar grants are separate.</small>
              </span>
            </span>
            <em>
              {settings ? calendarStatus(settings.calendar) : 'Unavailable'}
            </em>
          </div>
          <div className="connection-row">
            <span>
              <Icon name="sync" />
              <span>
                <strong>Offline data</strong>
                <small>
                  Encrypted locally; the API remains the write authority.
                </small>
              </span>
            </span>
            <em>{offlineState}</em>
          </div>
        </section>
        <section
          className="settings-section"
          aria-labelledby="security-settings-heading"
        >
          <h2 id="security-settings-heading">Security</h2>
          <label htmlFor="passkey-name">Passkey name</label>
          <input
            id="passkey-name"
            value={passkeyName}
            onChange={(event) => setPasskeyName(event.target.value)}
          />
          <Button
            variant="secondary"
            disabled={!auth.csrfToken}
            onClick={() => {
              if (!auth.csrfToken) return;
              setPasskeyStatus(undefined);
              void auth.client
                .registerPasskey(passkeyName, auth.csrfToken)
                .then(
                  () => setPasskeyStatus('Passkey added to your account.'),
                  () =>
                    setPasskeyStatus(
                      'That passkey could not be added. Try again.',
                    ),
                );
            }}
          >
            <Icon name="lock" size={18} /> Add passkey
          </Button>
          {passkeyStatus ? <p role="status">{passkeyStatus}</p> : null}
        </section>
        <NotificationPreferencesForm />
        <LogoutPanel
          boundary={domain.logoutBoundary}
          onComplete={() => void auth.refresh()}
        />
      </div>
    </Page>
  );
}
