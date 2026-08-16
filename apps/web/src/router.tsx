import {
  Navigate,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { z } from 'zod';

import { AppShell } from './app-shell.js';

const Today = lazy(() =>
  import('./routes/today.js').then(({ TodayRoute }) => ({
    default: TodayRoute,
  })),
);
const Ask = lazy(() =>
  import('./routes/ask.js').then(({ AskRoute }) => ({ default: AskRoute })),
);
const Schedule = lazy(() =>
  import('./routes/schedule.js').then(({ ScheduleRoute }) => ({
    default: ScheduleRoute,
  })),
);
const Finance = lazy(() =>
  import('./routes/finance.js').then(({ FinanceRoute }) => ({
    default: FinanceRoute,
  })),
);
const Shopping = lazy(() =>
  import('./routes/shopping.js').then(({ ShoppingRoute }) => ({
    default: ShoppingRoute,
  })),
);
const Approvals = lazy(() =>
  import('./routes/approvals.js').then(({ ApprovalsRoute }) => ({
    default: ApprovalsRoute,
  })),
);
const Activity = lazy(() =>
  import('./routes/activity.js').then(({ ActivityRoute }) => ({
    default: ActivityRoute,
  })),
);
const Settings = lazy(() =>
  import('./routes/settings.js').then(({ SettingsRoute }) => ({
    default: SettingsRoute,
  })),
);
const SignIn = lazy(() =>
  import('./routes/sign-in.js').then(({ SignInRoute }) => ({
    default: SignInRoute,
  })),
);
const Invite = lazy(() =>
  import('./routes/invite.js').then(({ InviteRoute }) => ({
    default: InviteRoute,
  })),
);

function PendingRoute() {
  return (
    <div className="route-pending" role="status">
      Loading…
    </div>
  );
}

function withSuspense(Component: typeof Today) {
  return function LazyRoute() {
    return (
      <Suspense fallback={<PendingRoute />}>
        <Component />
      </Suspense>
    );
  };
}

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: () => <Navigate to="/today" replace />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/today', replace: true });
  },
});

const routes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/sign-in',
    component: withSuspense(SignIn),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/invite',
    validateSearch: z.object({
      invitationId: z.string().optional().catch(undefined),
      token: z.string().optional().catch(undefined),
      email: z.string().optional().catch(undefined),
    }),
    component: withSuspense(Invite),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/today',
    component: withSuspense(Today),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/ask',
    component: withSuspense(Ask),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/schedule',
    component: withSuspense(Schedule),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/finance',
    component: withSuspense(Finance),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/shopping',
    component: withSuspense(Shopping),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/approvals',
    component: withSuspense(Approvals),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/activity',
    component: withSuspense(Activity),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: withSuspense(Settings),
  }),
];

const routeTree = rootRoute.addChildren([indexRoute, ...routes]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 30_000,
    scrollRestoration: true,
  });
}

export const router = createAppRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
