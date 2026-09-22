import {
  SESSION_COOKIE,
  authenticate,
  clearedSessionCookie,
  createSession,
  destroySession,
  parseCookies,
  sessionCookie,
  toPublicUser,
  userForSession,
} from '../lib/users';

/**
 * Sign in, sign out, and "who am I". Everything else under /api needs a session, so these
 * three are the only routes that run before the gate.
 */

function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: any) => {
      body += chunk;
      // A login body is tiny; anything larger is either a mistake or an attack.
      if (body.length > 10_000) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: any, status: number, payload: any, cookie?: string) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.end(JSON.stringify(payload));
}

export function sessionTokenFrom(req: any): string | undefined {
  return parseCookies(req.headers?.cookie)[SESSION_COOKIE];
}

/** True when the connection is TLS, so the session cookie can be marked Secure. */
export function isSecureRequest(req: any, scheme: string): boolean {
  if (req.headers?.['x-forwarded-proto'] === 'https') return true;
  if (req.socket?.encrypted) return true;
  return scheme === 'https' && req.headers?.host?.startsWith('localhost') !== true;
}

/** Handles /api/auth/*. Returns true when it answered the request. */
export async function handleAuthApi(req: any, res: any, scheme: string): Promise<boolean> {
  const url = (req.url || '').split('?')[0];
  if (!url.startsWith('/api/auth/')) return false;

  const secure = isSecureRequest(req, scheme);

  try {
    if (url === '/api/auth/login' && req.method === 'POST') {
      const { email, password } = await readJsonBody(req);
      if (!email || !password) {
        sendJson(res, 400, { success: false, error: 'Email and password are required.' });
        return true;
      }

      const user = await authenticate(String(email), String(password));
      if (!user) {
        // Same message either way: never reveal whether the account exists.
        sendJson(res, 401, { success: false, error: 'Wrong email or password.' });
        return true;
      }

      const { token, expiresAt } = await createSession(user._id);
      sendJson(res, 200, { success: true, user: toPublicUser(user) }, sessionCookie(token, expiresAt, secure));
      return true;
    }

    if (url === '/api/auth/logout' && req.method === 'POST') {
      await destroySession(sessionTokenFrom(req));
      sendJson(res, 200, { success: true }, clearedSessionCookie(secure));
      return true;
    }

    if (url === '/api/auth/me' && req.method === 'GET') {
      const user = await userForSession(sessionTokenFrom(req));
      if (!user) {
        sendJson(res, 401, { success: false, error: 'Not signed in.' });
        return true;
      }
      sendJson(res, 200, { success: true, user: toPublicUser(user) });
      return true;
    }

    sendJson(res, 404, { success: false, error: 'Unknown auth route.' });
    return true;
  } catch (err: any) {
    console.error('[API /api/auth]', err?.message || err);
    sendJson(res, 500, { success: false, error: 'Sign-in is temporarily unavailable.' });
    return true;
  }
}
