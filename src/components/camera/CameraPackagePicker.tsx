import React from 'react';
import {
  CAMERA_BODIES,
  LENS_SETS,
  backsFor,
  normalizePackage,
  type CameraPackage,
} from '../../services/cameraPackage';

interface CameraPackagePickerProps {
  value: CameraPackage;
  onChange: (pkg: CameraPackage) => void;
  /** Prefix for the select ids, so two pickers on one screen don't collide. */
  idPrefix: string;
}

const selectClass =
  'w-full bg-surface-container border border-outline-variant rounded-lg px-sm py-[6px] text-[12px] text-on-surface outline-none focus:border-primary cursor-pointer';

/** Camera body, lens set and film back. Picking a film camera swaps the backs to film stocks. */
export const CameraPackagePicker: React.FC<CameraPackagePickerProps> = ({ value, onChange, idPrefix }) => {
  const pkg = normalizePackage(value);
  const set = (patch: Partial<CameraPackage>) => onChange(normalizePackage({ ...pkg, ...patch }));
  const digital = CAMERA_BODIES.filter((c) => c.kind === 'digital');
  const film = CAMERA_BODIES.filter((c) => c.kind === 'film');
  const spherical = LENS_SETS.filter((l) => !l.anamorphic);
  const anamorphic = LENS_SETS.filter((l) => l.anamorphic);
  const backs = backsFor(pkg.cameraId);

  return (
    <div className="flex flex-col gap-sm">
      <label className="flex flex-col gap-[3px]">
        <span className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">Camera body</span>
        <select id={`${idPrefix}-camera`} value={pkg.cameraId} onChange={(e) => set({ cameraId: e.target.value })} className={selectClass}>
          <optgroup label="Digital">
            {digital.map((c) => (
              <option key={c.id} value={c.id}>{c.name} · {c.format}</option>
            ))}
          </optgroup>
          <optgroup label="Film">
            {film.map((c) => (
              <option key={c.id} value={c.id}>{c.name} · {c.format}</option>
            ))}
          </optgroup>
        </select>
      </label>
      <label className="flex flex-col gap-[3px]">
        <span className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">Lens set</span>
        <select id={`${idPrefix}-lens`} value={pkg.lensId} onChange={(e) => set({ lensId: e.target.value })} className={selectClass}>
          <optgroup label="Spherical">
            {spherical.map((l) => (
              <option key={l.id} value={l.id}>{l.name} · {l.character}</option>
            ))}
          </optgroup>
          <optgroup label="Anamorphic">
            {anamorphic.map((l) => (
              <option key={l.id} value={l.id}>{l.name} · {l.character}</option>
            ))}
          </optgroup>
        </select>
      </label>
      <label className="flex flex-col gap-[3px]">
        <span className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">
          {backs[0]?.kind === 'film' ? 'Film stock' : 'Film back'}
        </span>
        <select
          id={`${idPrefix}-back`}
          value={pkg.backId}
          onChange={(e) => set({ backId: e.target.value })}
          disabled={backs.length < 2}
          className={`${selectClass} disabled:opacity-70 disabled:cursor-default`}
        >
          {backs.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </label>
    </div>
  );
};
