import { Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';

import {
  DESKTOP_NAV_ITEMS,
  MOBILE_PRIMARY_ITEMS,
  MOBILE_SECONDARY_ITEMS,
  resolveNavigationState,
} from './app-shell-model.js';
import { Icon } from './components/icon.js';
import { ThemeToggle } from './components/theme-toggle.js';
import { ConversationProvider } from './features/chat/conversation.js';
import { useAuth } from './features/auth/auth-context.js';
import { useDomainData } from './features/domains/domain-data.js';
import { listenToSystemThemeChanges } from './features/theme/theme.store.js';
import { UpdateBanner } from './features/sync/update-banner.js';
import { serviceWorkerUpdateCoordinator } from './features/sync/register-service-worker.js';

function DesktopSidebar({
  offline,
  domainState,
  pendingChanges,
  replication,
}: {
  readonly offline: boolean;
  readonly domainState: ReturnType<typeof useDomainData>['state'];
  readonly pendingChanges: number;
  readonly replication: ReturnType<typeof useDomainData>['replication'];
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const navigation = resolveNavigationState(pathname);
  const verifiedAt =
    replication.liveReplicationVerified && replication.state === 'verified'
      ? new Date(replication.verifiedAt)
      : undefined;
  const verifiedStatus =
    verifiedAt && Number.isFinite(verifiedAt.getTime())
      ? `Offline-ready · Synced at ${new Intl.DateTimeFormat('en-CA', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: 'America/Toronto',
        }).format(verifiedAt)}`
      : undefined;
  const syncStatus =
    domainState === 'initializing'
      ? 'Opening encrypted offline data…'
      : domainState === 'unavailable' || domainState === 'locked'
        ? 'Offline data locked'
        : domainState === 'offline-ready'
          ? pendingChanges > 0
            ? `${pendingChanges} local ${pendingChanges === 1 ? 'change' : 'changes'} queued`
            : 'Offline · Local edits stay on this device'
          : pendingChanges > 0
            ? `${pendingChanges} local ${pendingChanges === 1 ? 'change' : 'changes'} waiting to sync`
            : offline
              ? 'Offline · Local edits stay on this device'
              : (verifiedStatus ??
                (replication.mode === 'online' &&
                replication.state === 'background-started'
                  ? 'Offline-ready · Sync starting'
                  : 'Offline-ready · Sync paused'));

  return (
    <aside className="desktop-sidebar">
      <Link className="wordmark" to="/today" aria-label="EMDO home">
        EMDO
      </Link>
      <nav
        aria-label="Primary"
        data-testid="desktop-navigation"
        className="desktop-navigation"
      >
        {DESKTOP_NAV_ITEMS.map((item) => (
          <Link
            className="desktop-navigation__item"
            key={item.id}
            to={item.href}
            aria-current={
              navigation.activeDesktopId === item.id ? 'page' : undefined
            }
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
      <div className="desktop-sidebar__status" role="status">
        <span className="sync-dot" aria-hidden="true">
          <Icon name="check" size={14} />
        </span>
        <span>{syncStatus}</span>
      </div>
    </aside>
  );
}

function MoreMenu({
  open,
  close,
}: {
  readonly open: boolean;
  readonly close: () => void;
}) {
  const titleId = useId();
  if (!open) return null;

  return (
    <div
      className="more-menu__backdrop"
      role="presentation"
      onMouseDown={close}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="more-menu"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id={titleId}>More</h2>
          <button
            className="icon-button"
            type="button"
            onClick={close}
            aria-label="Close menu"
          >
            <Icon name="plus" className="icon--close" />
          </button>
        </header>
        <nav aria-label="More destinations">
          {MOBILE_SECONDARY_ITEMS.map((item) => (
            <Link key={item.id} to={item.href} onClick={close}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
              <Icon name="chevron-right" size={20} />
            </Link>
          ))}
        </nav>
      </section>
    </div>
  );
}

function MobileNavigation({ openMore }: { readonly openMore: () => void }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const navigation = resolveNavigationState(pathname);

  return (
    <nav
      aria-label="Mobile primary"
      className="mobile-navigation"
      data-testid="mobile-navigation"
    >
      {MOBILE_PRIMARY_ITEMS.map((item) => {
        if (item.id === 'more') {
          const label = navigation.activeSecondaryLabel
            ? `More, current section: ${navigation.activeSecondaryLabel}`
            : 'More';
          return (
            <button
              aria-current={
                navigation.activeMobileId === 'more' ? 'page' : undefined
              }
              aria-label={label}
              key={item.id}
              onClick={openMore}
              type="button"
            >
              <Icon name="more" />
              <span className="mobile-navigation__more-label">
                <span>More</span>
                {navigation.activeSecondaryLabel ? (
                  <span className="mobile-navigation__current-secondary">
                    {navigation.activeSecondaryLabel}
                  </span>
                ) : null}
              </span>
            </button>
          );
        }
        return (
          <Link
            aria-current={
              navigation.activeMobileId === item.id ? 'page' : undefined
            }
            key={item.id}
            to={item.href}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function TopBar({ openMore }: { readonly openMore: () => void }) {
  return (
    <header className="top-bar">
      <Link className="top-bar__wordmark" to="/today" aria-label="EMDO home">
        EMDO
      </Link>
      <div className="top-bar__desktop-actions">
        <button
          className="icon-button"
          type="button"
          aria-label="Notifications"
        >
          <Icon name="bell" />
        </button>
        <ThemeToggle />
        <button
          className="profile-button"
          type="button"
          aria-label="Open account menu"
        >
          <span aria-hidden="true">JS</span>
          <Icon name="chevron-down" size={19} />
        </button>
      </div>
      <button
        className="mobile-menu-button"
        type="button"
        onClick={openMore}
        aria-label="Open menu"
      >
        <span />
        <span />
        <span />
      </button>
    </header>
  );
}

export function AppShell() {
  const auth = useAuth();
  const domain = useDomainData();
  const [moreOpen, setMoreOpen] = useState(false);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const publicRoute = pathname === '/sign-in' || pathname === '/invite';

  useEffect(() => setMoreOpen(false), [pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [moreOpen]);
  useEffect(() => listenToSystemThemeChanges(), []);

  if (publicRoute) {
    return <Outlet />;
  }
  if (auth.state === 'loading') {
    return (
      <main className="auth-loading" role="status">
        Verifying your secure session…
      </main>
    );
  }
  if (
    auth.state !== 'authenticated' &&
    auth.state !== 'offline-authenticated'
  ) {
    return <Navigate to="/sign-in" replace />;
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <DesktopSidebar
        domainState={domain.state}
        offline={auth.state === 'offline-authenticated'}
        pendingChanges={domain.pendingCount}
        replication={domain.replication}
      />
      <section className="app-shell__workspace">
        <TopBar openMore={() => setMoreOpen(true)} />
        <div id="main-content" className="app-shell__content" tabIndex={-1}>
          <ConversationProvider>
            <Outlet />
          </ConversationProvider>
        </div>
      </section>
      <UpdateBanner
        coordinator={serviceWorkerUpdateCoordinator}
        pendingChanges={domain.pendingCount}
      />
      <MobileNavigation openMore={() => setMoreOpen(true)} />
      <MoreMenu open={moreOpen} close={() => setMoreOpen(false)} />
    </div>
  );
}
