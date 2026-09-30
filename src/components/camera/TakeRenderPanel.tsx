import React, { useEffect, useRef, useState } from 'react';
import type { CameraTake, CharacterActor, FilmLook, TakeRender } from '../../types';
import { DEFAULT_PACKAGE, normalizePackage, packageLabel, type CameraPackage } from '../../services/cameraPackage';
import { listLooks, uploadReferenceImage } from '../../services/lookService';
import {
  defaultPassFor,
  depthOfField,
  makeBlurPass,
  makeClayPass,
  measurePeople,
  placementSentence,
  renderFrame,
  standInColourName,
  type DepthInfo,
  type LensAtFrame,
  type PeopleMask,
  type RenderPass,
  type RenderStage,
} from '../../services/renderService';

/** Frame 1 as the viewport drew it, its depth, and the lens it was drawn with. */
export interface FirstFrameCapture {
  frame: string;
  depth: DepthInfo | null;
  lens: LensAtFrame;
  /**
   * Ids of the actors actually visible inside the camera frame at frame 1, or null when that
   * could not be worked out. Someone who only walks in later gets no sheet, or the render adds them.
   */
  inFrame: string[] | null;
  /** Which actor covers each pixel of the frame, to keep them readable in the layout pass. */
  people: PeopleMask | null;
}
import { CameraPackagePicker } from './CameraPackagePicker';

interface TakeRenderPanelProps {
  projectId: string;
  take: CameraTake;
  sceneHeading?: string;
  /** Grabs the take's first frame from the viewport, with its depth and lens. */
  captureFirstFrame: () => Promise<FirstFrameCapture | null>;
  /** Called when a render finishes, even if this panel was closed in the meantime. */
  onRendered: (takeId: string, render: TakeRender) => void;
  /** The scene's characters, whose character sheets go with the render. */
  characters: CharacterActor[];
  /** Stores a changed sheet on its character (saved with the scene). */
  onUpdateCharacter: (id: string, patch: Partial<CharacterActor>) => void;
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
  characters,
  onUpdateCharacter,
  onClose,
}) => {
  const [capture, setCapture] = useState<FirstFrameCapture | null>(null);
  const frame = capture?.frame ?? null;
  const dof = capture ? depthOfField(capture.lens) : null;
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [pkg, setPkg] = useState<CameraPackage>(normalizePackage(take.cameraPackage || DEFAULT_PACKAGE));
  const [looks, setLooks] = useState<FilmLook[]>([]);
  const [lookId, setLookId] = useState('');
  const [note, setNote] = useState('');
  // Characters left out of this one render (their sheet stays on the character).
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const sheetInputRef = useRef<HTMLInputElement>(null);
  const sheetTargetRef = useRef<string | null>(null);
  const cast = characters.filter((c) => c.visible !== false);
  const castSent = cast.filter((c) => c.referenceSheetUrl && !skipped.has(c.id)).slice(0, 8);
  /** Where each person in the frame is and how big, named the way the prompt names them. */
  const placementsFor = (people: PeopleMask | null): string[] =>
    people
      ? measurePeople(people).flatMap((p) => {
          const c = characters.find((x) => x.id === p.actorId);
          if (!c || (capture?.inFrame && !capture.inFrame.includes(c.id))) return [];
          const colour = standInColourName(c.color);
          const sent = castSent.some((x) => x.id === c.id);
          return [placementSentence(sent ? `${c.name} (the ${colour} figure)` : `The ${colour} figure`, p)];
        })
      : [];
  const [pass, setPass] = useState<RenderPass>(defaultPassFor(sceneHeading));
  const [layouts, setLayouts] = useState<{ blur?: string; clay?: string }>({});
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [stage, setStage] = useState<RenderStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renders = take.renders || [];
  const [shownId, setShownId] = useState<string | null>(renders.length ? renders[renders.length - 1].id : null);
  const shown = renders.find((r) => r.id === shownId) || null;

  useEffect(() => {
    let alive = true;
    captureFirstFrame()
      .then((result) => {
        if (!alive) return;
        if (result?.inFrame) {
          // Out of shot at frame 1: leave their sheet out, but let it be switched back on by hand.
          const out = characters.filter((c) => !result.inFrame!.includes(c.id)).map((c) => c.id);
          if (out.length) setSkipped((prev) => new Set([...prev, ...out]));
        }
        if (result) setCapture(result);
        else setCaptureError('The viewport could not be captured. Close this and try again.');
      })
      .catch(() => alive && setCaptureError('The viewport could not be captured.'));
    listLooks(projectId).then((l) => alive && setLooks(l)).catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.id]);

  // Prepare the chosen layout pass once the frame is in, so it can be checked before paying for a
  // render. Both passes are made from the textured frame.
  useEffect(() => {
    if (!capture || pass === 'full' || layouts[pass]) return;
    let alive = true;
    setLayoutError(null);
    const extra = { depth: capture.depth, lens: capture.lens, people: capture.people };
    const make = pass === 'blur' ? makeBlurPass(capture.frame, extra) : makeClayPass(capture.frame, extra);
    make
      .then((url) => {
        if (!alive) return;
        if (url) setLayouts((prev) => ({ ...prev, [pass]: url }));
        else setLayoutError('The layout pass could not be made.');
      })
      .catch(() => alive && setLayoutError('The layout pass could not be made.'));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, pass]);

  const layout = pass === 'full' ? frame : layouts[pass] || null;

  // A new render arriving on the take is shown straight away.
  useEffect(() => {
    if (renders.length) setShownId(renders[renders.length - 1].id);
  }, [renders.length]);

  const handleRender = async () => {
    if (!frame || !layout || stage) return;
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
          pass,
          layout: pass === 'full' ? undefined : layout,
          dof,
          cast: castSent.map((c) => ({ name: c.name, colorName: standInColourName(c.color), sheetUrl: c.referenceSheetUrl! })),
          placements: placementsFor(capture?.people ?? null),
        },
        setStage
      );
      onRendered(take.id, {
        id: `render_${Date.now()}`,
        createdAt: new Date().toISOString(),
        url: result.url,
        sourceUrl: result.sourceUrl,
        layoutUrl: result.layoutUrl,
        pass: result.pass,
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
              <div className="grid grid-cols-2 gap-sm">
                <figure className="flex flex-col gap-xs">
                  <figcaption className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">Previs · frame 1</figcaption>
                  <div className="aspect-video bg-black/50 rounded-lg overflow-hidden border border-outline-variant/30 flex items-center justify-center">
                    {frame ? (
                      <img src={frame} alt="Previs first frame" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-[11px] text-on-surface-variant px-sm text-center">{captureError || 'Capturing the first frame…'}</span>
                    )}
                  </div>
                </figure>
                <figure className="flex flex-col gap-xs">
                  <figcaption className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">
                    Sent to Seedream · {pass === 'full' ? 'the frame itself' : `${pass} pass`}
                  </figcaption>
                  <div className="aspect-video bg-black/50 rounded-lg overflow-hidden border border-outline-variant/30 flex items-center justify-center">
                    {layout ? (
                      <img src={layout} alt={`${pass} layout pass`} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-[11px] text-on-surface-variant px-sm text-center">
                        {layoutError || (frame ? `Making the ${pass} pass…` : '')}
                      </span>
                    )}
                  </div>
                </figure>
              </div>

              {(() => {
                const look = looks.find((l) => l.id === lookId);
                const lookPicture = pkg.backId !== 'doublex' ? look?.referenceUrl : undefined;
                const sent: { label: string; src: string | null }[] = [
                  { label: `1 · ${pass === 'full' ? 'frame' : `${pass} pass`}`, src: layout },
                  ...(lookPicture ? [{ label: `${2} · look`, src: lookPicture }] : []),
                  ...castSent.map((c, i) => ({ label: `${(lookPicture ? 3 : 2) + i} · ${c.name}`, src: c.referenceSheetUrl! })),
                ];
                return (
                  <div className="flex flex-col gap-xs">
                    <span className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">
                      Images sent to Seedream · {sent.length}
                    </span>
                    <div className="flex gap-xs overflow-x-auto pb-[2px]">
                      {sent.map((img) => (
                        <figure key={img.label} className="shrink-0 w-28 flex flex-col gap-[2px]">
                          <div className="aspect-video bg-black/50 rounded overflow-hidden border border-outline-variant/30">
                            {img.src && <img src={img.src} alt={img.label} className="w-full h-full object-cover" />}
                          </div>
                          <figcaption className="text-[10px] text-on-surface-variant truncate">Image {img.label}</figcaption>
                        </figure>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <figure className="flex flex-col gap-xs">
                <figcaption className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">
                  {shown ? `Render · ${shown.pass ? `${shown.pass} pass · ` : ''}${packageLabel(shown.cameraPackage)}` : 'Render'}
                </figcaption>
                <div className="relative aspect-video bg-black/50 rounded-lg overflow-hidden border border-outline-variant/30 flex items-center justify-center">
                  {shown ? (
                    <a href={shown.url} target="_blank" rel="noreferrer" title="Open full size" className="w-full h-full">
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
              {capture && (
                <span className="text-[11px] text-on-surface-variant">
                  {dof
                    ? `Focus ${dof.focusM.toFixed(1)} m · sharp ${dof.nearM.toFixed(1)}–${dof.farM === null ? '∞' : `${dof.farM.toFixed(1)} m`} · ${dof.focalMm}mm T${dof.stop}`
                    : 'Iris is OFF in the viewport: no depth of field to put in the pass.'}
                  {!capture.depth && ' · no depth captured'}
                </span>
              )}
                {!take.cameraPackage && (
                  <span className="text-[11px] text-amber-300/90">This take was recorded before packages existed; choose one here.</span>
                )}
              </div>

              <div className="flex flex-col gap-[3px]">
                <span className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">Layout pass sent to Seedream</span>
                <div className="flex bg-surface-container rounded-lg border border-outline-variant p-[2px]">
                  {([['blur', 'Blur'], ['clay', 'Clay'], ['full', 'Full']] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setPass(id)}
                      disabled={!!stage}
                      className={`flex-1 py-[5px] rounded text-[11px] font-label-caps cursor-pointer disabled:cursor-wait ${
                        pass === id ? 'bg-primary text-background font-bold' : 'text-on-surface-variant hover:text-on-surface'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="text-[10px] text-on-surface-variant/70">
                  {pass === 'blur'
                    ? 'Grey and blurred: keeps camera, room and poses, frees every surface. Best for interiors.'
                    : pass === 'clay'
                      ? 'Flat grey tones: keeps edges, windows and structure, drops colour and surface detail. Best for exteriors.'
                      : 'The textured previs itself. Copies its surfaces and light closely.'}
                </span>
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

              <div className="flex flex-col gap-xs">
                <span className="font-label-caps text-[9px] tracking-[0.15em] uppercase text-on-surface-variant">Cast · character sheets</span>
                {cast.length === 0 && <span className="text-[10px] text-on-surface-variant/70">No characters in this scene.</span>}
                {cast.map((c) => {
                  const on = !!c.referenceSheetUrl && !skipped.has(c.id);
                  const outOfFrame = !!capture?.inFrame && !capture.inFrame.includes(c.id);
                  return (
                    <div key={c.id} className="flex items-center gap-xs bg-surface-container rounded-lg border border-outline-variant/30 p-[4px]">
                      <span className="w-3 h-3 rounded-full shrink-0 border border-white/20" style={{ background: c.color || '#00ffcc' }} title={`${standInColourName(c.color)} stand-in`} />
                      <div className="w-10 h-10 rounded bg-black/40 overflow-hidden shrink-0 border border-outline-variant/30">
                        {c.referenceSheetUrl && <img src={c.referenceSheetUrl} alt="" className="w-full h-full object-cover" />}
                      </div>
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-[11px] text-on-surface truncate">{c.name}</span>
                        <span className="text-[10px] text-on-surface-variant/70 truncate">
                          {uploadingFor === c.id
                            ? 'Uploading…'
                            : outOfFrame
                            ? on
                              ? 'Not in the first frame, but the sheet is sent'
                              : 'Not in the first frame: left out'
                            : c.referenceSheetUrl
                            ? on
                              ? 'Sheet goes with the render'
                              : 'Left out of this render'
                            : 'No sheet: Seedream invents this person'}
                        </span>
                      </div>
                      {c.referenceSheetUrl && (
                        <button
                          type="button"
                          onClick={() => setSkipped((prev) => { const next = new Set(prev); next.has(c.id) ? next.delete(c.id) : next.add(c.id); return next; })}
                          title={on ? 'Leave this person out of this render' : 'Send this person\'s sheet'}
                          className={`material-symbols-outlined text-[16px] cursor-pointer ${on ? 'text-primary' : 'text-on-surface-variant/50'}`}
                        >
                          {on ? 'check_circle' : 'radio_button_unchecked'}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={uploadingFor !== null}
                        onClick={() => { sheetTargetRef.current = c.id; sheetInputRef.current?.click(); }}
                        className="text-[10px] font-label-caps text-on-surface-variant hover:text-primary px-[6px] py-[3px] rounded border border-outline-variant/40 cursor-pointer disabled:opacity-40"
                      >
                        {c.referenceSheetUrl ? 'REPLACE' : 'ADD SHEET'}
                      </button>
                      {c.referenceSheetUrl && (
                        <button type="button" onClick={() => onUpdateCharacter(c.id, { referenceSheetUrl: undefined })} title="Remove the sheet" className="material-symbols-outlined text-[16px] text-on-surface-variant hover:text-red-400 cursor-pointer">
                          close
                        </button>
                      )}
                    </div>
                  );
                })}
                <input
                  ref={sheetInputRef}
                  id="render-cast-sheet"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    const id = sheetTargetRef.current;
                    e.target.value = '';
                    if (!file || !id) return;
                    setUploadingFor(id);
                    setError(null);
                    try {
                      onUpdateCharacter(id, { referenceSheetUrl: await uploadReferenceImage(file) });
                      setSkipped((prev) => { const next = new Set(prev); next.delete(id); return next; });
                    } catch (err: any) {
                      setError(err.message || 'The sheet could not be uploaded.');
                    } finally {
                      setUploadingFor(null);
                    }
                  }}
                />
                {cast.filter((c) => c.referenceSheetUrl).length > 8 && (
                  <span className="text-[10px] text-amber-300/90">Seedream takes 8 people at most; the first 8 with sheets are sent.</span>
                )}
              </div>

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
                disabled={!frame || !layout || !!stage}
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
