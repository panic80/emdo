import type { PropsWithChildren, ReactNode } from 'react';

export function Page({
  children,
  className = '',
}: PropsWithChildren<{ readonly className?: string }>) {
  return <main className={`page ${className}`.trim()}>{children}</main>;
}

export function PageHeader({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="page-header__action">{action}</div> : null}
    </header>
  );
}

export function EmptyState({
  title,
  children,
}: PropsWithChildren<{ readonly title: string }>) {
  return (
    <section className="empty-state" aria-labelledby="empty-state-heading">
      <h2 id="empty-state-heading">{title}</h2>
      <div>{children}</div>
    </section>
  );
}
