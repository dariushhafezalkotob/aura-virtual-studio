import React, { useState } from 'react';
import { AuthUser, signIn } from '../../services/authService';

interface LoginViewProps {
  onSignedIn: (user: AuthUser) => void;
}

/**
 * There is no signup form on purpose: accounts are created from the server with
 * `node dist-server/user-add.mjs add <email> <password>`. Anyone who can generate here
 * spends the studio's GPU quota, so getting in is by invitation.
 */
export const LoginView: React.FC<LoginViewProps> = ({ onSignedIn }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    const result = await signIn(email.trim(), password);
    setBusy(false);

    if (result.user) {
      onSignedIn(result.user);
    } else {
      setError(result.error || 'Could not sign in.');
      setPassword('');
    }
  };

  return (
    <div className="h-screen w-screen bg-background text-on-background flex items-center justify-center font-body-md relative overflow-hidden">
      <div className="fixed inset-0 pointer-events-none bg-gradient-radial z-0" />

      <form
        onSubmit={handleSubmit}
        className="relative z-10 w-full max-w-sm mx-md flex flex-col gap-lg bg-surface-container-low/80 backdrop-blur-xl border border-outline-variant/40 rounded-2xl p-xl shadow-2xl"
      >
        <div className="flex flex-col gap-xs">
          <span className="font-label-caps text-[11px] tracking-[0.2em] text-on-surface-variant uppercase">
            Aura Virtual Stage
          </span>
          <h1 className="font-headline-lg text-2xl text-on-surface">Sign in</h1>
        </div>

        <div className="flex flex-col gap-sm">
          <label className="flex flex-col gap-xs">
            <span className="text-[11px] font-label-caps uppercase tracking-wider text-on-surface-variant">
              Email
            </span>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-surface-container border border-outline-variant rounded-lg px-sm py-xs text-sm text-on-surface outline-none focus:border-primary transition-colors"
            />
          </label>

          <label className="flex flex-col gap-xs">
            <span className="text-[11px] font-label-caps uppercase tracking-wider text-on-surface-variant">
              Password
            </span>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-surface-container border border-outline-variant rounded-lg px-sm py-xs text-sm text-on-surface outline-none focus:border-primary transition-colors"
            />
          </label>
        </div>

        {error && (
          <div
            role="alert"
            className="text-[12px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-sm py-xs"
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className={`w-full py-sm rounded-lg font-label-caps text-[12px] tracking-wider font-bold transition-all ${
            busy
              ? 'bg-surface-container-high text-on-surface-variant cursor-wait'
              : 'bg-primary text-background hover:brightness-110 cursor-pointer'
          }`}
        >
          {busy ? 'SIGNING IN…' : 'SIGN IN'}
        </button>

        <p className="text-[11px] text-on-surface-variant leading-relaxed">
          Accounts are created by the studio owner. If you need one, ask for it.
        </p>
      </form>
    </div>
  );
};
