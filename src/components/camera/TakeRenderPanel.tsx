import React, { useEffect, useState } from 'react';
import type { CameraTake, FilmLook, TakeRender } from '../../types';
import { DEFAULT_PACKAGE, normalizePackage, packageLabel, type CameraPackage } from '../../services/cameraPackage';
import { listLooks } from '../../services/lookService';
import { renderFrame, type RenderStage } from '../../services/renderService';
import { CameraPackagePicker } from './CameraPackagePicker';

interface TakeRenderPanelProps {
  projectId: string;
  take: CameraTake;
  sceneHeading?: string;
  /** Grabs the take's first frame from the viewport as a JPEG data URL. */
  captureFirstFrame: () => Promise<string | null>;
  /** Called when a render finishes, even if this panel was closed in the meantime. */
  onRendered: (takeId: string, render: TakeRender) => void;
  onClose: () => void;
}

const STAGE_TEXT: Record<RenderStage, string> = {
  uploading: 'Sending the first frame…',
  describing: 'Reading the shot…',
  rendering: 'Rendering with Seedream 5 Pro… about two minutes',
};

/**
 * Sends a take's first frame to rendering: the camera package it was shot with (changeable here),
 * an optional grade from the look library, and a note, then shows the realistic frame next to
 * the previs.
 */
export const TakeRenderPanel: React.FC<TakeRenderPanelProps> = ({
  projectId,
  take,
  sceneHeading,
  captureFirstFrame,
  onRendered,
  onClose,
}) => {
  const [frame, setFrame] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [pkg, setPkg] = useState<CameraPackage>(normalizePackage(take.cameraPackage || DEFAULT_PACKAGE));
  const [looks, setLooks] = useState<FilmLook[]>([]);
  const [lookId, setLookId] = useState('');
  const [note, setNote] = useState('');
  const [stage, setStage] = useState<RenderStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renders = take.renders || [];
  const [shownId, setShownId] = useState<string | null>(renders.length ? renders[renders.length - 1].id : null);
  const shown = renders.find((r) => r.id === shownId) || null;

  useEffect(() => {
    let alive = true;
    captureFirstFrame()
      .then((url) => {
        if (!alive) return;
        if (url) setFrame(url);
        else setCaptureError('The viewport could not be captured. Close this and try again.');
      })
      .catch(() => alive && setCaptureError('The viewport could not be captured.'));
    listLooks(projectId).then((l) => alive && setLooks(l)).catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.id]);

  // A new render arriving on the take is shown straight away.
  useEffect(() => {
    if (renders.length) setShownId(renders[renders.length - 1].id);
  }, [renders.length]);

  const handleRender = async () => {
    if (!frame || stage) return;
    setError(null);
    try {
      const result = await renderFrame(
        {
          projectId,
          frame,
          cameraPackage: pkg,
          focalLength: take.focalLength,
          aperture: take.aperture,
          iso: take.iso,
          lookId: lookId || undefined,
          sceneHeading,
          note: note.trim() || undefined,
        },
        setStage
      );
      onRendered(take.id, {
        id: `render_${Date.now()}`,
        createdAt: new Date().toISOString(),
        url: result.url,
        sourceUrl: result.sourceUrl,
        cameraPackage: result.cameraPackage,
        lookId: result.lookId,
        prompt: result.prompt,
        model: result.model,
      });
    } catch (err: any) {
      setError(err.message || 'The render failed.');
    } finally {
      setStage(null);
    }
  };

  const lensLine = [take.focalLength, take.aperture && take.aperture !== 'OFF' ? take.aperture : null, take.iso ? `ISO ${take.iso}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-md" onClick={onClose}>
      <div
        className="w-full max-w-6xl max-h-[92vh] bg-surface-container-low border border-outline-variant/50 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-md px-lg py-md border-b border-outline-variant/30">
          <div className="flex flex-col gap-xs min-w-0">
            <span className="font-label-caps text-[10px] tracking-[0.2em] uppercase text-on-surface-variant truncate">
              {sceneHeading || 'Render'} · {take.name}
            </span>
            <h2 className="font-headline-lg text-xl text-on-surface">Render first frame</h2>
          </div>
          <button onClick={onClose} className="text-on-surface-variant hover:text-primary p-xs rounded-full hover:bg-surface-container-high cursor-pointer" title="Close">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-lg">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-lg">
            {/* Frames */}
            <div className="flex flex-col gap-sm min-w-0">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-sm">
                <figure className="flex flex-col gap-xs">
                  <figcaption className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">Previs · frame 1</figcaption>
                  <div className="aspect-video bg-black/50 rounded-lg overflow-hidden border border-outline-variant/30 flex items-center justify-center">
                    {frame ? (
                      <img src={frame} alt="Previs first frame" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-[12px] text-on-surface-variant">{captureError || 'Capturing the first frame…'}</span>
                    )}
                  </div>
                </figure>
                <figure className="flex flex-col gap-xs">
                  <figcaption className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">
                    {shown ? `Render · ${packageLabel(shown.cameraPackage)}` : 'Render'}
                  </figcaption>
                  <div className="relative aspect-video bg-black/50 rounded-lg overflow-hidden border border-outline-variant/30 flex items-center justify-center">
                    {shown ? (
                      <a href={shown.url} target="_blank" rel="noreferrer" title="Open full size">
                        <img src={shown.url} alt="Rendered frame" className="w-full h-full object-cover" />
                      </a>
                    ) : (
                      <span className="text-[12px] text-on-surface-variant px-md text-center">
                        {stage ? '' : 'Choose the package and press Render.'}
                      </span>
                    )}
                    {stage && (
                      <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-sm text-on-surface">
                        <span className="material-symbols-outlined text-[28px] text-primary animate-spin">progress_activity</span>
                        <span className="text-[12px]">{STAGE_TEXT[stage]}</span>
                      </div>
                    )}
                  </div>
                </figure>
              </div>

              {renders.length > 0 && (
                <div className="flex flex-col gap-xs mt-xs">
                  <span className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">
                    Renders of this take · {renders.length}
                  </span>
                  <div className="flex gap-xs overflow-x-auto pb-xs">
                    {renders.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => setShownId(r.id)}
                        title={packageLabel(r.cameraPackage)}
                        className={`shrink-0 w-28 aspect-video rounded overflow-hidden border-2 cursor-pointer ${
                          r.id === shownId ? 'border-primary' : 'border-transparent opacity-70 hover:opacity-100'
                        }`}
                      >
                        <img src={r.url} alt="" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {shown && (
                <details className="text-[11px] text-on-surface-variant">
                  <summary className="cursor-pointer font-label-caps text-[10px] tracking-wider">Show the prompt of this render</summary>
                  <pre className="mt-xs whitespace-pre-wrap bg-surface-container rounded-lg p-sm border border-outline-variant/30 font-mono text-[11px] leading-relaxed text-on-surface max-h-72 overflow-y-auto">
                    {shown.prompt}
                  </pre>
                </details>
              )}
            </div>

            {/* Settings */}
            <div className="flex flex-col gap-md">
              <div className="flex flex-col gap-xs">
                <span className="font-label-caps text-[10px] tracking-[0.15em] uppercase text-on-surface-variant">Camera package</span>
                <CameraPackagePicker value={pkg} onChange={setPkg} idPrefix="render" />
                {lensLine && <span className="text-[11px] text-on-surface-variant">From the take: {lensLine}</span>}
                {!take.cameraPackage && (
                  <span className="text-[11px] text-amber-300/90">This take was recorded before packages existed; choose one here.</span>
                )}
              </div>

              <label className="flex flex-col gap-[3px]">
                <span className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">Grade</span>
                <select
                  id="render-look"
                  value={lookId}
                  onChange={(e) => setLookId(e.target.value)}
                  className="w-full bg-surface-container border border-outline-variant rounded-lg px-sm py-[6px] text-[12px] text-on-surface outline-none focus:border-primary cursor-pointer"
                >
                  <option value="">Neutral · no look</option>
                  {looks.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
                <span className="text-[10px] text-on-surface-variant/70">Looks come from the LOOKS library of this film.</span>
              </label>

              <label className="flex flex-col gap-[3px]">
                <span className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">Note for this shot</span>
                <textarea
                  id="render-note"
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Who the actors are, wardrobe, anything to change. e.g. The man is in his fifties, grey beard, brown leather jacket."
                  className="w-full bg-surface-container border border-outline-variant rounded-lg px-sm py-xs text-[12px] text-on-surface outline-none focus:border-primary resize-y placeholder:text-on-surface-variant/40"
                />
              </label>

              {error && (
                <div role="alert" className="text-[12px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-sm py-xs">
                  {error}
                </div>
              )}

              <button
                onClick={handleRender}
                disabled={!frame || !!stage}
                className="inline-flex items-center justify-center gap-xs py-sm rounded-lg bg-primary text-background font-label-caps text-[12px] tracking-wider font-bold hover:brightness-110 cursor-pointer disabled:opacity-50 disabled:cursor-wait"
              >
                <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
                {stage ? 'RENDERING…' : renders.length ? 'RENDER AGAIN' : 'RENDER'}
              </button>
              <span className="text-[10px] text-on-surface-variant/70 -mt-sm text-center">
                Seedream 5 Pro · about two minutes · counts as one generation. You can close this window while it renders.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
