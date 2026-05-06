import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';

import { PREPAINT_THEME } from '../csp.js';
import type { Theme } from './theme.js';

const FAVICON_LINKS = (
  <>
    <link rel="icon" type="image/png" href="/static/brand/favicon.png" />
    <link rel="apple-touch-icon" href="/static/brand/apple-touch-icon.png" />
  </>
);

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
        {FAVICON_LINKS}
        <link rel="stylesheet" href="/static/app.css" />
        <script>{raw(PREPAINT_THEME)}</script>
        {head}
      </head>
      <body class="min-h-screen bg-background text-foreground antialiased">
        <a
          href="#main"
          class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:text-foreground focus:px-3 focus:py-2 focus:shadow-md focus:ring-2 focus:ring-ring"
        >
          Skip to main content
        </a>
        {children}
        {scripts}
      </body>
    </html>
  );
};

type AdminShellProps = PropsWithChildren<{
  user?: {
    email?: string | null;
    name?: string | null;
    role?: 'admin' | 'therapist';
  };
  current?: string;
}>;

interface NavItem {
  href: string;
  label: string;
  match: string;
  /** True when only admins (not therapists) should see this nav entry. */
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { href: '/admin', label: 'Dashboard', match: 'dashboard' },
  { href: '/admin/clients/new', label: 'New Client', match: 'new' },
  { href: '/admin/pricing', label: 'Pricing', match: 'pricing', adminOnly: true },
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

const LOGO_MARK = (
  <img
    src="/static/brand/logo.png"
    alt=""
    width="32"
    height="32"
    class="h-8 w-8 shrink-0 object-contain"
    onerror="this.style.display='none'"
  />
);


const ICON_BTN_CLASS =
  'inline-flex items-center justify-center h-9 w-9 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

const TEXT_BTN_CLASS =
  'inline-flex items-center justify-center h-9 px-3 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export const AdminShell: FC<AdminShellProps> = ({ user, current, children }) => {
  return (
    <div class="flex min-h-screen">
      <aside
        aria-label="Primary navigation"
        class="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex md:flex-col"
      >
        <a
          href="/admin"
          class="h-16 px-6 flex items-center gap-3 border-b border-sidebar-border"
        >
          {LOGO_MARK}
          <div>
            <div class="text-base font-semibold tracking-tight leading-none">ITR Clients</div>
            <div class="text-xs text-muted-foreground mt-1">Admin</div>
          </div>
        </a>

        <nav class="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV.filter((item) => !item.adminOnly || user?.role === 'admin').map((item) => {
            const active = current === item.match;
            return (
              <a
                href={item.href}
                aria-current={active ? 'page' : undefined}
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

        <div class="border-t border-sidebar-border p-4 space-y-3">
          <div class="flex items-center gap-2">
            <button
              type="button"
              id="theme-toggle"
              aria-label="Toggle theme"
              class={ICON_BTN_CLASS}
            >
              {SUN_ICON}
              {MOON_ICON}
            </button>
            <button type="button" id="sign-out" class={TEXT_BTN_CLASS + ' flex-1'}>
              Sign out
            </button>
          </div>
          {user ? (
            <div class="text-xs text-muted-foreground truncate">
              {user.name ?? user.email ?? 'Signed in'}
            </div>
          ) : null}
        </div>
      </aside>

      <main class="flex-1 min-w-0">
        {/* Mobile-only top bar: logo + name + theme + sign out (sidebar hidden on mobile). */}
        <header class="md:hidden h-16 border-b border-border bg-card px-4 flex items-center justify-between gap-2">
          <a href="/admin" class="flex items-center gap-2">
            {LOGO_MARK}
            <span class="text-sm font-semibold">ITR Clients</span>
          </a>
          <div class="flex items-center gap-2">
            <button
              type="button"
              id="theme-toggle"
              aria-label="Toggle theme"
              class={ICON_BTN_CLASS}
            >
              {SUN_ICON}
              {MOON_ICON}
            </button>
            <button type="button" id="sign-out" class={TEXT_BTN_CLASS}>
              Sign out
            </button>
          </div>
        </header>
        <div id="main" class="px-6 py-8 max-w-6xl mx-auto">{children}</div>
      </main>
      <script src="/static/js/admin-shell.js" defer></script>
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
  width?: 'sm' | 'md' | 'lg' | 'xl';
}>;

const WIDTH_CLASS: Record<NonNullable<ClientShellProps['width']>, string> = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
  xl: 'max-w-5xl',
};

/** Centered client-facing shell with brand header. */
export const ClientShell: FC<ClientShellProps> = ({ width = 'md', children }) => (
  <div class="min-h-screen bg-background">
    <header class="h-16 border-b border-border bg-card">
      <div class={`h-full mx-auto px-6 flex items-center gap-3 ${WIDTH_CLASS[width]}`}>
        {LOGO_MARK}
        <div class="text-sm font-semibold tracking-tight">Intensive Therapy Retreats</div>
      </div>
    </header>
    <main id="main" class={`mx-auto px-6 py-8 ${WIDTH_CLASS[width]}`}>
      {children}
    </main>
  </div>
);
