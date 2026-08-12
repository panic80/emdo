import type { ReactElement, SVGProps } from 'react';

import type { ShellIconName } from '../app-shell-model.js';

export type IconName =
  | ShellIconName
  | 'bell'
  | 'chevron-right'
  | 'chevron-down'
  | 'check'
  | 'clock'
  | 'info'
  | 'lock'
  | 'microphone'
  | 'pause'
  | 'play'
  | 'plus'
  | 'route'
  | 'shield-alert'
  | 'stop'
  | 'sync'
  | 'user'
  | 'wallet';

type PathDefinition = readonly ReactElement[];

const paths: Record<IconName, PathDefinition> = {
  home: [
    <path key="a" d="m3 11 9-8 9 8" />,
    <path key="b" d="M5 10v10h14V10" />,
    <path key="c" d="M9 20v-6h6v6" />,
  ],
  chat: [
    <path
      key="a"
      d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-3.7-.8L3 21l1.8-4.8A8.5 8.5 0 1 1 21 11.5Z"
    />,
  ],
  calendar: [
    <rect key="a" x="3" y="5" width="18" height="16" rx="2" />,
    <path key="b" d="M16 3v4M8 3v4M3 10h18" />,
  ],
  finance: [
    <circle key="a" cx="12" cy="12" r="9" />,
    <path
      key="b"
      d="M12 6v12M15 8.5c-.8-.8-1.8-1.2-3-1.2-1.7 0-3 1-3 2.4 0 3.6 6 1.6 6 4.8 0 1.4-1.3 2.3-3 2.3-1.2 0-2.4-.4-3.2-1.2"
    />,
  ],
  shopping: [
    <path key="a" d="M3 4h2l2.2 11h10.9l2-7H6.2" />,
    <circle key="b" cx="9" cy="19" r="1" />,
    <circle key="c" cx="17" cy="19" r="1" />,
  ],
  approval: [
    <path key="a" d="m12 3 8 3v5c0 5-3.3 8.2-8 10-4.7-1.8-8-5-8-10V6l8-3Z" />,
    <path key="b" d="m8.5 12 2.2 2.2 4.8-5" />,
  ],
  activity: [<path key="a" d="m3 17 5-5 4 3 7-9M15 6h4v4" />],
  settings: [
    <circle key="a" cx="12" cy="12" r="3" />,
    <path
      key="b"
      d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"
    />,
  ],
  more: [
    <circle key="a" cx="5" cy="12" r="1" fill="currentColor" stroke="none" />,
    <circle key="b" cx="12" cy="12" r="1" fill="currentColor" stroke="none" />,
    <circle key="c" cx="19" cy="12" r="1" fill="currentColor" stroke="none" />,
  ],
  bell: [
    <path key="a" d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" />,
    <path key="b" d="M10 21h4" />,
  ],
  'chevron-right': [<path key="a" d="m9 18 6-6-6-6" />],
  'chevron-down': [<path key="a" d="m6 9 6 6 6-6" />],
  check: [<path key="a" d="m5 12 4 4L19 6" />],
  clock: [
    <circle key="a" cx="12" cy="12" r="9" />,
    <path key="b" d="M12 7v6l4 2" />,
  ],
  info: [
    <circle key="a" cx="12" cy="12" r="9" />,
    <path key="b" d="M12 11v6M12 7h.01" />,
  ],
  lock: [
    <rect key="a" x="5" y="10" width="14" height="11" rx="2" />,
    <path key="b" d="M8 10V7a4 4 0 0 1 8 0v3" />,
  ],
  microphone: [
    <rect key="a" x="9" y="3" width="6" height="12" rx="3" />,
    <path key="b" d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />,
  ],
  pause: [<path key="a" d="M9 6v12M15 6v12" />],
  play: [<path key="a" d="m8 5 11 7-11 7Z" />],
  plus: [<path key="a" d="M12 5v14M5 12h14" />],
  route: [
    <circle key="a" cx="6" cy="18" r="2" />,
    <circle key="b" cx="18" cy="6" r="2" />,
    <path key="c" d="M8 18h3a3 3 0 0 0 3-3v-6a3 3 0 0 1 3-3" />,
  ],
  'shield-alert': [
    <path key="a" d="m12 3 8 3v5c0 5-3.3 8.2-8 10-4.7-1.8-8-5-8-10V6l8-3Z" />,
    <path key="b" d="M12 8v5M12 17h.01" />,
  ],
  stop: [<rect key="a" x="6" y="6" width="12" height="12" rx="1" />],
  sync: [
    <path key="a" d="M20 7h-5V2" />,
    <path key="b" d="M4 17h5v5" />,
    <path
      key="c"
      d="M6.1 8A7 7 0 0 1 18.5 5.5L20 7M4 17l1.5 1.5A7 7 0 0 0 18 16"
    />,
  ],
  user: [
    <circle key="a" cx="12" cy="8" r="4" />,
    <path key="b" d="M4 21a8 8 0 0 1 16 0" />,
  ],
  wallet: [
    <path
      key="a"
      d="M4 6h14a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3h12"
    />,
    <path key="b" d="M15 11h5v4h-5a2 2 0 0 1 0-4Z" />,
  ],
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  readonly name: IconName;
  readonly size?: number;
}

export function Icon({ name, size = 24, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
    >
      {paths[name]}
    </svg>
  );
}
