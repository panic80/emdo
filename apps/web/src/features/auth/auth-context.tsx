import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';

import {
  AuthClientError,
  createEmdoAuthClient,
  type AuthSession,
  type EmdoAuthClient,
} from './auth-client.js';
import {
  inspectBrowserOfflineSession,
  type BrowserOfflineSessionHint,
} from '../../offline/logout-purge.js';

export type AuthState =
  | 'loading'
  | 'authenticated'
  | 'offline-authenticated'
  | 'logout-pending'
  | 'anonymous'
  | 'expired'
  | 'unavailable';

export interface AuthContextValue {
  readonly state: AuthState;
  readonly session?: AuthSession;
  /** Opaque SHA-256 binding; never an identity, tenant, role, or space claim. */
  readonly sessionBinding?: string;
  /** Short-lived mutation proof. It is never persisted. */
  readonly csrfToken?: string;
  /** True only after the server explicitly returned an anonymous session. */
  readonly serverSessionKnownRevoked: boolean;
  /** Keeps a peer-sealed tab locked while allowing explicit local cleanup recovery. */
  readonly memorySeal: 'none' | 'peer-teardown' | 'local-cleanup-pending';
  readonly client: EmdoAuthClient;
  readonly refresh: () => Promise<void>;
  readonly sealForPeerTeardown: () => void;
  readonly sealAfterLogout: (status: 'complete' | 'incomplete') => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const productionAuthClient = createEmdoAuthClient();

type OfflineSessionInspector = () => Promise<BrowserOfflineSessionHint | null>;
const browserIsOnline = () => navigator.onLine;

async function bindAuthenticatedSession(sessionId: string): Promise<string> {
  const bytes = new TextEncoder().encode(sessionId);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export function AuthProvider({
  children,
  client = productionAuthClient,
  inspectOfflineSession = inspectBrowserOfflineSession,
  isOnline = browserIsOnline,
}: PropsWithChildren<{
  readonly client?: EmdoAuthClient;
  readonly inspectOfflineSession?: OfflineSessionInspector;
  readonly isOnline?: () => boolean;
}>) {
  const [state, setState] = useState<AuthState>('loading');
  const [session, setSession] = useState<AuthSession>();
  const [csrfToken, setCsrfToken] = useState<string>();
  const [sessionBinding, setSessionBinding] = useState<string>();
  const [serverSessionKnownRevoked, setServerSessionKnownRevoked] =
    useState(false);
  const [memorySeal, setMemorySeal] =
    useState<AuthContextValue['memorySeal']>('none');
  const refreshGeneration = useRef(0);
  const refreshSealed = useRef(false);

  const sealForPeerTeardown = useCallback(() => {
    refreshGeneration.current += 1;
    refreshSealed.current = true;
    setSession(undefined);
    setCsrfToken(undefined);
    setSessionBinding(undefined);
    setServerSessionKnownRevoked(false);
    setMemorySeal('peer-teardown');
    setState('logout-pending');
  }, []);

  const sealAfterLogout = useCallback((status: 'complete' | 'incomplete') => {
    refreshGeneration.current += 1;
    refreshSealed.current = status === 'incomplete';
    setSession(undefined);
    setCsrfToken(undefined);
    setServerSessionKnownRevoked(true);
    if (status === 'complete') {
      setSessionBinding(undefined);
      setMemorySeal('none');
      setState('anonymous');
      return;
    }
    setMemorySeal('local-cleanup-pending');
    setState('logout-pending');
  }, []);

  const refresh = useCallback(async () => {
    if (refreshSealed.current) return;
    const generation = ++refreshGeneration.current;
    const isCurrent = () => generation === refreshGeneration.current;
    try {
      const result = await client.getSession();
      if (!isCurrent()) return;
      if (!result) {
        setSession(undefined);
        setCsrfToken(undefined);
        setServerSessionKnownRevoked(true);
        try {
          const hint = await inspectOfflineSession();
          if (!isCurrent()) return;
          if (hint?.status === 'logout-pending') {
            setSessionBinding(hint.sessionBinding);
            setMemorySeal('local-cleanup-pending');
            setState('logout-pending');
            return;
          }
        } catch {
          // Anonymous sign-in remains available when local storage is invalid.
        }
        if (!isCurrent()) return;
        setSessionBinding(undefined);
        setMemorySeal('none');
        setState('anonymous');
        return;
      }
      if (new Date(result.session.expiresAt).getTime() <= Date.now()) {
        setSession(undefined);
        setSessionBinding(undefined);
        setCsrfToken(undefined);
        setServerSessionKnownRevoked(false);
        setMemorySeal('none');
        setState('expired');
        return;
      }
      let mutationProof: string | undefined;
      try {
        mutationProof = await client.getMutationCsrf();
      } catch {
        // Reading remains available when the proof endpoint is temporarily
        // unavailable; every protected mutation still fails closed.
      }
      if (!isCurrent()) return;
      const authenticatedBinding = await bindAuthenticatedSession(
        result.session.id,
      );
      if (!isCurrent()) return;
      let localHint: BrowserOfflineSessionHint | null = null;
      try {
        localHint = await inspectOfflineSession();
      } catch {
        // Online session use can continue while offline storage is separately locked.
      }
      if (!isCurrent()) return;
      if (localHint && localHint.sessionBinding !== authenticatedBinding) {
        setSession(undefined);
        setSessionBinding(undefined);
        setCsrfToken(undefined);
        setMemorySeal('none');
        setState('unavailable');
        return;
      }
      setSession(result);
      setServerSessionKnownRevoked(false);
      setSessionBinding(authenticatedBinding);
      setCsrfToken(mutationProof);
      if (localHint?.status === 'logout-pending') {
        setMemorySeal('local-cleanup-pending');
        setState('logout-pending');
      } else {
        setMemorySeal('none');
        setState('authenticated');
      }
    } catch (error) {
      if (!isCurrent()) return;
      setSession(undefined);
      setCsrfToken(undefined);
      setServerSessionKnownRevoked(false);
      const sessionTransportFailed =
        error instanceof AuthClientError &&
        error.code === 'session-network-unavailable';
      if (sessionTransportFailed || !isOnline()) {
        try {
          const hint = await inspectOfflineSession();
          if (!isCurrent()) return;
          if (hint?.status === 'active' && hint.canEditOffline) {
            setSessionBinding(hint.sessionBinding);
            setMemorySeal('none');
            setState('offline-authenticated');
            return;
          }
          if (hint?.status === 'logout-pending') {
            setSessionBinding(hint.sessionBinding);
            setMemorySeal('local-cleanup-pending');
            setState('logout-pending');
            return;
          }
        } catch {
          // Invalid or incomplete key state stays locked.
        }
      }
      if (!isCurrent()) return;
      setSessionBinding(undefined);
      setMemorySeal('none');
      setState('unavailable');
    }
  }, [client, inspectOfflineSession, isOnline]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (!session || state !== 'authenticated') return;
    const remaining =
      new Date(session.session.expiresAt).getTime() - Date.now();
    const timeout = window.setTimeout(
      () => {
        refreshGeneration.current += 1;
        setSession(undefined);
        setSessionBinding(undefined);
        setCsrfToken(undefined);
        setState('expired');
      },
      Math.min(Math.max(0, remaining), 2_147_483_647),
    );
    return () => window.clearTimeout(timeout);
  }, [session, state]);

  useEffect(() => {
    const verifyVisibleSession = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', verifyVisibleSession);
    return () =>
      document.removeEventListener('visibilitychange', verifyVisibleSession);
  }, [refresh]);

  const value = useMemo(
    () => ({
      state,
      session,
      sessionBinding,
      csrfToken,
      serverSessionKnownRevoked,
      memorySeal,
      client,
      refresh,
      sealForPeerTeardown,
      sealAfterLogout,
    }),
    [
      client,
      csrfToken,
      memorySeal,
      refresh,
      sealAfterLogout,
      sealForPeerTeardown,
      serverSessionKnownRevoked,
      session,
      sessionBinding,
      state,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
