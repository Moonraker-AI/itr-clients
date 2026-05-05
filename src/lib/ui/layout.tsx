import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';

type LayoutProps = PropsWithChildren<{
  title: string;
  /** Extra <head> tags (preconnect, scripts, etc). */
  head?: unknown;
  /** Force dark mode regardless of system. */
  dark?: boolean;
  /** Additional <script> blocks rendered just before </body>. */
  scripts?: unknown;
}>;

export const Layout: FC<LayoutProps> = ({ title, head, dark, scripts, children }) => {
  return (
    <html lang="en" class={dark ? 'dark' : undefined}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content={dark ? 'dark' : 'light dark'} />
        <title>{title}</title>
        <link rel="stylesheet" href="/static/app.css" />
        {head}
      </head>
      <body class="min-h-screen bg-background text-foreground antialiased">
        {children}
        {scripts}
      </body>
    </html>
  );
};

type AdminShellProps = PropsWithChildren<{
  user?: { email?: string | null; name?: string | null };
  current?: string;
}>;

const NAV: Array<{ href: string; label: string; match: string }> = [
  { href: '/admin', label: 'Dashboard', match: 'dashboard' },
  { href: '/admin/clients/new', label: 'New Client', match: 'new' },
  { href: '/admin/pricing', label: 'Pricing', match: 'pricing' },
];

export const AdminShell: FC<AdminShellProps> = ({ user, current, children }) => {
  return (
    <div class="flex min-h-screen">
      <aside class="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex md:flex-col">
        <div class="px-6 py-5 border-b border-sidebar-border">
          <a href="/admin" class="text-base font-semibold tracking-tight">
            ITR Client HQ
          </a>
          <p class="text-xs text-muted-foreground mt-0.5">Admin</p>
        </div>
        <nav class="flex-1 px-3 py-4 space-y-1">
          {NAV.map((item) => {
            const active = current === item.match;
            return (
              <a
                href={item.href}
                class={
                  'block rounded-md px-3 py-2 text-sm font-medium transition-colors ' +
                  (active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground')
                }
              >
                {item.label}
              </a>
            );
          })}
        </nav>
        {user ? (
          <div class="px-6 py-4 border-t border-sidebar-border text-xs text-muted-foreground">
            <div class="truncate">{user.name ?? user.email ?? 'Signed in'}</div>
          </div>
        ) : null}
      </aside>
      <main class="flex-1 min-w-0">
        <header class="md:hidden border-b border-border bg-card px-4 py-3 flex items-center justify-between">
          <a href="/admin" class="text-sm font-semibold">
            ITR Client HQ
          </a>
        </header>
        <div class="px-6 py-8 max-w-6xl mx-auto">{children}</div>
      </main>
    </div>
  );
};

type PageHeaderProps = PropsWithChildren<{ title: string; description?: string }>;

export const PageHeader: FC<PageHeaderProps> = ({ title, description, children }) => (
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
      {description ? (
        <p class="text-sm text-muted-foreground mt-1">{description}</p>
      ) : null}
    </div>
    {children ? <div class="flex items-center gap-2">{children}</div> : null}
  </div>
);

/** Inline a `<script>` body. Caller is responsible for content safety. */
export function ScriptBlock({ src, body }: { src?: string; body?: string }) {
  if (src) return <script src={src} />;
  return <script>{raw(body ?? '')}</script>;
}

type ClientShellProps = PropsWithChildren<{
  /** Page width cap. Defaults to "md" (max-w-2xl). */
  width?: 'sm' | 'md' | 'lg';
}>;

const WIDTH_CLASS: Record<NonNullable<ClientShellProps['width']>, string> = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
};

/** Centered client-facing shell with subtle brand header. */
export const ClientShell: FC<ClientShellProps> = ({ width = 'md', children }) => (
  <div class="min-h-screen bg-background">
    <header class="border-b border-border bg-card">
      <div class={`mx-auto px-6 py-4 ${WIDTH_CLASS[width]}`}>
        <div class="text-sm font-semibold tracking-tight">Intensive Therapy Retreats</div>
      </div>
    </header>
    <main class={`mx-auto px-6 py-8 ${WIDTH_CLASS[width]}`}>{children}</main>
  </div>
);
