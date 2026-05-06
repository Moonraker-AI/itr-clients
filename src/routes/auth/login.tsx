/**
 * /admin/login — Firebase JS SDK Google sign-in (M8).
 *
 * Browser flow:
 *   1. Page loads Firebase compat SDK from gstatic CDN.
 *   2. Click "Sign in with Google" → signInWithPopup with `hd` hint.
 *   3. user.getIdToken() → POST to /api/auth/session.
 *   4. Server verifies + sets HttpOnly session cookie.
 *   5. JS redirects to ?returnTo= or /admin.
 *
 * Server-side: pure JSX render via hono/jsx. No auth required.
 */

import { Hono } from 'hono';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Layout,
} from '../../lib/ui/index.js';

export const adminLoginRoute = new Hono();

function CenteredShell({ title, children }: { title: string; children: unknown }) {
  return (
    <Layout title={title}>
      <div class="min-h-screen flex items-center justify-center px-4 py-12">
        <div class="w-full max-w-md">{children}</div>
      </div>
    </Layout>
  );
}

adminLoginRoute.get('/login', (c) => {
  // Validate returnTo: must be a same-origin path (M9 fix #6). Reject
  // anything not starting with a single '/', and reject protocol-relative
  // ('//x.com') and full URLs ('http://...'). Default to /admin.
  const rawReturnTo = c.req.query('returnTo') ?? '';
  const returnTo =
    rawReturnTo.startsWith('/') && !rawReturnTo.startsWith('//')
      ? rawReturnTo
      : '/admin';
  const error = c.req.query('error');
  const apiKey = process.env.FIREBASE_API_KEY ?? '';
  const authDomain = process.env.FIREBASE_AUTH_DOMAIN ?? '';
  const projectId = process.env.FIREBASE_PROJECT_ID ?? '';
  const authEnabled = process.env.AUTH_ENABLED === '1';

  if (!authEnabled) {
    return c.html(
      <CenteredShell title="Login (disabled) — ITR Clients">
        <Card>
          <CardHeader>
            <CardTitle>Login disabled</CardTitle>
            <CardDescription>
              <code class="font-mono text-xs">AUTH_ENABLED</code> is not set on this Cloud Run service.
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            <p>
              Admin pages currently rely on Cloud Run IAM auth and a synthetic admin context. Set{' '}
              <code class="font-mono text-xs">AUTH_ENABLED=1</code> + bind{' '}
              <code class="font-mono text-xs">FIREBASE_API_KEY/AUTH_DOMAIN/PROJECT_ID</code> to enable
              Identity Platform sign-in.
            </p>
            <p>
              <a href={returnTo} class="text-primary underline-offset-4 hover:underline">
                Continue to {returnTo}
              </a>
            </p>
          </CardContent>
        </Card>
      </CenteredShell>,
    );
  }

  if (!apiKey || !authDomain || !projectId) {
    return c.html(
      <CenteredShell title="Login — config pending">
        <Alert variant="destructive">
          <AlertTitle>Setup pending</AlertTitle>
          <AlertDescription>
            Firebase web config is incomplete on this revision. Bind{' '}
            <code class="font-mono text-xs">FIREBASE_API_KEY</code>,{' '}
            <code class="font-mono text-xs">FIREBASE_AUTH_DOMAIN</code>, and{' '}
            <code class="font-mono text-xs">FIREBASE_PROJECT_ID</code> via the deploy workflow.
          </AlertDescription>
        </Alert>
      </CenteredShell>,
    );
  }

  const head = (
    <>
      <script src="https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js" />
      <script src="https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js" />
    </>
  );

  return c.html(
    <Layout title="Sign in — ITR Clients" head={head}>
      <div class="min-h-screen flex items-center justify-center px-4 py-12">
        <div class="w-full max-w-md space-y-6">
          <div class="text-center space-y-2">
            <h1 class="text-3xl font-semibold tracking-tight">ITR Clients</h1>
            <p class="text-sm text-muted-foreground">
              Sign in with your <strong>@intensivetherapyretreat.com</strong> Google account.
            </p>
          </div>

          <Card>
            <CardContent class="pt-6 space-y-4">
              <Button
                id="signin"
                size="lg"
                class="w-full"
                data={{
                  'api-key': apiKey,
                  'auth-domain': authDomain,
                  'project-id': projectId,
                  'return-to': returnTo,
                }}
              >
                Sign in with Google
              </Button>
              <p
                id="status"
                role="status"
                aria-live="polite"
                class="text-sm text-destructive min-h-[1.25rem]"
              ></p>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{decodeURIComponent(error)}</AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>

          <p class="text-xs text-muted-foreground text-center">
            Sessions last 5 days. After that you'll be asked to sign in again.
          </p>
        </div>
      </div>
      <script src="/static/js/firebase-signin.js" defer></script>
    </Layout>,
  );
});
