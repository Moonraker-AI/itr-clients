import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';

import type { Theme } from './theme.js';

/** Pre-paint script: applies theme class before <body> renders to avoid FOUC.
 * Reads `theme` cookie first, falls back to system prefers-color-scheme. */
const PREPAINT_THEME = `
(function(){
  try {
    var m = document.cookie.match(/(?:^|; )theme=(light|dark)/);
    var t = m ? m[1] : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    if (t === 'dark') document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`.trim();

type LayoutProps = PropsWithChildren<{
  title: string;
  /** Extra <head> tags (preconnect, scripts, etc). */
  head?: unknown;
  /** Server-known theme from `theme` cookie. If null, the pre-paint script
   * decides at first paint based on system pref. */
  theme?: Theme | null | undefined;
  /** Additional <script> blocks rendered just before </body>. */
  scripts?: unknown;
}>;

export const Layout: FC<LayoutProps> = ({ title, head, theme, scripts, children }) => {
  const isDark = theme === 'dark';
  return (
    <html lang="en" class={isDark ? 'dark' : undefined}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{title}</title>
        <link rel="stylesheet" href="/static/app.css" />
        <script>{raw(PREPAINT_THEME)}</script>
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

const SUN_ICON = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="h-4 w-4 hidden dark:block"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

const MOON_ICON = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="h-4 w-4 dark:hidden"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const SHELL_SCRIPT = `
(function(){
  var t = document.getElementById('theme-toggle');
  if (t) {
    t.addEventListener('click', function(){
      var dark = document.documentElement.classList.toggle('dark');
      var v = dark ? 'dark' : 'light';
      var oneYear = 60 * 60 * 24 * 365;
      document.cookie = 'theme=' + v + '; path=/; max-age=' + oneYear + '; samesite=lax';
    });
  }
  var s = document.getElementById('sign-out');
  if (s) {
    s.addEventListener('click', async function(e){
      e.preventDefault();
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch (_) {}
      window.location.href = '/admin/login';
    });
  }
})();
`.trim();

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
        <header class="border-b border-border bg-card px-4 py-3 flex items-center justify-between md:justify-end gap-2">
          <a href="/admin" class="text-sm font-semibold md:hidden">
            ITR Client HQ
          </a>
          <div class="flex items-center gap-2">
            <button
              type="button"
              id="theme-toggle"
              aria-label="Toggle theme"
              class="inline-flex items-center justify-center h-9 w-9 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {SUN_ICON}
              {MOON_ICON}
            </button>
            <button
              type="button"
              id="sign-out"
              class="inline-flex items-center justify-center h-9 px-3 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Sign out
            </button>
          </div>
        </header>
        <div class="px-6 py-8 max-w-6xl mx-auto">{children}</div>
      </main>
      <script>{raw(SHELL_SCRIPT)}</script>
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
