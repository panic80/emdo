export type AppRouteId =
  | 'today'
  | 'ask'
  | 'schedule'
  | 'finance'
  | 'shopping'
  | 'approvals'
  | 'activity'
  | 'settings';

export type ShellIconName =
  | 'home'
  | 'chat'
  | 'calendar'
  | 'finance'
  | 'shopping'
  | 'approval'
  | 'activity'
  | 'settings'
  | 'more';

export interface NavigationItem {
  readonly id: AppRouteId | 'more';
  readonly label: string;
  readonly href: string;
  readonly icon: ShellIconName;
}

export const DESKTOP_NAV_ITEMS = [
  { id: 'today', label: 'Today', href: '/today', icon: 'home' },
  { id: 'ask', label: 'Ask EMDO', href: '/ask', icon: 'chat' },
  { id: 'schedule', label: 'Schedule', href: '/schedule', icon: 'calendar' },
  { id: 'finance', label: 'Finance', href: '/finance', icon: 'finance' },
  { id: 'shopping', label: 'Shopping', href: '/shopping', icon: 'shopping' },
  { id: 'approvals', label: 'Approvals', href: '/approvals', icon: 'approval' },
  { id: 'activity', label: 'Activity', href: '/activity', icon: 'activity' },
  { id: 'settings', label: 'Settings', href: '/settings', icon: 'settings' },
] as const satisfies readonly NavigationItem[];

export const MOBILE_PRIMARY_ITEMS = [
  { id: 'today', label: 'Today', href: '/today', icon: 'home' },
  { id: 'ask', label: 'Ask', href: '/ask', icon: 'chat' },
  { id: 'schedule', label: 'Schedule', href: '/schedule', icon: 'calendar' },
  { id: 'finance', label: 'Finance', href: '/finance', icon: 'finance' },
  { id: 'more', label: 'More', href: '#more', icon: 'more' },
] as const satisfies readonly NavigationItem[];

export const MOBILE_SECONDARY_ITEMS = DESKTOP_NAV_ITEMS.filter(
  ({ id }) =>
    id === 'shopping' ||
    id === 'approvals' ||
    id === 'activity' ||
    id === 'settings',
);

export interface NavigationState {
  readonly activeDesktopId: AppRouteId;
  readonly activeMobileId: AppRouteId | 'more';
  readonly activeSecondaryLabel?: string;
}

const ROUTE_IDS = new Set<AppRouteId>(DESKTOP_NAV_ITEMS.map(({ id }) => id));
const SECONDARY_IDS = new Set<AppRouteId>(
  MOBILE_SECONDARY_ITEMS.map(({ id }) => id),
);

function routeIdFromPath(pathname: string): AppRouteId {
  const firstSegment = pathname
    .split(/[?#]/u, 1)[0]
    ?.split('/')
    .filter(Boolean)[0];
  if (firstSegment && ROUTE_IDS.has(firstSegment as AppRouteId)) {
    return firstSegment as AppRouteId;
  }
  return 'today';
}

export function resolveNavigationState(pathname: string): NavigationState {
  const activeDesktopId = routeIdFromPath(pathname);
  if (!SECONDARY_IDS.has(activeDesktopId)) {
    return { activeDesktopId, activeMobileId: activeDesktopId };
  }

  return {
    activeDesktopId,
    activeMobileId: 'more',
    activeSecondaryLabel: DESKTOP_NAV_ITEMS.find(
      ({ id }) => id === activeDesktopId,
    )?.label,
  };
}
