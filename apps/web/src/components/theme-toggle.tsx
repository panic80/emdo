import { useSyncExternalStore } from 'react';

import {
  resolvedThemeStore,
  toggleTheme,
} from '../features/theme/theme.store.js';
import { Icon } from './icon.js';

const subscribe = (onChange: () => void) => resolvedThemeStore.listen(onChange);
const getSnapshot = () => resolvedThemeStore.get();

export function ThemeToggle() {
  const resolved = useSyncExternalStore(subscribe, getSnapshot);
  const label =
    resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      className="icon-button"
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      <Icon name={resolved === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}
