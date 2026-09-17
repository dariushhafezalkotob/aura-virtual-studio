import { useEffect, useRef } from 'react';
import { DEFAULT_TTS_MODEL } from './dialogueScript';

/** Same key the Scene Design screen stores, so users enter it once. */
export const GEMINI_KEY_STORAGE = 'gemini_api_key';

export function getGeminiKey(): string {
  try {
    return localStorage.getItem(GEMINI_KEY_STORAGE) || localStorage.getItem('roombake_gemini_key') || '';
  } catch {
    return '';
  }
}

export function setGeminiKey(key: string) {
  try {
    if (key) localStorage.setItem(GEMINI_KEY_STORAGE, key);
    else localStorage.removeItem(GEMINI_KEY_STORAGE);
  } catch {
    /* storage unavailable */
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data as T;
}

export const DialogueService = {
  generateLineVoice(text: string, voice: string, model = DEFAULT_TTS_MODEL) {
    return post<{ url: string; duration: number }>('/api/dialogue/tts', { apiKey: getGeminiKey(), model, text, voice });
  },

  generateSceneVoices(lines: { speaker: string; text: string }[], voices: { speaker: string; voice: string }[], model = DEFAULT_TTS_MODEL) {
    return post<{ url: string; duration: number }>('/api/dialogue/tts-scene', { apiKey: getGeminiKey(), model, lines, voices });
  },

  assembleTrack(clips: { url: string; start: number }[], minDuration: number) {
    return post<{ url: string; duration: number }>('/api/dialogue/assemble', { clips, minDuration });
  },

  alignLines(audioUrl: string, lines: { speaker: string; text: string }[]) {
    return post<{ lines: { start: number; end: number }[]; duration: number }>('/api/dialogue/align', { audioUrl, lines });
  },

  /** Removes dialogue audio files from the project's assets. Other assets are never touched. */
  deleteAudio(urls: (string | undefined)[]) {
    const list = urls.filter((u): u is string => !!u);
    if (list.length === 0) return Promise.resolve({ deleted: 0 });
    return post<{ deleted: number }>('/api/dialogue/delete-audio', { urls: list });
  },

  async uploadAudio(file: File): Promise<string> {
    const safe = file.name.replace(/[^\w.-]+/g, '_');
    const resp = await fetch(`/api/upload-asset?filename=dialogue_import_${Date.now()}_${safe}`, { method: 'POST', body: file });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.url) throw new Error(data.error || 'Upload failed.');
    return data.url;
  },
};

/**
 * Plays the dialogue track in sync with the timeline clock. Uses Web Audio so seeking is exact:
 * the source restarts from the timeline position whenever playback starts, the speed changes, or
 * the playhead jumps (scrub, loop).
 */
export function useDialogueAudioSync(url: string | undefined, isPlaying: boolean, timelineSec: number, playbackSpeed: number) {
  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startedRef = useRef<{ ctxTime: number; offset: number; speed: number } | null>(null);

  const stop = () => {
    try {
      sourceRef.current?.stop();
    } catch {
      /* already stopped */
    }
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    startedRef.current = null;
  };

  // Load / reload the buffer.
  useEffect(() => {
    stop();
    bufferRef.current = null;
    if (!url) return;
    let cancelled = false;
    (async () => {
      try {
        if (!ctxRef.current) ctxRef.current = new AudioContext();
        const bytes = await (await fetch(url)).arrayBuffer();
        const buffer = await ctxRef.current.decodeAudioData(bytes);
        if (!cancelled) bufferRef.current = buffer;
      } catch (e) {
        console.warn('[Dialogue] Could not load dialogue audio:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => {
    const ctx = ctxRef.current;
    const buffer = bufferRef.current;
    if (!isPlaying || !ctx || !buffer) {
      if (!isPlaying) stop();
      return;
    }
    const started = startedRef.current;
    const expected = started ? started.offset + (ctx.currentTime - started.ctxTime) * started.speed : -1;
    const drift = Math.abs(expected - timelineSec);
    if (started && drift < 0.12 && started.speed === playbackSpeed) return;

    stop();
    if (timelineSec >= buffer.duration) return;
    // Browsers keep audio suspended until the user interacts with the page. Its clock is frozen
    // meanwhile, so starting now would look like constant drift and restart every frame.
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {});
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = playbackSpeed;
    src.connect(ctx.destination);
    src.start(0, Math.max(0, timelineSec));
    sourceRef.current = src;
    startedRef.current = { ctxTime: ctx.currentTime, offset: Math.max(0, timelineSec), speed: playbackSpeed };
  });

  // Unlock audio on the first interaction anywhere on the page.
  useEffect(() => {
    const unlock = () => {
      if (ctxRef.current && ctxRef.current.state !== 'running') ctxRef.current.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => () => {
    stop();
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

}
