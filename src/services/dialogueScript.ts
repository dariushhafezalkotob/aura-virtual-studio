import { DialogueLine, DialogueScene, MotionSegment } from '../types';

/** Gemini TTS prebuilt voices. */
export const GEMINI_VOICES = [
  'Charon', 'Puck', 'Kore', 'Fenrir', 'Orus', 'Aoede', 'Zephyr', 'Leda', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird',
  'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

export const DEFAULT_TTS_MODEL = 'gemini-3.1-flash-tts-preview';

/** Kimodo segments shorter than this are merged into a neighbour (matches the timeline's minimum). */
const MIN_SEGMENT_SEC = 0.5;

export interface ParsedLine {
  speaker: string;
  text: string;
}

/**
 * Parses a screenplay-style script. Accepts a speaker name on its own line followed by dialogue:
 *
 *   DAVID
 *   [suspicion] Are you going to ...
 *
 * or inline `DAVID: [suspicion] Are you ...`. Speaker names are upper-case; blank lines are ignored.
 */
export function parseScript(script: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let current: ParsedLine | null = null;
  const flush = () => {
    if (current && current.text.trim()) lines.push({ speaker: current.speaker, text: current.text.trim() });
    current = null;
  };
  // Screenplay extensions like (V.O.) or (CONT'D) are not part of the name.
  const cleanName = (name: string) => name.replace(/\([^)]*\)/g, '').replace(/\*+/g, '').trim().toUpperCase();
  for (const raw of script.replace(/\r/g, '').split('\n')) {
    const line = raw.trim().replace(/^["“”]+|["“”]+$/g, '');
    if (!line) continue;
    // "DAVID: text" or "David: text". Mixed-case names are limited to plain words so dialogue that
    // happens to contain a colon ("No. Time: 5pm.") is not mistaken for a speaker.
    const inline = /^\**([\p{L}][\p{L}\p{N}'_-]*(?: [\p{L}\p{N}'_-]+){0,2}(?: ?\([^)]*\))?)\**\s*:\s*(.+)$/u.exec(line);
    if (inline && !/^\[/.test(line)) {
      flush();
      current = { speaker: cleanName(inline[1]), text: inline[2].replace(/^\*+\s*/, '') };
      continue;
    }
    // A name alone on its line: all caps (optionally with an extension), short, or "David:" with nothing after.
    const alone =
      /^\**([\p{Lu}][\p{Lu}\p{N} .'_-]{0,30}(?:\([^)]*\))?)\**:?$/u.exec(line) ||
      /^\**([\p{L}][\p{L}\p{N}'_-]*(?: [\p{L}\p{N}'_-]+){0,2})\**:$/u.exec(line);
    if (alone && !/^\[/.test(line)) {
      flush();
      current = { speaker: cleanName(alone[1]), text: '' };
      continue;
    }
    if (current) current.text += (current.text ? ' ' : '') + line;
  }
  flush();
  return lines;
}

export function speakersOf(lines: { speaker: string }[]): string[] {
  return [...new Set(lines.map((l) => l.speaker))];
}

export interface Beat {
  tag: string | null;
  text: string;
  words: number;
}

/** Splits a line at its inline [tags]; each tag colours the words that follow it. */
export function lineBeats(text: string): Beat[] {
  const beats: Beat[] = [];
  const re = /\[([^\]]+)\]/g;
  let tag: string | null = null;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (chunk: string) => {
    const words = chunk.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    if (words > 0) beats.push({ tag, text: chunk.trim(), words });
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    tag = m[1].trim().toLowerCase();
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  // Tags with no words after them still set the mood for the line.
  if (beats.length === 0 && tag) beats.push({ tag, text: '', words: 1 });
  return beats;
}

export function spokenText(text: string): string {
  return text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Body language for a speaker delivering a line with this tag. */
const SPEAKING_BODY: Record<string, string> = {
  suspicion: 'stands facing the other person, leaning back slightly with arms crossed, head tilted, talking warily',
  whispers: 'leans in close toward the other person, head lowered, talking quietly with small hand movements',
  whisper: 'leans in close toward the other person, head lowered, talking quietly with small hand movements',
  exhaustion: 'stands with slumped shoulders, talking slowly with heavy tired gestures, rubs their face',
  shock: 'pulls back in surprise, both hands open, talking animatedly',
  concern: 'steps slightly toward the other person, talking gently with one hand reaching out',
  despair: 'stands with head down, talking while one hand covers their face, shoulders sagging',
  bitterness: 'talks with short sharp hand gestures, shaking their head',
  empathy: 'faces the other person, talking softly with open palms, head tilted with sympathy',
  emptiness: 'stands still, staring at the floor, talking with almost no movement, arms hanging',
  hopelessness: 'talks while looking down, shrugs helplessly, arms dropping to their sides',
  anger: 'talks aggressively, pointing at the other person, chest forward',
  angry: 'talks aggressively, pointing at the other person, chest forward',
  shouting: 'shouts at the other person, arms thrown out, leaning forward',
  excited: 'talks excitedly with big energetic hand gestures, bouncing on their feet',
  sarcastic: 'talks with a dismissive wave of the hand, weight on one leg',
  laughs: 'laughs while talking, head thrown back, hand on stomach',
  crying: 'talks while crying, wiping their eyes, shoulders shaking',
  amazed: 'talks in amazement, hands raised, leaning back',
  fear: 'talks nervously, stepping back, hands raised defensively',
  sadness: 'talks quietly with head lowered, shoulders dropped',
  joy: 'talks happily with open relaxed gestures',
};

/** How the other person reacts while listening to a line with this tag. */
const LISTENING_BODY: Record<string, string> = {
  suspicion: 'stands facing the other person, avoiding eye contact, shifting weight uncomfortably',
  whispers: 'leans slightly toward the other person to listen closely',
  exhaustion: 'stands still listening with concern, small slow nods',
  shock: 'stands listening, frozen for a moment',
  despair: 'listens in stunned silence, slowly reaches a hand toward the other person',
  bitterness: 'listens silently, looking down, shaking head slightly',
  hopelessness: 'listens silently, looking at the other person with sympathy, very still',
  emptiness: 'listens silently, very still, looking at the other person',
  anger: 'listens defensively, stepping back slightly',
  shouting: 'flinches and steps back while listening',
  crying: 'listens, stepping closer with a comforting hand raised',
  laughs: 'listens and smiles, relaxed shoulders',
};

const DEFAULT_SPEAKING = 'stands facing the other person, talking with natural hand gestures';
const DEFAULT_LISTENING = 'stands facing the other person, listening attentively with small nods and weight shifts';

export function speakingPrompt(tag: string | null): string {
  if (!tag) return DEFAULT_SPEAKING;
  return SPEAKING_BODY[tag] || `stands facing the other person, talking with a ${tag} attitude and matching body language`;
}

export function listeningPrompt(tagHeard: string | null): string {
  return (tagHeard && LISTENING_BODY[tagHeard]) || DEFAULT_LISTENING;
}

/**
 * Builds one actor's Kimodo multi-text sequence covering the whole scene: speaking beats while
 * their lines play (split by word count at each inline tag), listening reactions otherwise.
 * Segments are sequential from t=0, so their durations must sum to the scene duration.
 */
export function buildActorSegments(scene: Pick<DialogueScene, 'lines'>, speaker: string, duration: number): MotionSegment[] {
  type Span = { start: number; end: number; prompt: string };
  const spans: Span[] = [];
  const lines = [...scene.lines].sort((a, b) => a.start - b.start);

  let cursor = 0;
  let lastHeardTag: string | null = null;
  const listen = (until: number) => {
    if (until > cursor + 1e-3) spans.push({ start: cursor, end: until, prompt: listeningPrompt(lastHeardTag) });
    cursor = Math.max(cursor, until);
  };

  for (const line of lines) {
    const start = Math.max(cursor, Math.min(duration, line.start));
    const end = Math.max(start, Math.min(duration, line.end));
    const beats = lineBeats(line.text);
    if (line.speaker === speaker) {
      listen(start);
      const words = beats.reduce((n, b) => n + b.words, 0) || 1;
      let t = start;
      beats.forEach((b, i) => {
        const bEnd = i === beats.length - 1 ? end : t + ((end - start) * b.words) / words;
        spans.push({ start: t, end: bEnd, prompt: speakingPrompt(b.tag) });
        t = bEnd;
      });
      cursor = end;
    } else {
      // Keep reacting to the tone of what the other person is saying, beat by beat.
      listen(start);
      const words = beats.reduce((n, b) => n + b.words, 0) || 1;
      let t = start;
      beats.forEach((b, i) => {
        lastHeardTag = b.tag ?? lastHeardTag;
        const bEnd = i === beats.length - 1 ? end : t + ((end - start) * b.words) / words;
        spans.push({ start: t, end: bEnd, prompt: listeningPrompt(lastHeardTag) });
        t = bEnd;
      });
      cursor = end;
    }
  }
  listen(duration);

  // Merge neighbours with the same prompt, then fold too-short spans into the previous one.
  const merged: Span[] = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    if (prev && prev.prompt === s.prompt) prev.end = s.end;
    else merged.push({ ...s });
  }
  const sized: Span[] = [];
  for (const s of merged) {
    const prev = sized[sized.length - 1];
    if (s.end - s.start < MIN_SEGMENT_SEC && prev) prev.end = s.end;
    else sized.push({ ...s });
  }
  if (sized.length > 1 && sized[0].end - sized[0].start < MIN_SEGMENT_SEC) {
    sized[1].start = sized[0].start;
    sized.shift();
  }

  const stamp = Date.now();
  return sized.map((s, i) => ({
    id: `seg_dlg_${stamp}_${i}`,
    prompt: s.prompt,
    duration: Math.round((s.end - s.start) * 100) / 100,
  }));
}

/** Lays per-line clips end to end with a pause between them. */
export function layoutLinesSequentially(
  lines: { id: string; clipDuration: number }[],
  gapSec: number,
  leadIn = 0.5
): Map<string, { start: number; end: number }> {
  const out = new Map<string, { start: number; end: number }>();
  let t = leadIn;
  for (const l of lines) {
    out.set(l.id, { start: t, end: t + l.clipDuration });
    t += l.clipDuration + gapSec;
  }
  return out;
}

export function makeLineId(index: number): string {
  return `dl_${Date.now().toString(36)}_${index}`;
}

/** Re-parses the script while keeping timing/audio for lines whose speaker and text did not change. */
export function linesFromScript(script: string, previous: DialogueLine[]): DialogueLine[] {
  return parseScript(script).map((p, i) => {
    const prev = previous[i];
    if (prev && prev.speaker === p.speaker && prev.text === p.text) return prev;
    return { id: makeLineId(i), speaker: p.speaker, text: p.text, start: 0, end: 0 };
  });
}
