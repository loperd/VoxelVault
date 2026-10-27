/**
 * Production frontend on Cloudflare: the built SPA is served as static assets, and /api/* is
 * proxied to the Go API on the VPS cluster (API_ORIGIN). The browser therefore talks to one origin
 * — the session cookie, passkeys (WebAuthn RP ID) and the Telegram redirect all belong to it.
 */
interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly API_ORIGIN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const target = new URL(url.pathname + url.search, env.API_ORIGIN);
    const headers = new Headers(request.headers);
    // The API checks Origin against WEBAUTHN_ORIGINS: it must stay the frontend origin.
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
    headers.delete('Host');
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      // Redirects (Telegram login) and Set-Cookie go to the browser untouched.
      redirect: 'manual',
    });
    return new Response(response.body, response);
  },
};
