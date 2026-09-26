import React, { useEffect, useRef, useState } from 'react';
import type { FilmLook, FilmLookFields } from '../../types';
import {
  EMPTY_LOOK,
  composeLookPrompt,
  createLook,
  deleteLook,
  extractPalette,
  listLooks,
  loadImage,
  parseShotDetails,
  updateLook,
  uploadReferenceImage,
} from '../../services/lookService';

interface LookLibraryPanelProps {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

const FIELD_LABELS: Partial<Record<keyof FilmLookFields, string>> = {
  camera: 'camera',
  lens: 'lens',
  filmStock: 'film stock',
  format: 'format',
  aspectRatio: 'aspect ratio',
  lighting: 'lighting',
  colorNotes: 'colour',
  source: 'source',
};

const inputClass =
  'w-full bg-surface-container border border-outline-variant rounded-lg px-sm py-xs text-sm text-on-surface outline-none focus:border-primary placeholder:text-on-surface-variant/40';

const PaletteStrip: React.FC<{ palette: string[]; height?: string; onRemove?: (hex: string) => void }> = ({
  palette,
  height = 'h-3',
  onRemove,
}) => (
  <div className={`flex w-full ${height} rounded overflow-hidden border border-outline-variant/30`}>
    {palette.map((hex) =>
      onRemove ? (
        <button
          key={hex}
          type="button"
          onClick={() => onRemove(hex)}
          style={{ background: hex }}
          className="flex-1 cursor-pointer hover:outline hover:outline-2 hover:outline-primary hover:-outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          title={`${hex} · click to remove`}
          aria-label={`Remove ${hex} from the palette`}
        />
      ) : (
        <div key={hex} style={{ background: hex }} className="flex-1" title={hex} />
      )
    )}
  </div>
);

/**
 * The project's look library: camera, lens, film and grade recipes collected while researching,
 * each with a reference picture, its colour palette and the text the image model will be given.
 */
export const LookLibraryPanel: React.FC<LookLibraryPanelProps> = ({ projectId, projectName, onClose }) => {
  const [looks, setLooks] = useState<FilmLook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // null = the list; 'new' = adding; otherwise the id of the look being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<FilmLookFields>(EMPTY_LOOK);
  const [busy, setBusy] = useState<null | 'saving' | 'uploading' | 'writing' | 'deleting'>(null);
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listLooks(projectId)
      .then(setLooks)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  const set = <K extends keyof FilmLookFields>(key: K, value: FilmLookFields[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const openEditor = (look: FilmLook | null) => {
    setDraft(look ? { ...EMPTY_LOOK, ...look } : EMPTY_LOOK);
    setEditing(look ? look.id : 'new');
    setError(null);
    setPasteNote(null);
    setConfirmDelete(false);
  };

  const backToList = () => {
    setEditing(null);
    setError(null);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose a picture file (JPEG, PNG or WebP).');
      return;
    }
    setBusy('uploading');
    setError(null);
    try {
      const url = await uploadReferenceImage(file);
      const img = await loadImage(url);
      setDraft((prev) => ({ ...prev, referenceUrl: url, palette: extractPalette(img) }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const reExtractPalette = async () => {
    if (!draft.referenceUrl) return;
    try {
      set('palette', extractPalette(await loadImage(draft.referenceUrl)));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handlePaste = (text: string) => {
    const found = parseShotDetails(text);
    const keys = Object.keys(found) as (keyof FilmLookFields)[];
    if (keys.length === 0) {
      setPasteNote('No details recognised. Paste lines like "CAMERA: …" or "LENS: …".');
      return;
    }
    setDraft((prev) => ({
      ...prev,
      ...found,
      // A look is usually named after where it came from.
      name: prev.name || (found.source ? found.source.replace(/\s+/g, ' ') : prev.name),
    }));
    setPasteNote(`Filled ${keys.map((k) => FIELD_LABELS[k] || k).join(', ')}.`);
  };

  const handleWrite = async () => {
    setBusy('writing');
    setError(null);
    try {
      set('lookPrompt', await composeLookPrompt(projectId, draft));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(draft.lookPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copying was blocked by the browser. Select the text and copy it by hand.');
    }
  };

  const handleSave = async () => {
    if (!draft.name.trim()) {
      setError('Give the look a name.');
      return;
    }
    setBusy('saving');
    setError(null);
    try {
      if (editing === 'new') {
        const created = await createLook(projectId, draft);
        setLooks((prev) => [created, ...prev]);
      } else if (editing) {
        const updated = await updateLook(projectId, editing, draft);
        setLooks((prev) => [updated, ...prev.filter((l) => l.id !== updated.id)]);
      }
      backToList();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!editing || editing === 'new') return;
    setBusy('deleting');
    try {
      await deleteLook(projectId, editing);
      setLooks((prev) => prev.filter((l) => l.id !== editing));
      backToList();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const summary = (look: FilmLook) => [look.camera, look.lens, look.filmStock].filter(Boolean).join(' · ');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-md" onClick={onClose}>
      <div
        className="w-full max-w-5xl h-[88vh] bg-surface-container-low border border-outline-variant/50 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-md px-lg py-md border-b border-outline-variant/30">
          <div className="flex flex-col gap-xs min-w-0">
            <span className="font-label-caps text-[10px] tracking-[0.2em] uppercase text-on-surface-variant truncate">
              {projectName}
            </span>
            <div className="flex items-center gap-sm">
              {editing && (
                <button
                  onClick={backToList}
                  className="text-on-surface-variant hover:text-primary p-[2px] rounded cursor-pointer"
                  title="Back to all looks"
                >
                  <span className="material-symbols-outlined text-[20px]">arrow_back</span>
                </button>
              )}
              <h2 className="font-headline-lg text-xl text-on-surface truncate">
                {editing === 'new' ? 'New look' : editing ? draft.name || 'Look' : 'Look Library'}
              </h2>
            </div>
          </div>
          <div className="flex items-center gap-sm shrink-0">
            {!editing && (
              <button
                onClick={() => openEditor(null)}
                className="inline-flex items-center gap-xs px-md py-xs rounded-lg bg-primary text-background font-label-caps text-[11px] tracking-wider font-bold hover:brightness-110 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">add</span>
                ADD LOOK
              </button>
            )}
            <button
              onClick={onClose}
              className="text-on-surface-variant hover:text-primary p-xs rounded-full hover:bg-surface-container-high cursor-pointer"
              title="Close"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
        </div>

        {error && (
          <div role="alert" className="mx-lg mt-md text-[12px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-sm py-xs">
            {error}
          </div>
        )}

        {/* List */}
        {!editing && (
          <div className="flex-1 overflow-y-auto p-lg">
            {loading && <span className="text-xs text-on-surface-variant">Loading…</span>}

            {!loading && looks.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center gap-sm max-w-md mx-auto">
                <span className="material-symbols-outlined text-[40px] text-primary/70">photo_camera</span>
                <h3 className="text-on-surface font-medium">No looks yet</h3>
                <p className="text-[13px] text-on-surface-variant leading-relaxed">
                  A look is a camera, lens, film stock and colour grade you want your shots to have. Add a reference
                  picture and Pantilt takes its colour palette; paste the shot details and it fills in the gear.
                </p>
                <button
                  onClick={() => openEditor(null)}
                  className="mt-xs inline-flex items-center gap-xs px-md py-xs rounded-lg border border-primary text-primary font-label-caps text-[11px] tracking-wider hover:bg-primary hover:text-background cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span>
                  ADD THE FIRST LOOK
                </button>
              </div>
            )}

            {looks.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-md">
                {looks.map((look) => (
                  <button
                    key={look.id}
                    onClick={() => openEditor(look)}
                    className="text-left flex flex-col bg-surface-container rounded-xl border border-outline-variant/30 overflow-hidden hover:border-primary/60 transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <div className="aspect-video bg-black/40 relative">
                      {look.referenceUrl ? (
                        <img src={look.referenceUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div
                          className="w-full h-full"
                          style={{
                            background: look.palette.length > 1 ? `linear-gradient(90deg, ${look.palette.join(', ')})` : undefined,
                          }}
                        />
                      )}
                    </div>
                    <PaletteStrip palette={look.palette} height="h-2" />
                    <div className="flex flex-col gap-[2px] p-sm">
                      <span className="text-sm text-on-surface font-medium truncate">{look.name}</span>
                      {look.source && <span className="text-[11px] text-on-surface-variant truncate">{look.source}</span>}
                      <span className="text-[11px] text-on-surface-variant/80 line-clamp-2">
                        {summary(look) || 'No gear filled in yet'}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Editor */}
        {editing && (
          <>
            <div className="flex-1 overflow-y-auto p-lg">
              <div className="grid grid-cols-1 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-lg">
                {/* Reference + palette */}
                <div className="flex flex-col gap-sm">
                  <span className="font-label-caps text-[10px] tracking-[0.15em] uppercase text-on-surface-variant">
                    Reference picture
                  </span>
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      handleFile(e.dataTransfer.files?.[0]);
                    }}
                    className={`relative aspect-video rounded-xl overflow-hidden border-2 border-dashed transition-colors ${
                      dragging ? 'border-primary bg-primary/10' : 'border-outline-variant/50 bg-surface-container'
                    }`}
                  >
                    {draft.referenceUrl ? (
                      <img src={draft.referenceUrl} alt="Reference" className="w-full h-full object-cover" />
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full h-full flex flex-col items-center justify-center gap-xs text-on-surface-variant hover:text-primary cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[32px]">add_photo_alternate</span>
                        <span className="text-[12px]">Drop a still here, or click to choose one</span>
                      </button>
                    )}
                    {busy === 'uploading' && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-[12px] text-on-surface">
                        Uploading…
                      </div>
                    )}
                  </div>
                  <input
                    ref={fileInputRef}
                    id="look-reference-file"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      handleFile(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                  {draft.referenceUrl && (
                    <div className="flex gap-xs">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-[11px] font-label-caps text-on-surface-variant hover:text-primary px-sm py-[4px] rounded border border-outline-variant/40 cursor-pointer"
                      >
                        REPLACE
                      </button>
                      <button
                        type="button"
                        onClick={() => set('referenceUrl', '')}
                        className="text-[11px] font-label-caps text-on-surface-variant hover:text-red-400 px-sm py-[4px] rounded border border-outline-variant/40 cursor-pointer"
                      >
                        REMOVE
                      </button>
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-sm">
                    <span className="font-label-caps text-[10px] tracking-[0.15em] uppercase text-on-surface-variant">
                      Palette {draft.palette.length > 0 && `· ${draft.palette.length} colours`}
                    </span>
                    {draft.referenceUrl && (
                      <button
                        type="button"
                        onClick={reExtractPalette}
                        className="text-[10px] font-label-caps text-on-surface-variant hover:text-primary cursor-pointer"
                        title="Take the colours from the picture again"
                      >
                        RE-EXTRACT
                      </button>
                    )}
                  </div>
                  {draft.palette.length > 0 ? (
                    <>
                      <PaletteStrip
                        palette={draft.palette}
                        height="h-10"
                        onRemove={(hex) => set('palette', draft.palette.filter((c) => c !== hex))}
                      />
                      <span className="text-[10px] text-on-surface-variant/70 font-mono break-all">
                        {draft.palette.join(' ')}
                      </span>
                    </>
                  ) : (
                    <span className="text-[11px] text-on-surface-variant/70">
                      Taken from the reference picture automatically. Click a colour to drop it.
                    </span>
                  )}
                  <p className="text-[10px] text-on-surface-variant/60 leading-relaxed mt-xs">
                    Only people on this project see its looks. Stills from other films are for your own reference.
                  </p>
                </div>

                {/* Details + look text */}
                <div className="flex flex-col gap-sm">
                  <label className="flex flex-col gap-xs">
                    <span className="font-label-caps text-[10px] tracking-[0.15em] uppercase text-on-surface-variant">
                      Paste shot details
                    </span>
                    <textarea
                      id="look-paste"
                      rows={2}
                      placeholder="Paste the details you are reading, e.g. CAMERA: Panavision Millennium XL2   LENS: Panavision Primo Primes   FILM STOCK: 5219 Vision3 500T"
                      onPaste={(e) => {
                        const text = e.clipboardData.getData('text');
                        if (text) {
                          e.preventDefault();
                          handlePaste(text);
                        }
                      }}
                      onChange={() => {}}
                      value=""
                      className={`${inputClass} resize-none text-[12px]`}
                    />
                    {pasteNote && <span className="text-[11px] text-primary">{pasteNote}</span>}
                  </label>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-sm">
                    <label className="flex flex-col gap-xs">
                      <span className="text-[11px] text-on-surface-variant">Name</span>
                      <input id="look-name" value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Hot afternoon, Bangkok" className={inputClass} />
                    </label>
                    <label className="flex flex-col gap-xs">
                      <span className="text-[11px] text-on-surface-variant">Source</span>
                      <input id="look-source" value={draft.source} onChange={(e) => set('source', e.target.value)} placeholder="Film and year" className={inputClass} />
                    </label>
                    <label className="flex flex-col gap-xs">
                      <span className="text-[11px] text-on-surface-variant">Camera</span>
                      <input id="look-camera" value={draft.camera} onChange={(e) => set('camera', e.target.value)} placeholder="Panavision Millennium XL2" className={inputClass} />
                    </label>
                    <label className="flex flex-col gap-xs">
                      <span className="text-[11px] text-on-surface-variant">Lens</span>
                      <input id="look-lens" value={draft.lens} onChange={(e) => set('lens', e.target.value)} placeholder="Panavision Primo primes" className={inputClass} />
                    </label>
                    <label className="flex flex-col gap-xs">
                      <span className="text-[11px] text-on-surface-variant">Film stock / capture</span>
                      <input id="look-stock" value={draft.filmStock} onChange={(e) => set('filmStock', e.target.value)} placeholder="Kodak Vision3 500T 5219" className={inputClass} />
                    </label>
                    <label className="flex flex-col gap-xs">
                      <span className="text-[11px] text-on-surface-variant">Format</span>
                      <input id="look-format" value={draft.format} onChange={(e) => set('format', e.target.value)} placeholder="35mm film, 3-perf" className={inputClass} />
                    </label>
                    <label className="flex flex-col gap-xs">
                      <span className="text-[11px] text-on-surface-variant">Aspect ratio</span>
                      <input id="look-aspect" value={draft.aspectRatio} onChange={(e) => set('aspectRatio', e.target.value)} placeholder="2.39 spherical" className={inputClass} />
                    </label>
                    <label className="flex flex-col gap-xs">
                      <span className="text-[11px] text-on-surface-variant">Colour</span>
                      <input id="look-color" value={draft.colorNotes} onChange={(e) => set('colorNotes', e.target.value)} placeholder="Warm, saturated, yellow, green" className={inputClass} />
                    </label>
                  </div>
                  <label className="flex flex-col gap-xs">
                    <span className="text-[11px] text-on-surface-variant">Lighting</span>
                    <input id="look-lighting" value={draft.lighting} onChange={(e) => set('lighting', e.target.value)} placeholder="Edge light · daylight · day" className={inputClass} />
                  </label>

                  <div className="flex flex-col gap-xs border-t border-outline-variant/30 pt-md mt-xs">
                    <div className="flex items-center justify-between gap-sm flex-wrap">
                      <span className="font-label-caps text-[10px] tracking-[0.15em] uppercase text-on-surface-variant">
                        Look text for the image model
                      </span>
                      <div className="flex gap-xs">
                        <button
                          type="button"
                          onClick={handleWrite}
                          disabled={busy !== null}
                          className="inline-flex items-center gap-xs px-sm py-[5px] rounded-lg bg-primary/15 border border-primary/50 text-primary font-label-caps text-[10px] tracking-wider hover:bg-primary/25 cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                          title="Gemini writes the look from the details, the palette and the reference picture"
                        >
                          <span className={`material-symbols-outlined text-[14px] ${busy === 'writing' ? 'animate-spin' : ''}`}>
                            {busy === 'writing' ? 'progress_activity' : 'auto_awesome'}
                          </span>
                          {busy === 'writing' ? 'WRITING…' : draft.lookPrompt ? 'REWRITE WITH GEMINI' : 'WRITE WITH GEMINI'}
                        </button>
                        <button
                          type="button"
                          onClick={handleCopy}
                          disabled={!draft.lookPrompt}
                          className="inline-flex items-center gap-xs px-sm py-[5px] rounded-lg border border-outline-variant/50 text-on-surface-variant font-label-caps text-[10px] tracking-wider hover:text-on-surface cursor-pointer disabled:opacity-40 disabled:cursor-default"
                        >
                          <span className="material-symbols-outlined text-[14px]">{copied ? 'check' : 'content_copy'}</span>
                          {copied ? 'COPIED' : 'COPY'}
                        </button>
                      </div>
                    </div>
                    <textarea
                      id="look-prompt"
                      rows={12}
                      value={draft.lookPrompt}
                      onChange={(e) => set('lookPrompt', e.target.value)}
                      placeholder="Format and camera: … Lens: … Film stock: … Lighting: … Color grade: …  Write it yourself, or let Gemini write it from the details above, then edit."
                      className={`${inputClass} font-mono text-[12px] leading-relaxed resize-y`}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-sm px-lg py-md border-t border-outline-variant/30">
              <div>
                {editing !== 'new' &&
                  (confirmDelete ? (
                    <span className="flex items-center gap-xs text-[12px] text-on-surface-variant">
                      Delete this look?
                      <button
                        onClick={handleDelete}
                        disabled={busy !== null}
                        className="px-sm py-[4px] rounded bg-red-500/20 text-red-300 border border-red-500/40 font-label-caps text-[10px] cursor-pointer"
                      >
                        DELETE
                      </button>
                      <button onClick={() => setConfirmDelete(false)} className="px-sm py-[4px] font-label-caps text-[10px] text-on-surface-variant cursor-pointer">
                        KEEP
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="inline-flex items-center gap-xs text-[11px] font-label-caps text-on-surface-variant hover:text-red-400 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                      DELETE
                    </button>
                  ))}
              </div>
              <div className="flex items-center gap-sm">
                <button onClick={backToList} className="px-md py-xs text-[11px] font-label-caps text-on-surface-variant hover:text-on-surface cursor-pointer">
                  CANCEL
                </button>
                <button
                  onClick={handleSave}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-xs px-md py-xs rounded-lg bg-primary text-background font-label-caps text-[11px] tracking-wider font-bold hover:brightness-110 cursor-pointer disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[16px]">save</span>
                  {busy === 'saving' ? 'SAVING…' : 'SAVE LOOK'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
