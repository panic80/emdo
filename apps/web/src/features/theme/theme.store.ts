import { atom } from 'nanostores';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'emdo-theme-preference';

/** Must match --color-canvas in tokens.css so the browser chrome matches the page. */
const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#ffffff',
  dark: '#0f1419',
};

function darkMediaQuery(): MediaQueryList | undefined {
  // jsdom (unit tests) has no matchMedia.
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : undefined;
}

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== 'system') return theme;
  return darkMediaQuery()?.matches ? 'dark' : 'light';
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : 'system';
  } catch {
    // Storage can be blocked (private mode, hardened settings); fall back to the OS.
    return 'system';
  }
}

function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);
  resolvedThemeStore.set(resolved);
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLORS[resolved]);
}

const initialTheme = readStoredTheme();

/** The user's preference, which may be 'system'. */
export const themeStore = atom<Theme>(initialTheme);
/** The theme actually painted — 'system' already collapsed to light or dark. */
export const resolvedThemeStore = atom<ResolvedTheme>(
  resolveTheme(initialTheme),
);

applyTheme(initialTheme);

export function setTheme(theme: Theme) {
  themeStore.set(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Preference is still applied for this session.
  }
  applyTheme(theme);
}

export function toggleTheme() {
  setTheme(resolvedThemeStore.get() === 'dark' ? 'light' : 'dark');
}

export function listenToSystemThemeChanges() {
  const query = darkMediaQuery();
  if (!query) return () => {};
  const handleChange = () => {
    if (themeStore.get() === 'system') applyTheme('system');
  };
  query.addEventListener('change', handleChange);
  return () => query.removeEventListener('change', handleChange);
}
