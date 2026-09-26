import { env } from './env';
import { describeFetchError } from './errors';

/**
 * One Gemini text call, for the server's prompt writers (looks, render frames).
 *
 * Thinking is set low: with the model's default thinking, writing a look from a picture took
 * ~40s, with low ~18s (measured 2026-09-25), and these tasks are simple enough not to need more.
 * "gemini-flash-latest" can move to a model that does not take that setting, so a refusal of it
 * is retried once without.
 */

export const GEMINI_TEXT_MODEL = env.LOOK_WRITER_MODEL || 'gemini-flash-latest';

export function geminiKey(): string {
  return env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || '';
}

export async function geminiText(options: {
  system: string;
  parts: any[];
  json?: { schema: any };
  model?: string;
  timeoutMs?: number;
}): Promise<string> {
  const key = geminiKey();
  if (!key) throw new Error('The server has no Gemini key.');
  const model = options.model || GEMINI_TEXT_MODEL;

  const baseConfig: any = { temperature: 0.4 };
  if (options.json) {
    baseConfig.responseMimeType = 'application/json';
    baseConfig.responseSchema = options.json.schema;
  }

  const request = (generationConfig: any) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: options.system }] },
        contents: [{ role: 'user', parts: options.parts }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
    });

  let upstream: Response;
  let text: string;
  try {
    upstream = await request({ ...baseConfig, thinkingConfig: { thinkingLevel: 'low' } });
    text = await upstream.text();
    if (upstream.status === 400 && /thinking/i.test(text)) {
      upstream = await request(baseConfig);
      text = await upstream.text();
    }
  } catch (err) {
    throw new Error(`Could not reach Gemini: ${describeFetchError(err)}`);
  }

  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // An unusable key gets an HTML page back rather than JSON.
  }
  if (!upstream.ok) {
    // Google's refusal pages carry a stylesheet; strip it or the "reason" is CSS.
    const readable = text
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    const reason =
      data?.error?.message ||
      (upstream.status === 403 && !data
        ? 'Google refused this network. If you are on a VPN, switch it to another location.'
        : readable);
    throw new Error(`Gemini refused the request (HTTP ${upstream.status}). ${reason}`);
  }

  const written = (data?.candidates?.[0]?.content?.parts || [])
    .filter((p: any) => !p.thought)
    .map((p: any) => p.text || '')
    .join('')
    .trim();
  if (!written) throw new Error('Gemini returned no text. Try again.');
  return written;
}
