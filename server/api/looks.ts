import fs from 'node:fs';
import path from 'node:path';
import { canOpenProject } from '../lib/crew';
import { GEMINI_TEXT_MODEL, geminiKey, geminiText } from '../lib/gemini';
import { cleanLookFields, createLook, deleteLook, listLooks, updateLook } from '../lib/looks';

/**
 * The look library for one project: /api/projects/:id/looks
 *
 *   GET                       every look on the project
 *   POST                      add a look
 *   POST   /compose           have Gemini write the look's prompt text from its fields
 *   PUT    /<lookId>          replace a look's fields
 *   DELETE /<lookId>          remove a look
 *
 * Anyone on the project can read and change its looks; it is shared research, like the crew list.
 */

function readJsonBody(req: any, limit = 40_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: any) => {
      body += chunk;
      if (body.length > limit) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: any, status: number, payload: any) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

// What the image model needs from a look, learned from the previs tests (2026-09-25): it follows
// descriptions of what is visible (flare, grain, colour, light) and ignores equipment jargon, and
// it copies whatever depth of field the previs frame already has.
// A look is the GRADE only (2026-09-28). The camera, lens and film come from the take's camera
// package and the light from the shot, so a look that also described them repeated or fought
// them, and pushed the render prompt past the model's word budget. Its reference still travels
// with every render as image 2, which carries far more than words.
const WRITER_INSTRUCTIONS = `You write the "Grade" paragraph of an image-generation prompt that turns a film's previs into a photographed frame. The same grade is reused on many different shots, so describe only how the picture's colour and tone feel. Never describe what is in the picture (people, objects, places, wardrobe, story), and say nothing about camera bodies, lenses, film stock or where the light comes from: those are written separately.

Write one paragraph that starts with "Grade:" and is 40 to 70 words:
- the mood of the colour in a few words (e.g. "warm, saturated yellow-green, like a hot, stale afternoon"; "low-key and moody");
- how shadows, midtones and highlights read, giving every palette colour as its hex value with its role (deep shadows, dark midtones, accents, midtones, highlights, peak), using exactly the palette colours you are given, all of them and no others; only when there is no palette, take the colours from the reference image;
- contrast and how deep the blacks are;
- where skin tones sit.

Do not name object colours (red brick, green door): the grade sets how colours read, not what they are. The facts you are given win over the reference image. Plain, direct words, no hype. Output only the paragraph: no title, no preamble, no closing remarks.`;

function describeFields(fields: ReturnType<typeof cleanLookFields>): string {
  const rows: [string, string][] = [
    ['Look name', fields.name],
    ['Reference (film or shot)', fields.source],
    ['Camera', fields.camera],
    ['Lens', fields.lens],
    ['Film stock or capture', fields.filmStock],
    ['Format', fields.format],
    ['Aspect ratio', fields.aspectRatio],
    ['Lighting', fields.lighting],
    ['Colour notes', fields.colorNotes],
    ['Palette, darkest to lightest', fields.palette.join(', ')],
  ];
  return rows
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

/** The stored reference picture as inline image data, or null when there is none to send. */
function referenceImagePart(referenceUrl: string): any | null {
  if (!referenceUrl) return null;
  const filename = path.basename(referenceUrl.replace('/api/assets/', ''));
  const filePath = path.join(process.cwd(), 'data', 'assets', filename);
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  if (buf.length > 8 * 1024 * 1024) return null;
  const ext = path.extname(filename).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { inlineData: { mimeType, data: buf.toString('base64') } };
}

async function composeLookPrompt(input: any): Promise<string> {
  if (!geminiKey()) throw new Error('The server has no Gemini key, so it cannot write the look. Write it by hand, or ask the owner to add a key.');

  const fields = cleanLookFields({ ...input, name: input?.name || 'Untitled look' });
  const image = referenceImagePart(fields.referenceUrl);

  const parts: any[] = [];
  if (image) {
    parts.push(image);
    parts.push({ text: 'The image above is the reference still for this look. Use it only for its light, contrast, colour and grain, never for its content.' });
  }
  parts.push({ text: `Facts about the look:\n${describeFields(fields) || '(none given, work from the reference image)'}` });

  return geminiText({ system: WRITER_INSTRUCTIONS, parts });
}

/** Handles /api/projects/<id>/looks[/<lookId>|/compose]. Returns true when it answered. */
export async function handleLooksApi(req: any, res: any): Promise<boolean> {
  const urlPath = (req.url || '').split('?')[0];
  const match = /^\/api\/projects\/([^/]+)\/looks(?:\/([^/]+))?$/.exec(urlPath);
  if (!match) return false;

  const projectId = decodeURIComponent(match[1]);
  const sub = match[2] ? decodeURIComponent(match[2]) : null;
  const user = req.auraUser;

  try {
    if (!(await canOpenProject(user._id, projectId))) {
      sendJson(res, 404, { success: false, error: 'No such project.' });
      return true;
    }

    if (req.method === 'GET' && !sub) {
      sendJson(res, 200, { success: true, looks: await listLooks(projectId) });
      return true;
    }

    if (req.method === 'POST' && sub === 'compose') {
      const body = await readJsonBody(req);
      console.log(`[API looks] writing look "${body?.name || 'untitled'}" with ${GEMINI_TEXT_MODEL} for ${user.email}`);
      const started = Date.now();
      const lookPrompt = await composeLookPrompt(body);
      console.log(`[API looks] look written in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      sendJson(res, 200, { success: true, lookPrompt });
      return true;
    }

    if (req.method === 'POST' && !sub) {
      const body = await readJsonBody(req);
      sendJson(res, 200, { success: true, look: await createLook(projectId, user._id, body) });
      return true;
    }

    if (req.method === 'PUT' && sub) {
      const body = await readJsonBody(req);
      const look = await updateLook(projectId, sub, body);
      if (!look) sendJson(res, 404, { success: false, error: 'That look no longer exists.' });
      else sendJson(res, 200, { success: true, look });
      return true;
    }

    if (req.method === 'DELETE' && sub) {
      await deleteLook(projectId, sub);
      sendJson(res, 200, { success: true });
      return true;
    }

    sendJson(res, 405, { success: false, error: 'Unsupported method.' });
    return true;
  } catch (err: any) {
    console.error('[API looks]', err?.message || err);
    sendJson(res, 400, { success: false, error: err?.message || 'Could not update the look library.' });
    return true;
  }
}
