/**
 * Sign-in for the studio. The session lives in an httpOnly cookie, so nothing here ever
 * touches the token - the browser attaches it, and JavaScript cannot read it even if a
 * dependency turns hostile.
 */
export interface AuthUser {
  id: string;
  email: string;
  role: 'owner' | 'user';
}

export async function fetchCurrentUser(): Promise<AuthUser | null> {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    const data = await res.json();
    return data.user || null;
  } catch {
    return null;
  }
}

export async function signIn(email: string, password: string): Promise<{ user?: AuthUser; error?: string }> {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || 'Could not sign in.' };
    return { user: data.user };
  } catch {
    return { error: 'Could not reach the server. Is it running?' };
  }
}

export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* signing out locally is what matters; the session expires on its own anyway */
  }
}
