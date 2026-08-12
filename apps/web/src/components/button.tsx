import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  readonly busy?: boolean;
}

export function Button({
  variant = 'primary',
  busy = false,
  disabled,
  children,
  className = '',
  ...props
}: PropsWithChildren<ButtonProps>) {
  return (
    <button
      className={`button button--${variant} ${className}`.trim()}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {children}
    </button>
  );
}
