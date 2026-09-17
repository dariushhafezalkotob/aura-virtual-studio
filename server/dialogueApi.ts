/**
 * Dev-server endpoints for the dialogue previs pipeline.
 *
 *   POST /api/dialogue/tts        one line, one voice             -> { url, duration }
 *   POST /api/dialogue/tts-scene  whole scene, two voices          -> { url, duration }
 *   POST /api/dialogue/assemble   per-line clips placed on a track -> { url, duration }
 *   POST /api/dialogue/align      script lines vs a scene recording -> { lines: [{start,end}], duration }
 *   POST /api/dialogue/delete-audio  removes dialogue audio files      -> { deleted }
 */
import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  DecodedAudio,
  alignLinesToRegions,
  decodePcm16,
  decodeWav,
  detectSpeechRegions,
  encodeWav16,
  mixClips,
  regionVoiceFeatures,
  spokenWordCount,
  trimSilence,
} from './dialogueAudio';

const ASSETS_DIR = () => path.join(process.cwd(), 'data', 'assets');
const DEFAULT_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function assetPathFromUrl(url: string): string {
  const name = path.basename(decodeURIComponent(url.replace(/^\/api\/assets\//, '').split('?')[0]));
  const p = path.join(ASSETS_DIR(), name);
  if (!fs.existsSync(p)) throw new Error(`Audio file not found: ${name}`);
  return p;
}

function saveWav(audio: DecodedAudio, prefix: string): { url: string; duration: number } {
  fs.mkdirSync(ASSETS_DIR(), { recursive: true });
  const name = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.wav`;
  fs.writeFileSync(path.join(ASSETS_DIR(), name), encodeWav16(audio));
  return { url: `/api/assets/${name}`, duration: audio.samples.length / audio.sampleRate };
}

/** Finds the first audio payload anywhere in a Gemini response (generateContent or Interactions shape). */
function findAudio(node: any): { data: string; mime: string; rate?: number } | null {
  if (!node || typeof node !== 'object') return null;
  const inline = node.inlineData || node.inline_data;
  if (inline?.data && /audio/i.test(inline.mimeType || inline.mime_type || '')) {
    return { data: inline.data, mime: inline.mimeType || inline.mime_type };
  }
  if (node.type === 'audio' && typeof node.data === 'string') {
    return { data: node.data, mime: node.mime_type || node.mimeType || 'audio/pcm', rate: node.sample_rate };
  }
  for (const v of Object.values(node)) {
    const found = findAudio(v);
    if (found) return found;
  }
  return null;
}

function decodeGeminiAudio(found: { data: string; mime: string; rate?: number }): DecodedAudio {
  const bytes = Buffer.from(found.data, 'base64');
  if (bytes.toString('ascii', 0, 4) === 'RIFF') return decodeWav(bytes);
  if (/wav/i.test(found.mime)) return decodeWav(bytes);
  if (/L16|pcm/i.test(found.mime) || !found.mime) {
    const rate = Number(/rate=(\d+)/i.exec(found.mime)?.[1]) || found.rate || 24000;
    return decodePcm16(bytes, rate);
  }
  throw new Error(`Gemini returned audio as ${found.mime}, which the studio cannot decode yet.`);
}

type SpeakerVoice = { speaker: string; voice: string };

/**
 * Calls Gemini TTS. Tries the generateContent API first, then the newer Interactions API, so it
 * keeps working whichever one the preview model is served on.
 */
async function geminiTts(apiKey: string, model: string, text: string, voices: SpeakerVoice[]): Promise<DecodedAudio> {
  if (!apiKey) throw new Error('Add your Gemini API key first.');
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
  const errors: string[] = [];

  const voiceConfig = (voice: string) => ({ prebuiltVoiceConfig: { voiceName: voice } });
  const speechConfig =
    voices.length > 1
      ? {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: voices.map((v) => ({ speaker: v.speaker, voiceConfig: voiceConfig(v.voice) })),
          },
        }
      : { voiceConfig: voiceConfig(voices[0].voice) };

  const attempts: { label: string; url: string; body: unknown }[] = [
    {
      label: 'generateContent',
      url: `${GEMINI_BASE}/models/${model}:generateContent`,
      body: {
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig },
      },
    },
    {
      label: 'interactions',
      url: `${GEMINI_BASE}/interactions`,
      body: {
        model,
        input: text,
        response_format: { type: 'audio' },
        generation_config: {
          speech_config: voices.length > 1 ? voices.map((v) => ({ speaker: v.speaker, voice: v.voice })) : [{ voice: voices[0].voice }],
        },
      },
    },
  ];

  for (const a of attempts) {
    try {
      const resp = await fetch(a.url, { method: 'POST', headers, body: JSON.stringify(a.body) });
      const raw = await resp.text();
      if (!resp.ok) {
        errors.push(`${a.label}: ${resp.status} ${raw.slice(0, 300)}`);
        // A bad key or quota will fail the same way on the other API; don't hide the real message.
        if (resp.status === 400 && /API key/i.test(raw)) break;
        if (resp.status === 401 || resp.status === 403 || resp.status === 429) break;
        continue;
      }
      const found = findAudio(JSON.parse(raw));
      if (!found) {
        errors.push(`${a.label}: response had no audio`);
        continue;
      }
      return decodeGeminiAudio(found);
    } catch (e: any) {
      errors.push(`${a.label}: ${e.message}`);
    }
  }
  console.warn('[API /api/dialogue] Gemini TTS failed:', errors.join(' | '));
  throw new Error(`Gemini voice generation failed. ${errors[0] || ''}`.trim());
}

/** Returns true when the request was handled. */
export async function handleDialogueApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url || '';
  if (!url.startsWith('/api/dialogue/') || req.method !== 'POST') return false;

  try {
    const body = await readJson(req);
    const apiKey = body.apiKey || (req.headers['x-gemini-key'] as string) || process.env.GEMINI_API_KEY || '';
    const model = body.model || DEFAULT_TTS_MODEL;

    if (url.startsWith('/api/dialogue/delete-audio')) {
      // Only files this pipeline created (dialogue_*); never other assets, even if a URL points at one.
      let deleted = 0;
      for (const u of (body.urls || []) as string[]) {
        const name = path.basename(decodeURIComponent(String(u).replace(/^\/api\/assets\//, '').split('?')[0]));
        if (!/^dialogue_[\w.-]+\.wav$/i.test(name)) continue;
        const p = path.join(ASSETS_DIR(), name);
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          deleted++;
        }
      }
      sendJson(res, 200, { deleted });
      return true;
    }

    if (url.startsWith('/api/dialogue/tts-scene')) {
      const lines: { speaker: string; text: string }[] = body.lines || [];
      const voices: SpeakerVoice[] = body.voices || [];
      if (lines.length === 0) throw new Error('The script has no lines.');
      if (voices.length < 1 || voices.length > 2) throw new Error('Whole-scene voices support one or two speakers.');
      const speakers = voices.map((v) => v.speaker).join(' and ');
      const text = `TTS the following conversation between ${speakers}:\n${lines.map((l) => `${l.speaker}: ${l.text}`).join('\n')}`;
      console.log(`[API /api/dialogue/tts-scene] ${lines.length} lines, voices ${voices.map((v) => `${v.speaker}=${v.voice}`).join(', ')}`);
      const audio = await geminiTts(apiKey, model, text, voices);
      sendJson(res, 200, saveWav(audio, 'dialogue_scene'));
      return true;
    }

    if (url.startsWith('/api/dialogue/tts')) {
      const text = String(body.text || '').trim();
      if (!text) throw new Error('This line is empty.');
      const audio = trimSilence(await geminiTts(apiKey, model, text, [{ speaker: 'Speaker', voice: body.voice || 'Kore' }]));
      sendJson(res, 200, saveWav(audio, 'dialogue_line'));
      return true;
    }

    if (url.startsWith('/api/dialogue/assemble')) {
      const clips: { url: string; start: number }[] = body.clips || [];
      if (clips.length === 0) throw new Error('No voice clips to assemble.');
      const decoded = clips.map((c) => ({ audio: decodeWav(fs.readFileSync(assetPathFromUrl(c.url))), start: c.start }));
      const mixed = mixClips(decoded, decoded[0].audio.sampleRate, Number(body.minDuration) || 0);
      sendJson(res, 200, saveWav(mixed, 'dialogue_track'));
      return true;
    }

    if (url.startsWith('/api/dialogue/align')) {
      const lines: { text: string; speaker?: string }[] = body.lines || [];
      const audio = decodeWav(fs.readFileSync(assetPathFromUrl(String(body.audioUrl || ''))));
      const duration = audio.samples.length / audio.sampleRate;
      const words = lines.map((l) => spokenWordCount(l.text));

      // Split on even short pauses: the aligner regroups fragments into lines, but cannot split a
      // region that already swallowed a line boundary. If there are still fewer regions than lines
      // (lines spoken back to back), retry more sensitively before giving up.
      let aligned = null;
      for (const opts of [
        { mergeGapSec: 0.08, rangeDb: 32 },
        { mergeGapSec: 0.05, rangeDb: 26 },
        { mergeGapSec: 0.03, rangeDb: 20 },
      ]) {
        const regions = detectSpeechRegions(audio, opts);
        aligned = alignLinesToRegions(words, regions, {
          lineSpeakers: lines.map((l) => l.speaker || ''),
          regionFeatures: regionVoiceFeatures(audio, regions),
        });
        if (aligned) break;
      }
      if (!aligned) {
        throw new Error(
          `Could not find ${lines.length} separate lines in this audio. Make sure the script matches the recording, with a short pause between lines.`
        );
      }
      sendJson(res, 200, { lines: aligned, duration });
      return true;
    }

    return false;
  } catch (err: any) {
    console.error(`[API ${url}]`, err.message);
    sendJson(res, 500, { error: err.message || 'Dialogue request failed.' });
    return true;
  }
}
