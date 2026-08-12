import { useEffect, useState } from 'react';

import type { NotificationPreferencesView } from '@emdo/contracts/browser';

import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
import {
  ExperienceApiError,
  useExperienceApi,
} from '../experience/experience-api.js';

const preferenceIdempotencyKey = () =>
  `web.notification-preferences.${crypto.randomUUID()}`;

export function NotificationPreferencesForm() {
  const api = useExperienceApi();
  const auth = useAuth();
  const [preferences, setPreferences] = useState<NotificationPreferencesView>();
  const [state, setState] = useState<
    | 'loading'
    | 'ready'
    | 'saving'
    | 'saved'
    | 'conflict'
    | 'error'
    | 'unavailable'
  >('loading');

  useEffect(() => {
    const controller = new AbortController();
    void api.getNotificationPreferences({ signal: controller.signal }).then(
      (view) => {
        if (controller.signal.aborted) return;
        setPreferences(view);
        setState('ready');
      },
      () => {
        if (!controller.signal.aborted) setState('unavailable');
      },
    );
    return () => controller.abort();
  }, [api]);

  if (state === 'loading') return <p role="status">Loading preferences…</p>;
  if (state === 'unavailable' || !preferences) {
    return <p role="status">Notification preferences are unavailable.</p>;
  }

  const setPreference = (
    key: 'inApp' | 'push' | 'email' | 'spokenReplies',
    checked: boolean,
  ) => {
    setPreferences((current) =>
      current ? { ...current, [key]: checked } : current,
    );
    setState('ready');
  };

  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!auth.csrfToken || state === 'saving') return;
        const controller = new AbortController();
        const attempted = {
          inApp: preferences.inApp,
          push: preferences.push,
          email: preferences.email,
          spokenReplies: preferences.spokenReplies,
        };
        setState('saving');
        void api
          .updateNotificationPreferences(
            {
              expectedVersion: preferences.version,
              preferences: attempted,
              csrfToken: auth.csrfToken,
              idempotencyKey: preferenceIdempotencyKey(),
            },
            { signal: controller.signal },
          )
          .then(
            (view) => {
              setPreferences(view);
              setState('saved');
            },
            (error) => {
              if (error instanceof ExperienceApiError && error.status === 409) {
                void api
                  .getNotificationPreferences({
                    signal: controller.signal,
                  })
                  .then(
                    (current) => {
                      setPreferences({ ...current, ...attempted });
                      setState('conflict');
                    },
                    () => setState('error'),
                  );
                return;
              }
              setState('error');
            },
          );
      }}
    >
      <fieldset disabled={state === 'saving'}>
        <legend>Notifications and spoken replies</legend>
        <label>
          <input
            checked={preferences.inApp}
            onChange={(event) => setPreference('inApp', event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>In-app notifications</strong>
            <small>Show reminders and sync outcomes inside EMDO.</small>
          </span>
        </label>
        <label>
          <input
            checked={preferences.push}
            onChange={(event) => setPreference('push', event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>Web Push</strong>
            <small>External previews omit sensitive details.</small>
          </span>
        </label>
        <label>
          <input
            checked={preferences.email}
            onChange={(event) => setPreference('email', event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>Email reminders</strong>
            <small>Send non-sensitive transactional reminders.</small>
          </span>
        </label>
        <label>
          <input
            checked={preferences.spokenReplies}
            onChange={(event) =>
              setPreference('spokenReplies', event.target.checked)
            }
            type="checkbox"
          />
          <span>
            <strong>Spoken replies</strong>
            <small>
              Available only for a push-to-talk turn that requests it.
            </small>
          </span>
        </label>
      </fieldset>
      <div className="settings-form__actions">
        <Button
          busy={state === 'saving'}
          disabled={!auth.csrfToken}
          type="submit"
        >
          Save preferences
        </Button>
        {state === 'saved' ? (
          <span role="status">Preferences saved.</span>
        ) : null}
        {state === 'conflict' ? (
          <span role="status">
            Preferences changed elsewhere. Review and save again.
          </span>
        ) : null}
        {state === 'error' ? (
          <span role="status">
            Preferences were not saved. Your choices are still here; try again.
          </span>
        ) : null}
      </div>
    </form>
  );
}
