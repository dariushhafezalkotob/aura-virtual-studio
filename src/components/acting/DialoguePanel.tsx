import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CharacterActor, DialogueCastMember, DialogueLine, DialogueScene } from '../../types';
import {
  DEFAULT_TTS_MODEL,
  GEMINI_VOICES,
  layoutLinesSequentially,
  linesFromScript,
  speakersOf,
  spokenText,
} from '../../services/dialogueScript';
import { DialogueService, getGeminiKey, setGeminiKey } from '../../services/dialogueService';

interface DialoguePanelProps {
  scene: DialogueScene | undefined;
  characters: CharacterActor[];
  timelineSec: number;
  isGeneratingMotion: boolean;
  onChange: (scene: DialogueScene) => void;
  onSeek: (t: number) => void;
  /** Writes talk/listen segments onto every cast actor. */
  onApplyToActors: (scene: DialogueScene) => void;
  /** Applies segments and runs Kimodo for every cast actor. */
  onGenerateMotion: (scene: DialogueScene) => void;
  onClose: () => void;
}

const EMPTY_SCENE: DialogueScene = {
  script: '',
  audioMode: 'per_line',
  cast: [],
  lines: [],
  gapSec: 0.6,
  ttsModel: DEFAULT_TTS_MODEL,
};

/** Default voices for the first speakers, picked to sound clearly different from each other. */
const DEFAULT_VOICE_ORDER = ['Charon', 'Puck', 'Kore', 'Fenrir', 'Aoede', 'Orus'];

const LEAD_IN_SEC = 0.5;
const TAIL_SEC = 1.0;
const PARALLEL_TTS = 3;

function fmt(t: number) {
  return t.toFixed(2);
}

export const DialoguePanel: React.FC<DialoguePanelProps> = ({
  scene: sceneProp,
  characters,
  timelineSec,
  isGeneratingMotion,
  onChange,
  onSeek,
  onApplyToActors,
  onGenerateMotion,
  onClose,
}) => {
  const scene = sceneProp || EMPTY_SCENE;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  const [scriptDraft, setScriptDraft] = useState(scene.script);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [hasKey, setHasKey] = useState(() => !!getGeminiKey());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setScriptDraft(scene.script);
    // Only when a different scene arrives (e.g. project switch), not on every edit we make.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneProp === undefined]);

  const update = (patch: Partial<DialogueScene>) => {
    const next = { ...sceneRef.current, ...patch };
    sceneRef.current = next;
    onChange(next);
  };

  /** Re-parse the script, keeping lines (and their audio/timing) that did not change. */
  const commitScript = (script: string) => {
    const lines = linesFromScript(script, sceneRef.current.lines);
    const speakers = speakersOf(lines);
    const cast: DialogueCastMember[] = speakers.map((speaker, i) => {
      const existing = sceneRef.current.cast.find((c) => c.speaker === speaker);
      if (existing) return existing;
      const byName = characters.find((a) => a.name.trim().toUpperCase() === speaker);
      const unused = characters.filter((a) => !sceneRef.current.cast.some((c) => c.actorId === a.id));
      return {
        speaker,
        actorId: byName?.id || unused[i]?.id || characters[i]?.id,
        voice: DEFAULT_VOICE_ORDER[i % DEFAULT_VOICE_ORDER.length],
      };
    });
    update({ script, lines, cast });
  };

  // Debounce script parsing: saving the project on every keystroke would rewrite a large file.
  useEffect(() => {
    if (scriptDraft === sceneRef.current.script) return;
    const t = setTimeout(() => commitScript(scriptDraft), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptDraft]);

  const flushScript = () => {
    if (scriptDraft !== sceneRef.current.script) commitScript(scriptDraft);
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    flushScript();
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  const voiceOf = (speaker: string) => sceneRef.current.cast.find((c) => c.speaker === speaker)?.voice || 'Kore';
  const timed = scene.lines.length > 0 && scene.lines.every((l) => l.end > l.start);

  // --- Option A: one clip per line, laid out with pauses and mixed into one track.
  const assemblePerLine = async (lines: DialogueLine[], gapSec: number) => {
    const previousTrack = sceneRef.current.audioUrl;
    // Lines without a voice (deleted, or new after a script edit) are left off the track.
    const voiced = lines.filter((l) => l.audioUrl);
    const layout = layoutLinesSequentially(
      voiced.map((l) => ({ id: l.id, clipDuration: Math.max(0.05, l.end - l.start) })),
      gapSec,
      LEAD_IN_SEC
    );
    const placed = lines.map((l) => (layout.has(l.id) ? { ...l, ...layout.get(l.id)! } : { ...l, start: 0, end: 0 }));
    if (voiced.length === 0) {
      update({ lines: placed, audioUrl: undefined, duration: undefined, gapSec, audioMode: 'per_line' });
    } else {
      const total = Math.max(...placed.map((l) => l.end)) + TAIL_SEC;
      const track = await DialogueService.assembleTrack(
        placed.filter((l) => l.audioUrl).map((l) => ({ url: l.audioUrl!, start: l.start })),
        total
      );
      update({ lines: placed, audioUrl: track.url, duration: track.duration, gapSec, audioMode: 'per_line' });
    }
    // The mixed track is rebuilt from the line clips every time, so the old one is no longer needed.
    if (previousTrack && previousTrack !== sceneRef.current.audioUrl && /dialogue_track_/.test(previousTrack)) {
      DialogueService.deleteAudio([previousTrack]).catch(() => {});
    }
  };

  const deleteLineVoice = (id: string) =>
    run('Deleting voice…', async () => {
      const line = sceneRef.current.lines.find((l) => l.id === id);
      if (!line?.audioUrl) return;
      const lines = sceneRef.current.lines.map((l) => (l.id === id ? { ...l, audioUrl: undefined, start: 0, end: 0 } : l));
      await assemblePerLine(lines, sceneRef.current.gapSec);
      await DialogueService.deleteAudio([line.audioUrl]);
    });

  const deleteAllVoices = () => {
    const s = sceneRef.current;
    const urls = [s.audioUrl, ...s.lines.map((l) => l.audioUrl)].filter(Boolean);
    if (urls.length === 0) return;
    if (!window.confirm('Delete all voices for this scene? The audio files will be removed. Your script, cast and actor motion stay.')) return;
    return run('Deleting voices…', async () => {
      update({
        audioUrl: undefined,
        duration: undefined,
        lines: s.lines.map((l) => ({ ...l, audioUrl: undefined, start: 0, end: 0 })),
      });
      await DialogueService.deleteAudio(urls);
    });
  };

  const hasAnyVoice = !!scene.audioUrl || scene.lines.some((l) => l.audioUrl);

  const generatePerLine = (only?: string) =>
    run(only ? 'Regenerating line…' : 'Generating voices…', async () => {
      const lines = [...sceneRef.current.lines];
      // After a script edit only the changed lines lack audio: voice just those. Otherwise redo all.
      const anyMissing = lines.some((l) => !l.audioUrl);
      const todo = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => (only ? l.id === only : anyMissing ? !l.audioUrl : true));
      const total = todo.length;
      let done = 0;
      const worker = async () => {
        while (todo.length) {
          const { l, i } = todo.shift()!;
          const clip = await DialogueService.generateLineVoice(l.text, voiceOf(l.speaker), sceneRef.current.ttsModel);
          // Store the clip's own length as start/end 0..duration until layout places it.
          lines[i] = { ...l, audioUrl: clip.url, start: 0, end: clip.duration };
          done++;
          setBusy(`Generating voices… ${done}/${total}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL_TTS, todo.length) }, worker));

      const missing = lines.filter((l) => !l.audioUrl);
      if (missing.length) {
        update({ lines });
        throw new Error(`${missing.length} line(s) still need a voice. Click “Generate voices”.`);
      }
      // Clip durations: freshly generated lines hold 0..duration; older ones hold their placed span.
      await assemblePerLine(lines, sceneRef.current.gapSec);
    });

  const respacePerLine = (gapSec: number) =>
    run('Re-spacing lines…', async () => {
      await assemblePerLine(sceneRef.current.lines, gapSec);
    });

  // --- Option B: one performance for the whole scene, then match the script to it.
  const alignTo = async (audioUrl: string, audioMode: DialogueScene['audioMode']) => {
    setBusy('Finding each line in the audio…');
    const lines = sceneRef.current.lines;
    const res = await DialogueService.alignLines(
      audioUrl,
      lines.map((l) => ({ speaker: l.speaker, text: l.text }))
    );
    update({
      audioMode,
      audioUrl,
      duration: res.duration,
      lines: lines.map((l, i) => ({ ...l, audioUrl: undefined, start: res.lines[i].start, end: res.lines[i].end })),
    });
  };

  const generateWholeScene = () =>
    run('Generating the whole scene…', async () => {
      const s = sceneRef.current;
      if (s.cast.length > 2) throw new Error('Whole-scene voices support up to two speakers. Use “Per line” for more.');
      const track = await DialogueService.generateSceneVoices(
        s.lines.map((l) => ({ speaker: l.speaker, text: l.text })),
        s.cast.map((c) => ({ speaker: c.speaker, voice: c.voice })),
        s.ttsModel
      );
      await alignTo(track.url, 'whole_scene');
    });

  const importAudio = (file: File) =>
    run('Uploading audio…', async () => {
      if (!/\.wav$/i.test(file.name)) throw new Error('Please import a WAV file.');
      const url = await DialogueService.uploadAudio(file);
      await alignTo(url, 'import');
    });

  const nudgeLine = (id: string, field: 'start' | 'end', value: number) => {
    const lines = sceneRef.current.lines.map((l) => {
      if (l.id !== id) return l;
      const next = { ...l, [field]: Math.max(0, value) };
      if (next.end < next.start + 0.1) {
        if (field === 'start') next.end = next.start + 0.1;
        else next.start = Math.max(0, next.end - 0.1);
      }
      return next;
    });
    update({ lines });
  };

  const setCast = (speaker: string, patch: Partial<DialogueCastMember>) =>
    update({ cast: sceneRef.current.cast.map((c) => (c.speaker === speaker ? { ...c, ...patch } : c)) });

  const castReady = scene.cast.length > 0 && scene.cast.every((c) => c.actorId);
  const activeLineId = useMemo(
    () => scene.lines.find((l) => timelineSec >= l.start && timelineSec < l.end)?.id,
    [scene.lines, timelineSec]
  );

  const tabBtn = (mode: DialogueScene['audioMode'], icon: string, label: string) => (
    <button
      onClick={() => update({ audioMode: mode })}
      className={`flex-1 px-2 py-1.5 rounded-lg text-[10px] font-label-caps tracking-wider flex items-center justify-center gap-1 border cursor-pointer ${
        scene.audioMode === mode
          ? 'bg-primary text-background border-primary'
          : 'bg-surface-container-high/60 border-outline-variant/30 text-on-surface-variant hover:text-primary'
      }`}
    >
      <span className="material-symbols-outlined text-[14px]">{icon}</span>
      {label}
    </button>
  );

  return (
    <div className="w-[380px] max-w-[calc(100vw-2rem)] h-full flex flex-col bg-surface-container/95 backdrop-blur-xl border border-outline-variant/40 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-md py-sm border-b border-outline-variant/30">
        <div className="flex items-center gap-xs font-label-caps text-xs tracking-wider text-primary">
          <span className="material-symbols-outlined text-[18px]">record_voice_over</span>
          DIALOGUE PREVIS
        </div>
        <button onClick={onClose} className="text-on-surface-variant hover:text-primary cursor-pointer">
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-md space-y-md text-xs">
        {/* Gemini key */}
        {!hasKey && (
          <div className="p-sm rounded-xl border border-amber-500/40 bg-amber-500/10 space-y-1.5">
            <div className="text-amber-200 text-[11px]">Add your Gemini API key to generate voices.</div>
            <div className="flex gap-1">
              <input
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="Gemini API key"
                className="flex-1 bg-background/60 border border-outline-variant/40 rounded-lg px-2 py-1 text-on-surface"
              />
              <button
                onClick={() => {
                  if (!keyDraft.trim()) return;
                  setGeminiKey(keyDraft.trim());
                  setKeyDraft('');
                  setHasKey(true);
                }}
                className="px-2 rounded-lg bg-primary text-background font-bold cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {/* 1. Script */}
        <section className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-label-caps tracking-wider text-on-surface-variant">1 · SCRIPT</span>
            <span className="text-[10px] text-on-surface-variant/70">
              {scene.lines.length} lines · {scene.cast.length} speakers
            </span>
          </div>
          <textarea
            value={scriptDraft}
            onChange={(e) => setScriptDraft(e.target.value)}
            onBlur={flushScript}
            rows={7}
            spellCheck={false}
            placeholder={'DAVID\n[suspicion] Are you going to tell me what happened?\nMARK\n[exhaustion] I got laid off this morning.'}
            className="w-full bg-background/60 border border-outline-variant/40 rounded-xl p-2 font-mono text-[11px] leading-snug text-on-surface resize-y"
          />
        </section>

        {scriptDraft.trim() && scene.lines.length === 0 && (
          <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-1.5">
            No lines found yet. Put each speaker's name on its own line (e.g. <b>DAVID</b>) or start the line with
            it (e.g. <b>David:</b>), followed by what they say.
          </p>
        )}

        {/* 2. Cast */}
        {scene.cast.length > 0 && (
          <section className="space-y-1">
            <span className="font-label-caps tracking-wider text-on-surface-variant">2 · CAST</span>
            {scene.cast.map((c) => (
              <div key={c.speaker} className="flex items-center gap-1">
                <span className="w-20 truncate font-bold text-on-surface" title={c.speaker}>
                  {c.speaker}
                </span>
                <select
                  value={c.actorId || ''}
                  onChange={(e) => setCast(c.speaker, { actorId: e.target.value || undefined })}
                  className="flex-1 min-w-0 bg-background/60 border border-outline-variant/40 rounded-lg px-1 py-1 text-on-surface"
                >
                  <option value="">— actor —</option>
                  {characters.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.avatar} {a.name}
                    </option>
                  ))}
                </select>
                <select
                  value={c.voice}
                  onChange={(e) => setCast(c.speaker, { voice: e.target.value })}
                  title="Gemini voice"
                  className="w-28 bg-background/60 border border-outline-variant/40 rounded-lg px-1 py-1 text-on-surface"
                >
                  {GEMINI_VOICES.map((v) => (
                    <option key={v} value={v}>
                      🎙 {v}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </section>
        )}

        {/* 3. Audio */}
        {scene.lines.length > 0 && (
          <section className="space-y-1.5">
            <span className="font-label-caps tracking-wider text-on-surface-variant">3 · VOICES</span>
            <div className="flex gap-1">
              {tabBtn('per_line', 'splitscreen', 'Per line')}
              {tabBtn('whole_scene', 'graphic_eq', 'Whole scene')}
              {tabBtn('import', 'upload_file', 'Import')}
            </div>

            {scene.audioMode === 'per_line' && (
              <div className="space-y-1.5">
                <p className="text-[10px] text-on-surface-variant/80">
                  Each line is voiced on its own. Timing is exact and you can redo single lines.
                </p>
                <label className="flex items-center gap-2 text-on-surface-variant">
                  Pause between lines
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={scene.gapSec}
                    onChange={(e) => update({ gapSec: Number(e.target.value) })}
                    onMouseUp={() => scene.lines.some((l) => l.audioUrl) && respacePerLine(sceneRef.current.gapSec)}
                    onTouchEnd={() => scene.lines.some((l) => l.audioUrl) && respacePerLine(sceneRef.current.gapSec)}
                    className="flex-1 accent-cyan-400"
                  />
                  <span className="w-9 text-right font-mono">{scene.gapSec.toFixed(2)}s</span>
                </label>
                <button
                  disabled={!!busy || !hasKey}
                  onClick={() => generatePerLine()}
                  className="w-full py-2 rounded-xl bg-primary text-background font-bold disabled:opacity-40 cursor-pointer flex items-center justify-center gap-1"
                >
                  <span className="material-symbols-outlined text-[16px]">graphic_eq</span>
                  {scene.lines.every((l) => l.audioUrl)
                    ? 'Regenerate all voices'
                    : scene.lines.some((l) => l.audioUrl)
                    ? 'Generate missing voices'
                    : 'Generate voices'}
                </button>
              </div>
            )}

            {scene.audioMode === 'whole_scene' && (
              <div className="space-y-1.5">
                <p className="text-[10px] text-on-surface-variant/80">
                  The whole scene is performed in one go for the most natural flow, then each line is found in
                  the audio. Check the times below and adjust any that are off.
                </p>
                <button
                  disabled={!!busy || !hasKey || scene.cast.length > 2}
                  onClick={generateWholeScene}
                  className="w-full py-2 rounded-xl bg-primary text-background font-bold disabled:opacity-40 cursor-pointer flex items-center justify-center gap-1"
                >
                  <span className="material-symbols-outlined text-[16px]">graphic_eq</span>
                  Generate whole scene
                </button>
                {scene.cast.length > 2 && (
                  <p className="text-[10px] text-amber-300">Gemini supports two speakers per scene. Use “Per line”.</p>
                )}
              </div>
            )}

            {scene.audioMode === 'import' && (
              <div className="space-y-1.5">
                <p className="text-[10px] text-on-surface-variant/80">
                  Import a WAV of the scene (for example made in AI Studio). The lines must match the script above,
                  in order.
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".wav,audio/wav"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importAudio(f);
                    e.target.value = '';
                  }}
                />
                <button
                  disabled={!!busy}
                  onClick={() => fileRef.current?.click()}
                  className="w-full py-2 rounded-xl bg-primary text-background font-bold disabled:opacity-40 cursor-pointer flex items-center justify-center gap-1"
                >
                  <span className="material-symbols-outlined text-[16px]">upload_file</span>
                  Import WAV & match lines
                </button>
              </div>
            )}

            {hasAnyVoice && (
              <button
                disabled={!!busy}
                onClick={deleteAllVoices}
                className="w-full py-1.5 rounded-xl border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-40 cursor-pointer flex items-center justify-center gap-1"
              >
                <span className="material-symbols-outlined text-[15px]">delete</span>
                Delete all voices
              </button>
            )}

            {busy && (
              <div className="flex items-center gap-2 text-primary text-[11px]">
                <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
                {busy}
              </div>
            )}
            {error && <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-1.5">{error}</div>}
          </section>
        )}

        {/* 4. Lines & timing */}
        {scene.lines.length > 0 && (
          <section className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-label-caps tracking-wider text-on-surface-variant">4 · LINES</span>
              {scene.duration ? (
                <span className="text-[10px] font-mono text-on-surface-variant/70">{scene.duration.toFixed(1)}s scene</span>
              ) : null}
            </div>
            <div className="space-y-1">
              {scene.lines.map((l, i) => {
                const actor = characters.find((a) => a.id === scene.cast.find((c) => c.speaker === l.speaker)?.actorId);
                const hasTime = l.end > l.start;
                return (
                  <div
                    key={l.id}
                    className={`rounded-lg border p-1.5 space-y-1 ${
                      activeLineId === l.id ? 'border-primary bg-primary/10' : 'border-outline-variant/25 bg-background/40'
                    }`}
                  >
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] font-mono text-on-surface-variant/60 w-4">{i + 1}</span>
                      <span className="font-bold text-[11px]" style={{ color: actor?.color || undefined }}>
                        {l.speaker}
                      </span>
                      <span className="flex-1" />
                      {scene.audioMode === 'per_line' && hasKey && (
                        <button
                          disabled={!!busy || !l.audioUrl}
                          onClick={() => generatePerLine(l.id)}
                          title="Regenerate this line's voice"
                          className="text-on-surface-variant hover:text-primary disabled:opacity-30 cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[15px]">refresh</span>
                        </button>
                      )}
                      {scene.audioMode === 'per_line' && l.audioUrl && (
                        <button
                          disabled={!!busy}
                          onClick={() => deleteLineVoice(l.id)}
                          title="Delete this line's voice"
                          className="text-on-surface-variant hover:text-red-400 disabled:opacity-30 cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[15px]">delete</span>
                        </button>
                      )}
                      {scene.audioMode === 'per_line' && !l.audioUrl && scene.lines.some((x) => x.audioUrl) && (
                        <span className="text-[9px] text-amber-300/80" title="This line has no voice yet">
                          no voice
                        </span>
                      )}
                      {hasTime && (
                        <button
                          onClick={() => onSeek(l.start)}
                          title="Jump to this line"
                          className="text-on-surface-variant hover:text-primary cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[15px]">my_location</span>
                        </button>
                      )}
                    </div>
                    <div className="text-[11px] text-on-surface/85 leading-snug">{spokenText(l.text)}</div>
                    {hasTime && scene.audioMode !== 'per_line' && (
                      <div className="flex items-center gap-1 text-[10px] font-mono text-on-surface-variant">
                        <input
                          type="number"
                          step={0.05}
                          value={fmt(l.start)}
                          onChange={(e) => nudgeLine(l.id, 'start', Number(e.target.value))}
                          className="w-16 bg-background/60 border border-outline-variant/30 rounded px-1"
                        />
                        →
                        <input
                          type="number"
                          step={0.05}
                          value={fmt(l.end)}
                          onChange={(e) => nudgeLine(l.id, 'end', Number(e.target.value))}
                          className="w-16 bg-background/60 border border-outline-variant/30 rounded px-1"
                        />
                        <button
                          onClick={() => nudgeLine(l.id, 'start', timelineSec)}
                          title="Set start to playhead"
                          className="px-1 rounded border border-outline-variant/30 hover:text-primary cursor-pointer"
                        >
                          ⇤ here
                        </button>
                        <button
                          onClick={() => nudgeLine(l.id, 'end', timelineSec)}
                          title="Set end to playhead"
                          className="px-1 rounded border border-outline-variant/30 hover:text-primary cursor-pointer"
                        >
                          here ⇥
                        </button>
                      </div>
                    )}
                    {hasTime && scene.audioMode === 'per_line' && (
                      <div className="text-[10px] font-mono text-on-surface-variant/70">
                        {fmt(l.start)}s → {fmt(l.end)}s
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* 5. Acting */}
        {timed && scene.audioUrl && (
          <section className="space-y-1.5">
            <span className="font-label-caps tracking-wider text-on-surface-variant">5 · ACTING</span>
            <p className="text-[10px] text-on-surface-variant/80">
              Each actor gets talking beats from the [emotion] tags while speaking, and reactions while listening.
            </p>
            {!castReady && <p className="text-[10px] text-amber-300">Pick an actor for every speaker in Cast.</p>}
            <div className="flex gap-1">
              <button
                disabled={!castReady || !!busy || isGeneratingMotion}
                onClick={() => onApplyToActors(sceneRef.current)}
                className="flex-1 py-2 rounded-xl border border-primary/60 text-primary font-bold disabled:opacity-40 cursor-pointer"
              >
                Fill actor timelines
              </button>
              <button
                disabled={!castReady || !!busy || isGeneratingMotion}
                onClick={() => onGenerateMotion(sceneRef.current)}
                className="flex-1 py-2 rounded-xl bg-primary text-background font-bold disabled:opacity-40 cursor-pointer flex items-center justify-center gap-1"
              >
                <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
                {isGeneratingMotion ? 'Generating…' : 'Generate motion'}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
