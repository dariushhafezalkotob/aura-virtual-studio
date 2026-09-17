/**
 * WAV decoding/encoding and dialogue timing helpers for the dialogue previs pipeline.
 *
 * Runs in the Vite dev server (Node). Everything works on mono Float32 samples.
 */

export interface DecodedAudio {
  sampleRate: number;
  samples: Float32Array; // mono, -1..1
}

/** Parses a RIFF/WAVE file: PCM 8/16/24/32-bit, IEEE float, and WAVE_FORMAT_EXTENSIBLE. Downmixes to mono. */
export function decodeWav(buf: Buffer): DecodedAudio {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Audio must be a WAV file.');
  }
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE: the real format code is the first 2 bytes of the SubFormat GUID.
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
      break;
    }
    offset = body + size + (size & 1);
  }
  if (!data || !channels || !sampleRate) throw new Error('WAV file has no audio data.');

  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = (f * channels + c) * bytes;
      let v: number;
      if (format === 3) v = bits === 64 ? data.readDoubleLE(p) : data.readFloatLE(p);
      else if (bits === 16) v = data.readInt16LE(p) / 32768;
      else if (bits === 24) v = data.readIntLE(p, 3) / 8388608;
      else if (bits === 32) v = data.readInt32LE(p) / 2147483648;
      else if (bits === 8) v = (data[p] - 128) / 128;
      else throw new Error(`Unsupported WAV bit depth: ${bits}`);
      sum += v;
    }
    out[f] = sum / channels;
  }
  return { sampleRate, samples: out };
}

/** Wraps raw 16-bit little-endian mono PCM (what Gemini TTS returns) as decoded audio. */
export function decodePcm16(buf: Buffer, sampleRate: number): DecodedAudio {
  const frames = Math.floor(buf.length / 2);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return { sampleRate, samples: out };
}

export function encodeWav16(audio: DecodedAudio): Buffer {
  const n = audio.samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(audio.sampleRate, 24);
  buf.writeUInt32LE(audio.sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, audio.samples[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2);
  }
  return buf;
}

function resample(audio: DecodedAudio, rate: number): Float32Array {
  if (audio.sampleRate === rate) return audio.samples;
  const ratio = audio.sampleRate / rate;
  const n = Math.floor(audio.samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(audio.samples.length - 1, i0 + 1);
    out[i] = audio.samples[i0] + (audio.samples[i1] - audio.samples[i0]) * (x - i0);
  }
  return out;
}

/** Places clips on a silent track at their start times (seconds). Overlaps are summed. */
export function mixClips(clips: { audio: DecodedAudio; start: number }[], sampleRate: number, minDuration = 0): DecodedAudio {
  const prepared = clips.map((c) => ({ start: Math.max(0, c.start), samples: resample(c.audio, sampleRate) }));
  const end = prepared.reduce((m, c) => Math.max(m, Math.round(c.start * sampleRate) + c.samples.length), 0);
  const out = new Float32Array(Math.max(end, Math.round(minDuration * sampleRate)));
  for (const c of prepared) {
    const s0 = Math.round(c.start * sampleRate);
    for (let i = 0; i < c.samples.length && s0 + i < out.length; i++) out[s0 + i] += c.samples[i];
  }
  return { sampleRate, samples: out };
}

/** Trims leading/trailing near-silence so per-line clips butt up against the gaps we choose. */
export function trimSilence(audio: DecodedAudio, padSec = 0.05): DecodedAudio {
  const regions = detectSpeechRegions(audio, { mergeGapSec: 1e9, minRegionSec: 0 });
  if (regions.length === 0) return audio;
  const sr = audio.sampleRate;
  const a = Math.max(0, Math.floor((regions[0].start - padSec) * sr));
  const b = Math.min(audio.samples.length, Math.ceil((regions[regions.length - 1].end + padSec) * sr));
  return { sampleRate: sr, samples: audio.samples.slice(a, b) };
}

export interface Region {
  start: number;
  end: number;
}

/**
 * Alignment weights, tuned on a synthetic two-voice scene with 0.2-0.8s pauses between lines.
 * Stronger pause or voice weights made single lines jump by many seconds; these keep every boundary
 * exact except occasionally one short line opener (e.g. "Mark... man,") landing ~1s off.
 */
const SPLIT_W = 1;
const VOICE_W = 1;

/**
 * Finds stretches of speech separated by pauses, from 20ms loudness frames.
 * The threshold is relative to the loud end of the file, so it adapts to recording level.
 */
export function detectSpeechRegions(
  audio: DecodedAudio,
  opts: { mergeGapSec?: number; minRegionSec?: number; rangeDb?: number } = {}
): Region[] {
  const { mergeGapSec = 0.25, minRegionSec = 0.15, rangeDb = 32 } = opts;
  const hop = Math.max(1, Math.round(audio.sampleRate * 0.02));
  const frames = Math.floor(audio.samples.length / hop);
  if (frames === 0) return [];
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) s += audio.samples[i] * audio.samples[i];
    db[f] = 20 * Math.log10(Math.sqrt(s / hop) + 1e-9);
  }
  const sorted = Array.from(db).sort((x, y) => x - y);
  const threshold = Math.max(-60, sorted[Math.floor(sorted.length * 0.95)] - rangeDb);

  const raw: Region[] = [];
  let startF = -1;
  for (let f = 0; f <= frames; f++) {
    const on = f < frames && db[f] > threshold;
    if (on && startF < 0) startF = f;
    if (!on && startF >= 0) {
      raw.push({ start: startF * 0.02, end: f * 0.02 });
      startF = -1;
    }
  }
  const merged: Region[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < mergeGapSec) last.end = r.end;
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.end - r.start >= minRegionSec);
}

/** Words in a line with the [emotion] tags removed. */
export function spokenWordCount(text: string): number {
  return text.replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * Matches script lines, in order, to speech regions found in a whole-scene recording.
 *
 * A line may contain its own pauses, so each line takes one or more consecutive regions. The split
 * is chosen by dynamic programming so every line's length is as close as possible to what its word
 * count predicts, and splits land on the longest pauses. Needs no speech recognition: the script
 * already gives the order and the words.
 */
export function alignLinesToRegions(
  lineWordCounts: number[],
  regions: Region[],
  voice?: { lineSpeakers: string[]; regionFeatures: number[][] }
): Region[] | null {
  const lengthOnly = alignPass(lineWordCounts, regions, null);
  const speakers = voice ? [...new Set(voice.lineSpeakers)] : [];
  if (!lengthOnly || !voice || speakers.length !== 2) return lengthOnly?.regions ?? null;

  const durations = regions.map((r) => r.end - r.start);
  const lineSpeakerOf = (line: number) => voice.lineSpeakers[line];

  // Group the fragments into two voices without looking at the script, then try both ways of
  // naming the groups. Starting from word-count timing instead gets stuck whenever that first
  // guess puts a boundary in the wrong place.
  const clusters = twoMeans(voice.regionFeatures, durations);
  const candidates: { regions: Region[]; assignment: number[]; cost: number }[] = [];
  if (clusters) {
    for (const naming of [speakers, [speakers[1], speakers[0]]]) {
      const labels = clusters.map((c) => (c < 0 ? null : naming[c]));
      const model = speakerModel(voice.regionFeatures, durations, labels);
      if (!model) continue;
      const pass = alignPass(lineWordCounts, regions, (line, region) => model(lineSpeakerOf(line), region));
      if (pass) candidates.push(pass);
    }
  }
  const lengthModel = speakerModel(
    voice.regionFeatures,
    durations,
    lengthOnly.assignment.map((line) => lineSpeakerOf(line))
  );
  if (lengthModel) {
    const pass = alignPass(lineWordCounts, regions, (line, region) => lengthModel(lineSpeakerOf(line), region));
    if (pass) candidates.push(pass);
  }
  if (candidates.length === 0) return lengthOnly.regions;
  let best = candidates.reduce((a, b) => (b.cost < a.cost ? b : a));

  // Refine: re-learn each voice (sound and speaking pace) from the chosen alignment and re-align
  // until it settles.
  for (let iter = 0; iter < 6; iter++) {
    const model = speakerModel(
      voice.regionFeatures,
      durations,
      best.assignment.map((line) => lineSpeakerOf(line))
    );
    if (!model) break;
    const pace = speakerPace(best.assignment, durations, lineWordCounts, voice.lineSpeakers);
    const next = alignPass(
      lineWordCounts,
      regions,
      (line, region) => model(lineSpeakerOf(line), region),
      voice.lineSpeakers.map((sp) => pace.get(sp)!)
    );
    if (!next || next.assignment.every((a, i) => a === best.assignment[i])) break;
    best = next;
  }
  return best.regions;
}

/** Seconds of speech per word for each speaker under an alignment. */
function speakerPace(assignment: number[], durations: number[], words: number[], lineSpeakers: string[]): Map<string, number> {
  const speech = new Map<string, number>();
  const wordTotals = new Map<string, number>();
  assignment.forEach((line, region) => {
    const sp = lineSpeakers[line];
    speech.set(sp, (speech.get(sp) || 0) + durations[region]);
  });
  words.forEach((w, line) => {
    const sp = lineSpeakers[line];
    wordTotals.set(sp, (wordTotals.get(sp) || 0) + Math.max(1, w));
  });
  const pace = new Map<string, number>();
  for (const sp of new Set(lineSpeakers)) pace.set(sp, (speech.get(sp) || 0) / Math.max(1, wordTotals.get(sp) || 1));
  return pace;
}

/** Duration-weighted 2-means on region features. Returns cluster 0/1 per region, -1 if unusable. */
function twoMeans(features: number[][], weights: number[]): number[] | null {
  const valid = features.map((f) => f.every(Number.isFinite));
  const idx = features.map((_, i) => i).filter((i) => valid[i]);
  if (idx.length < 2) return null;
  const dist = (a: number[], b: number[]) => a.reduce((s, v, d) => s + (v - b[d]) ** 2, 0);
  // Seed with the longest fragment and the fragment most unlike it.
  const first = idx.reduce((a, b) => (weights[b] > weights[a] ? b : a));
  const second = idx.reduce((a, b) => (dist(features[b], features[first]) > dist(features[a], features[first]) ? b : a));
  let centers = [features[first].slice(), features[second].slice()];
  let labels = new Array(features.length).fill(-1);
  for (let iter = 0; iter < 20; iter++) {
    const next = features.map((f, i) => (valid[i] ? (dist(f, centers[0]) <= dist(f, centers[1]) ? 0 : 1) : -1));
    const same = next.every((l, i) => l === labels[i]);
    labels = next;
    centers = [0, 1].map((c) => {
      const members = idx.filter((i) => labels[i] === c);
      if (members.length === 0) return centers[c];
      const w = members.reduce((s, i) => s + weights[i], 0);
      return centers[c].map((_, d) => members.reduce((s, i) => s + features[i][d] * weights[i], 0) / w);
    });
    if (same) break;
  }
  return labels;
}

/**
 * Per-region voice fingerprint: the average shape of the spectrum on a mel scale (log band energies,
 * loudness removed). Two voices differ in timbre far more reliably than in pitch, which overlaps a lot
 * between similar voices.
 */
export function regionVoiceFeatures(audio: DecodedAudio, regions: Region[]): number[][] {
  // Average-pool down to ~16 kHz (a crude but alias-safe low-pass), then 32ms frames.
  const step = Math.max(1, Math.round(audio.sampleRate / 16000));
  const sr = audio.sampleRate / step;
  const N = 512;
  const BANDS = 24;
  const window = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
  const edges: number[] = [];
  const mLo = mel(80);
  const mHi = mel(Math.min(7600, sr / 2 - 1));
  for (let b = 0; b <= BANDS + 1; b++) {
    const m = mLo + ((mHi - mLo) * b) / (BANDS + 1);
    edges.push(Math.min(N / 2 - 1, Math.round(((700 * (10 ** (m / 2595) - 1)) / sr) * N)));
  }
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  return regions.map((r) => {
    const a = Math.floor(r.start * audio.sampleRate);
    const b = Math.min(audio.samples.length, Math.floor(r.end * audio.sampleRate));
    const x: number[] = [];
    for (let i = a; i + step <= b; i += step) {
      let v = 0;
      for (let j = 0; j < step; j++) v += audio.samples[i + j];
      x.push(v / step);
    }
    const acc = new Array(BANDS).fill(0);
    let frames = 0;
    for (let f = 0; f + N <= x.length; f += N / 2) {
      let energy = 0;
      for (let i = 0; i < N; i++) {
        re[i] = x[f + i] * window[i];
        im[i] = 0;
        energy += re[i] * re[i];
      }
      if (energy < 1e-5) continue; // skip silence inside the region
      fft(re, im);
      const bands = new Array(BANDS).fill(0);
      for (let k = 0; k < BANDS; k++) {
        const lo = edges[k];
        const mid = edges[k + 1];
        const hi = edges[k + 2];
        let e = 0;
        for (let bin = lo; bin <= hi; bin++) {
          const w = bin <= mid ? (bin - lo) / Math.max(1, mid - lo) : (hi - bin) / Math.max(1, hi - mid);
          e += Math.max(0, w) * (re[bin] * re[bin] + im[bin] * im[bin]);
        }
        bands[k] = Math.log(e + 1e-10);
      }
      const mean = bands.reduce((p, q) => p + q, 0) / BANDS;
      for (let k = 0; k < BANDS; k++) acc[k] += bands[k] - mean;
      frames++;
    }
    return frames ? acc.map((v) => v / frames) : new Array(BANDS).fill(NaN);
  });
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Per-speaker voice model from a labelling of regions; returns a cost for a region under a speaker.
 * Spread is measured within each speaker (not across everyone), so the gap between two similar
 * voices still counts as large. Cost scales with region length: a half-second fragment with an odd
 * reading should not outvote seconds of clear speech.
 */
function speakerModel(
  features: number[][],
  durations: number[],
  labels: (string | null)[]
): ((speaker: string, region: number) => number) | null {
  const dims = features[0]?.length || 0;
  const groups = new Map<string, number[]>();
  labels.forEach((sp, i) => {
    if (sp === null || !features[i].every(Number.isFinite)) return;
    if (!groups.has(sp)) groups.set(sp, []);
    groups.get(sp)!.push(i);
  });
  if (groups.size < 2 || dims === 0) return null;
  const means = new Map<string, number[]>();
  const spreadSum = new Array(dims).fill(0);
  let spreadW = 0;
  for (const [sp, members] of groups) {
    const w = members.reduce((s, i) => s + durations[i], 0);
    const m = new Array(dims).fill(0).map((_, d) => members.reduce((s, i) => s + features[i][d] * durations[i], 0) / w);
    means.set(sp, m);
    for (const i of members) {
      for (let d = 0; d < dims; d++) spreadSum[d] += (features[i][d] - m[d]) ** 2 * durations[i];
      spreadW += durations[i];
    }
  }
  const spread = spreadSum.map((v) => Math.max(0.05, Math.sqrt(v / Math.max(1e-6, spreadW))));
  return (speaker, region) => {
    const m = means.get(speaker);
    const f = features[region];
    if (!m || !f.every(Number.isFinite)) return 0;
    let c = 0;
    for (let d = 0; d < dims; d++) c += Math.min(9, ((f[d] - m[d]) / spread[d]) ** 2);
    return VOICE_W * (c / dims) * durations[region];
  };
}

function alignPass(
  lineWordCounts: number[],
  regions: Region[],
  regionCost: ((line: number, region: number) => number) | null,
  /** Seconds per word for each line; defaults to the scene average. Voices speak at different speeds. */
  lineSecPerWord?: number[]
): { regions: Region[]; assignment: number[]; cost: number } | null {
  const L = lineWordCounts.length;
  const R = regions.length;
  if (L === 0) return { regions: [], assignment: [], cost: 0 };
  if (R < L) return null;

  const totalWords = lineWordCounts.reduce((a, b) => a + Math.max(1, b), 0);
  const totalSpeech = regions.reduce((a, r) => a + (r.end - r.start), 0);
  const secPerWord = totalSpeech / totalWords;

  // Pauses between regions: splitting on a long pause is cheap, on a short one expensive.
  const gaps = regions.slice(1).map((r, i) => r.start - regions[i].end);
  const maxGap = Math.max(1e-3, ...gaps);
  const speechPrefix = [0];
  for (const reg of regions) speechPrefix.push(speechPrefix[speechPrefix.length - 1] + (reg.end - reg.start));

  const INF = Number.POSITIVE_INFINITY;
  // cost[l][r]: best cost for the first l lines using the first r regions.
  const cost = Array.from({ length: L + 1 }, () => new Array<number>(R + 1).fill(INF));
  const back = Array.from({ length: L + 1 }, () => new Array<number>(R + 1).fill(-1));
  cost[0][0] = 0;

  for (let l = 1; l <= L; l++) {
    const expected = Math.max(1, lineWordCounts[l - 1]) * (lineSecPerWord?.[l - 1] ?? secPerWord);
    const voicePrefix = [0];
    for (let i = 0; i < R; i++) voicePrefix.push(voicePrefix[i] + (regionCost ? regionCost(l - 1, i) : 0));
    for (let r = l; r <= R - (L - l); r++) {
      for (let k = l - 1; k < r; k++) {
        if (cost[l - 1][k] === INF) continue;
        // Line l covers regions k..r-1. Speech time excludes its internal pauses.
        const speech = speechPrefix[r] - speechPrefix[k];
        const lengthCost = Math.log(speech / expected) ** 2;
        const splitCost = k > 0 ? SPLIT_W * (1 - gaps[k - 1] / maxGap) : 0;
        const c = cost[l - 1][k] + lengthCost + splitCost + (voicePrefix[r] - voicePrefix[k]);
        if (c < cost[l][r]) {
          cost[l][r] = c;
          back[l][r] = k;
        }
      }
    }
  }
  if (cost[L][R] === INF) return null;

  const out: Region[] = new Array(L);
  const assignment = new Array<number>(R);
  let r = R;
  for (let l = L; l >= 1; l--) {
    const k = back[l][r];
    out[l - 1] = { start: regions[k].start, end: regions[r - 1].end };
    for (let i = k; i < r; i++) assignment[i] = l - 1;
    r = k;
  }
  return { regions: out, assignment, cost: cost[L][R] };
}
