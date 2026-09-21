import React, { useEffect, useState } from 'react';

export type CrewRole = 'producer' | 'stage' | 'animator' | 'camera' | 'viewer';

export interface CrewMember {
  userId: string;
  name: string;
  username?: string;
  roles: CrewRole[];
  isOwner: boolean;
}

const ROLE_LABELS: Record<CrewRole, string> = {
  producer: 'Producer',
  stage: 'Stage designer',
  animator: 'Animator',
  camera: 'Camera',
  viewer: 'Viewer',
};

const PICKABLE_ROLES: CrewRole[] = ['stage', 'animator', 'camera', 'viewer'];

interface CrewPanelProps {
  projectId: string;
  projectName: string;
  /** Only the owner sees the "add someone" form. */
  canManage: boolean;
  onClose: () => void;
}

/**
 * Who is on this project. The owner creates a seat by choosing a username, a password and one or
 * more roles; that person then signs in with those details and sees only the projects they are on.
 *
 * Roles are recorded but not yet enforced - everyone on a project can work on all of it.
 */
export const CrewPanel: React.FC<CrewPanelProps> = ({ projectId, projectName, canManage, onClose }) => {
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<CrewRole[]>(['camera']);

  const load = async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/crew`);
      const data = await res.json();
      if (data.success) setCrew(data.crew || []);
      else setError(data.error || 'Could not load the crew.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const toggleRole = (role: CrewRole) =>
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/crew`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, displayName, roles }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not add that person.');
      } else {
        setUsername('');
        setDisplayName('');
        setPassword('');
        setRoles(['camera']);
        await load();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (member: CrewMember) => {
    if (!confirm(`Remove ${member.name} from ${projectName}? Their account stays, but they lose access to this project.`)) {
      return;
    }
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/crew/${member.userId}`, { method: 'DELETE' });
    await load();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-md" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-surface-container-low border border-outline-variant/50 rounded-2xl shadow-2xl flex flex-col gap-lg p-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-md">
          <div className="flex flex-col gap-xs">
            <span className="font-label-caps text-[10px] tracking-[0.2em] uppercase text-on-surface-variant">
              {projectName}
            </span>
            <h2 className="font-headline-lg text-xl text-on-surface">Crew</h2>
          </div>
          <button
            onClick={onClose}
            className="text-on-surface-variant hover:text-primary p-xs rounded-full hover:bg-surface-container-high cursor-pointer"
            title="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="flex flex-col gap-xs">
          {loading && <span className="text-xs text-on-surface-variant">Loading…</span>}
          {!loading && crew.length === 0 && (
            <span className="text-xs text-on-surface-variant">Nobody on this project yet.</span>
          )}
          {crew.map((member) => (
            <div
              key={member.userId}
              className="flex items-center gap-sm bg-surface-container rounded-lg px-sm py-xs border border-outline-variant/30"
            >
              <span className="material-symbols-outlined text-[20px] text-primary">
                {member.isOwner ? 'stars' : 'person'}
              </span>
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-sm text-on-surface truncate">{member.name}</span>
                <span className="text-[11px] text-on-surface-variant truncate">
                  {member.username ? `@${member.username} · ` : ''}
                  {member.roles.map((r) => ROLE_LABELS[r] || r).join(', ')}
                  {member.isOwner ? ' · owner' : ''}
                </span>
              </div>
              {canManage && !member.isOwner && (
                <button
                  onClick={() => handleRemove(member)}
                  className="text-on-surface-variant hover:text-red-400 p-xs rounded cursor-pointer"
                  title="Remove from this project"
                >
                  <span className="material-symbols-outlined text-[18px]">person_remove</span>
                </button>
              )}
            </div>
          ))}
        </div>

        {canManage && (
          <form onSubmit={handleAdd} className="flex flex-col gap-sm border-t border-outline-variant/30 pt-lg">
            <span className="font-label-caps text-[10px] tracking-[0.15em] uppercase text-on-surface-variant">
              Add someone
            </span>

            <div className="flex flex-col sm:flex-row gap-sm">
              <label className="flex flex-col gap-xs flex-1">
                <span className="text-[11px] text-on-surface-variant">Name</span>
                <input
                  id="crew-display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Will"
                  className="bg-surface-container border border-outline-variant rounded-lg px-sm py-xs text-sm text-on-surface outline-none focus:border-primary"
                />
              </label>
              <label className="flex flex-col gap-xs flex-1">
                <span className="text-[11px] text-on-surface-variant">Username</span>
                <input
                  id="crew-username"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="willy"
                  className="bg-surface-container border border-outline-variant rounded-lg px-sm py-xs text-sm text-on-surface outline-none focus:border-primary"
                />
              </label>
            </div>

            <label className="flex flex-col gap-xs">
              <span className="text-[11px] text-on-surface-variant">Password (at least 10 characters)</span>
              <input
                id="crew-password"
                required
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="give them this password"
                className="bg-surface-container border border-outline-variant rounded-lg px-sm py-xs text-sm text-on-surface outline-none focus:border-primary"
              />
            </label>

            <div className="flex flex-col gap-xs">
              <span className="text-[11px] text-on-surface-variant">Roles</span>
              <div className="flex flex-wrap gap-xs">
                {PICKABLE_ROLES.map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => toggleRole(role)}
                    className={`px-sm py-[5px] rounded-lg text-[11px] font-label-caps border transition-colors cursor-pointer ${
                      roles.includes(role)
                        ? 'bg-primary text-background border-primary font-bold'
                        : 'bg-surface-container text-on-surface-variant border-outline-variant hover:text-on-surface'
                    }`}
                  >
                    {ROLE_LABELS[role]}
                  </button>
                ))}
              </div>
              <span className="text-[10px] text-on-surface-variant/70">
                Roles are recorded for later — for now everyone on a project can work on all of it.
              </span>
            </div>

            {error && (
              <div role="alert" className="text-[12px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-sm py-xs">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className={`mt-xs py-sm rounded-lg font-label-caps text-[12px] tracking-wider font-bold transition-all ${
                busy ? 'bg-surface-container-high text-on-surface-variant cursor-wait' : 'bg-primary text-background hover:brightness-110 cursor-pointer'
              }`}
            >
              {busy ? 'ADDING…' : 'ADD TO CREW'}
            </button>
          </form>
        )}

        {!canManage && (
          <p className="text-[11px] text-on-surface-variant border-t border-outline-variant/30 pt-md">
            Only the project owner can add or remove people.
          </p>
        )}
      </div>
    </div>
  );
};
