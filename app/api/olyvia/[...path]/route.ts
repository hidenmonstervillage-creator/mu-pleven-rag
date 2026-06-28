import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const UPSTREAM = 'http://194.141.67.249:8085';
const USER = process.env.OLYVIA_USER ?? 'guest';
const PASS = process.env.OLYVIA_PASS ?? 'Host-1234';
// Database GUID for test_DB — value from the <select> option in the login form
const DB_GUID = process.env.OLYVIA_DB_GUID ?? '5eba802f-e4ba-4e6a-955d-ec04d32bfacf';

// ── Module-level session cache ─────────────────────────────────────────────────
// In dev (long-lived process) this persists. On Vercel each warm lambda reuse
// also keeps it alive; cold starts will re-login (adds ~200 ms, acceptable).
let cachedCookies: string | null = null;

async function login(): Promise<string> {
  // 1. GET the login page to acquire the ASP.NET session + anti-forgery cookie pair
  const pageRes = await fetch(`${UPSTREAM}/Account/Login`, { redirect: 'follow' });

  // Collect all Set-Cookie values (Node 18+ Headers.getSetCookie())
  const setCookies: string[] = (pageRes.headers as unknown as { getSetCookie?: () => string[] })
    .getSetCookie?.() ?? [pageRes.headers.get('set-cookie') ?? ''];

  const extractCookieValue = (name: string): string => {
    for (const c of setCookies) {
      const m = c.match(new RegExp(`${name}=([^;]+)`));
      if (m) return m[1];
    }
    return '';
  };

  const sessionId = extractCookieValue('ASP\\.NET_SessionId');
  const verTokenCookie = extractCookieValue('__RequestVerificationToken');

  // 2. Extract the form-body anti-forgery token from the HTML
  const pageHtml = await pageRes.text();
  const formTokenMatch = pageHtml.match(
    /__RequestVerificationToken[^>]*type="hidden"[^>]*value="([^"]+)"/
  ) ?? pageHtml.match(
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/
  );
  const formToken = formTokenMatch?.[1] ?? '';

  // 3. POST credentials
  const body = new URLSearchParams({
    UserName: USER,
    Password: PASS,
    Database: DB_GUID,
    __RequestVerificationToken: formToken,
  });

  const loginRes = await fetch(`${UPSTREAM}/Account/Login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `ASP.NET_SessionId=${sessionId}; __RequestVerificationToken=${verTokenCookie}`,
    },
    body: body.toString(),
  });

  const loginCookies: string[] = (loginRes.headers as unknown as { getSetCookie?: () => string[] })
    .getSetCookie?.() ?? [loginRes.headers.get('set-cookie') ?? ''];

  const aspxAuth = (() => {
    for (const c of loginCookies) {
      const m = c.match(/\.ASPXAUTH=([^;]+)/);
      if (m) return m[1];
    }
    return '';
  })();

  if (!aspxAuth) throw new Error('OlyVia login failed — no .ASPXAUTH cookie received');

  return `ASP.NET_SessionId=${sessionId}; .ASPXAUTH=${aspxAuth}`;
}

// Login lock — prevents concurrent requests on the same (warm) lambda instance
// from triggering multiple simultaneous logins when cachedCookies is null.
// On Vercel, different lambda instances each cold-start independently and each
// will login once; that's fine — OlyVia supports multiple concurrent sessions.
let loginInFlight: Promise<string> | null = null;

async function ensureSession(): Promise<string> {
  if (cachedCookies) return cachedCookies;
  if (!loginInFlight) loginInFlight = login().then(c => { cachedCookies = c; loginInFlight = null; return c; });
  return loginInFlight;
}

// ── HTML rewriting ─────────────────────────────────────────────────────────────
// The viewer HTML uses window.location to compute the NIS API base URL. When
// served through /api/olyvia/…, that would point to our own origin's /api/nis
// (which doesn't exist). We patch it to /api/olyvia/api/nis so all downstream
// XHR calls fan back through this same proxy route.
// We also prefix absolute root-relative paths so static assets load through us.
// Finally we inject apollon.username/password/database so that apollon.js can
// authenticate to the NIS /login endpoint (separate from ASP.NET session auth).
function rewriteHtml(html: string): string {
  const nisUser = USER;    // guest
  const nisPass = PASS;    // Host-1234
  const nisDatabaseId = DB_GUID;

  return html
    .replace(/src="\/Viewer\//g, 'src="/api/olyvia/Viewer/')
    .replace(/href="\/Viewer\//g, 'href="/api/olyvia/Viewer/')
    .replace(/src="\/Images\//g, 'src="/api/olyvia/Images/')
    .replace(/href="\/Images\//g, 'href="/api/olyvia/Images/')
    .replace(
      'apollon.serviceURL = serviceUrl;',
      [
        "apollon.serviceURL = window.location.origin + '/api/olyvia/api/nis';",
        // NIS-level credentials — separate from ASP.NET session auth.
        // apollon.js POSTs these to /api/nis/login before requesting tiles.
        `apollon.username = ${JSON.stringify(nisUser)};`,
        `apollon.password = ${JSON.stringify(nisPass)};`,
        `apollon.database = ${JSON.stringify(nisDatabaseId)};`,
      ].join('\n    ')
    );
}

// ── Shared proxy logic ─────────────────────────────────────────────────────────
async function proxyRequest(req: NextRequest, params: { path: string[] }): Promise<NextResponse> {
  const path = '/' + params.path.join('/');
  const search = new URL(req.url).search;
  const upstreamUrl = `${UPSTREAM}${path}${search}`;

  let cookies: string;
  try {
    cookies = await ensureSession();
  } catch (err) {
    return new NextResponse(`OlyVia auth failed: ${String(err)}`, { status: 502 });
  }

  const forwardHeaders: HeadersInit = {
    Cookie: cookies,
    Accept: req.headers.get('accept') ?? '*/*',
    'User-Agent': req.headers.get('user-agent') ?? 'NextJS-OlyVia-Proxy/1.0',
  };

  const contentType = req.headers.get('content-type');
  if (contentType) forwardHeaders['Content-Type'] = contentType;

  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer();

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: body ? Buffer.from(body) : undefined,
      redirect: 'manual',
    });
  } catch (err) {
    return new NextResponse(`Upstream fetch failed: ${String(err)}`, { status: 502 });
  }

  // Session expired → re-login once and retry
  if (upstreamRes.status === 302) {
    const loc = upstreamRes.headers.get('location') ?? '';
    if (loc.includes('/Account/Login') || loc.includes('/account/login')) {
      cachedCookies = null;
      try {
        cookies = await ensureSession();
        upstreamRes = await fetch(upstreamUrl, {
          method: req.method,
          headers: { ...forwardHeaders, Cookie: cookies },
          body: body ? Buffer.from(body) : undefined,
          redirect: 'manual',
        });
      } catch (err) {
        return new NextResponse(`OlyVia re-auth failed: ${String(err)}`, { status: 502 });
      }
    }
  }

  const responseHeaders = new Headers();
  const upstreamContentType = upstreamRes.headers.get('content-type') ?? 'application/octet-stream';
  responseHeaders.set('Content-Type', upstreamContentType);

  // For HTML, buffer + rewrite; otherwise stream straight through
  if (upstreamContentType.includes('text/html')) {
    const html = await upstreamRes.text();
    const patched = rewriteHtml(html);
    responseHeaders.set('Content-Length', String(Buffer.byteLength(patched, 'utf8')));
    return new NextResponse(patched, { status: upstreamRes.status, headers: responseHeaders });
  }

  return new NextResponse(upstreamRes.body, { status: upstreamRes.status, headers: responseHeaders });
}

// ── Route exports ──────────────────────────────────────────────────────────────
export async function GET(req: NextRequest, context: { params: { path: string[] } }) {
  return proxyRequest(req, context.params);
}

export async function POST(req: NextRequest, context: { params: { path: string[] } }) {
  return proxyRequest(req, context.params);
}

export async function PUT(req: NextRequest, context: { params: { path: string[] } }) {
  return proxyRequest(req, context.params);
}

export async function DELETE(req: NextRequest, context: { params: { path: string[] } }) {
  return proxyRequest(req, context.params);
}
