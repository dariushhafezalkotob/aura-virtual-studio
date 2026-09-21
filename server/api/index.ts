import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { handle_file } from '@gradio/client';
import { handleDialogueApi } from '../dialogueApi';
import { env } from '../lib/env';
import { getHfToken } from '../lib/env';
import { extractErrorMessage, describeFetchError, isTransportError } from '../lib/errors';
import { normalizeGradioFileData, resolveMediaUrl, persistMediaLocally } from '../lib/media';
import { getLocalIpAddress } from '../lib/network';
import { externalizeProjects, rehydrateProjects, backupProjectsOnce } from '../lib/projectStore';
import { handleAuthApi, sessionTokenFrom } from './auth';
import { userForSession } from '../lib/users';
import {
  KIMODO_SPACE,
  getTrellisClient,
  getHunyuan3DClient,
  getHunyuanWorldClient,
  getPanoramaClient,
} from '../lib/spaces';

const HF_TOKEN = getHfToken();

export interface ApiContext {
  /** Scheme the app is actually served on - the phone pairing URL has to match it. */
  scheme: string;
  port: number;
}

/**
 * Every /api route, as one connect-style middleware. The Vite dev server mounts this, and so does
 * the production server, so there is only ever one copy of this code to maintain.
 */
export function createApiMiddleware(ctx: ApiContext) {
  const scheme = ctx.scheme;
  const devPort = ctx.port;

  return async (req: any, res: any, next: () => void) => {
    // Sign-in runs before the gate, for obvious reasons.
    if (await handleAuthApi(req, res, scheme)) return;

    // Everything else under /api needs a session. Without this, putting the API keys on the
    // server would mean anyone who finds the URL spends the owner's GPU quota.
    if (req.url?.startsWith('/api/')) {
      const user = await userForSession(sessionTokenFrom(req)).catch((err) => {
        console.error('[auth] session lookup failed:', err?.message || err);
        return null;
      });

      if (!user) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, error: 'Please sign in.' }));
        return;
      }

      // Routes below read this instead of looking the session up again.
      req.auraUser = user;
    }

    if (req.url?.startsWith('/api/dialogue/')) {
      if (await handleDialogueApi(req, res)) return;
    }

    // -1. Network Host IP Discovery for Mobile Pairing QR Code
    if (req.url?.startsWith('/api/network-ip')) {
      const lanIp = getLocalIpAddress();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: true,
        ip: lanIp,
        protocol: scheme,
        port: devPort,
        url: `${scheme}://${lanIp}:${devPort}`
      }));
      return;
    }

    // 0. Local Disk File Persistence for Projects & Scenes (Bulletproof Local Dev)
    if (req.url?.startsWith('/api/projects')) {
      const dataDir = path.join(process.cwd(), 'data');
      const projectsFilePath = path.join(dataDir, 'projects.json');

      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      if (req.method === 'GET') {
        try {
          if (fs.existsSync(projectsFilePath)) {
            const stored = JSON.parse(fs.readFileSync(projectsFilePath, 'utf-8'));
            // Takes and motion live in their own files now; put them back before answering.
            const payload = Array.isArray(stored)
              ? rehydrateProjects(stored, dataDir)
              : { ...stored, projects: rehydrateProjects(stored.projects || [], dataDir) };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(payload));
            return;
          } else {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, projects: [] }));
            return;
          }
        } catch (err: any) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: err.message }));
          return;
        }
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body);

            // Auto-cache any remote 3D models or media in projects so they never become gray boxes
            if (Array.isArray(parsed)) {
              for (const proj of parsed) {
                if (proj && Array.isArray(proj.scenes)) {
                  for (const s of proj.scenes) {
                    if (s && s.glbUrl && (s.glbUrl.startsWith('http://') || s.glbUrl.startsWith('https://'))) {
                      s.glbUrl = await persistMediaLocally(s.glbUrl, s.engine || 'model');
                    }
                    if (s && s.previewUrl && (s.previewUrl.startsWith('http://') || s.previewUrl.startsWith('https://'))) {
                      s.previewUrl = await persistMediaLocally(s.previewUrl, 'preview');
                    }
                  }
                }
                if (proj && proj.panoramaUrl && (proj.panoramaUrl.startsWith('http://') || proj.panoramaUrl.startsWith('https://'))) {
                  proj.panoramaUrl = await persistMediaLocally(proj.panoramaUrl, 'pano');
                }
                if (proj && proj.splatUrl && (proj.splatUrl.startsWith('http://') || proj.splatUrl.startsWith('https://'))) {
                  proj.splatUrl = await persistMediaLocally(proj.splatUrl, 'splat');
                }
              }
            }

            // Write camera takes and actor motion to their own files, so projects.json stays small
            // and an unchanged take is never rewritten.
            backupProjectsOnce(projectsFilePath, dataDir);

            // What is on disk right now, so an "unchanged" marker can be resolved against it.
            let stored: any[] = [];
            try {
              if (fs.existsSync(projectsFilePath)) {
                const raw = JSON.parse(fs.readFileSync(projectsFilePath, 'utf-8'));
                stored = Array.isArray(raw) ? raw : raw.projects || [];
              }
            } catch (readErr: any) {
              console.warn('[API /api/projects] Could not read the current projects file:', readErr?.message || readErr);
            }

            const toStore = Array.isArray(parsed)
              ? externalizeProjects(parsed, dataDir, stored)
              : parsed;

            // Atomic file write using temporary file to prevent corruption
            const tempFilePath = path.join(dataDir, `projects.tmp.${Date.now()}.json`);
            fs.writeFileSync(tempFilePath, JSON.stringify(toStore, null, 2), 'utf-8');
            fs.renameSync(tempFilePath, projectsFilePath);

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, count: Array.isArray(parsed) ? parsed.length : 1 }));
          } catch (err: any) {
            console.error('[API /api/projects] Failed to save projects to disk:', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }
    }

    // 0.5 Local Disk File Persistence for Stage Templates & Presets (./data/stages.json)
    if (req.url?.startsWith('/api/stages')) {
      const dataDir = path.join(process.cwd(), 'data');
      const stagesFilePath = path.join(dataDir, 'stages.json');

      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      if (req.method === 'GET') {
        try {
          if (fs.existsSync(stagesFilePath)) {
            const content = fs.readFileSync(stagesFilePath, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(content);
            return;
          } else {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify([]));
            return;
          }
        } catch (err: any) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: err.message }));
          return;
        }
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body);

            if (Array.isArray(parsed)) {
              for (const stage of parsed) {
                if (stage && Array.isArray(stage.scenes)) {
                  for (const s of stage.scenes) {
                    if (s && s.glbUrl && (s.glbUrl.startsWith('http://') || s.glbUrl.startsWith('https://'))) {
                      s.glbUrl = await persistMediaLocally(s.glbUrl, s.engine || 'model');
                    }
                  }
                }
              }
            }

            const tempFilePath = path.join(dataDir, `stages.tmp.${Date.now()}.json`);
            fs.writeFileSync(tempFilePath, JSON.stringify(parsed, null, 2), 'utf-8');
            fs.renameSync(tempFilePath, stagesFilePath);

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, count: Array.isArray(parsed) ? parsed.length : 1 }));
          } catch (err: any) {
            console.error('[API /api/stages] Failed to save stages to disk:', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }
    }

    // 0.6 Persistent Asset Upload & Static File Serving (./data/assets)
    if (req.url?.startsWith('/api/assets/')) {
      const rawName = req.url.replace('/api/assets/', '').split('?')[0];
      const filename = path.basename(decodeURIComponent(rawName));
      const assetPath = path.join(process.cwd(), 'data', 'assets', filename);

      if (fs.existsSync(assetPath)) {
        const ext = path.extname(filename).toLowerCase();
        let contentType = 'application/octet-stream';
        if (ext === '.glb') contentType = 'model/gltf-binary';
        else if (ext === '.gltf') contentType = 'model/gltf+json';
        else if (ext === '.png') contentType = 'image/png';
        else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
        else if (ext === '.json') contentType = 'application/json';
        else if (ext === '.wav') contentType = 'audio/wav';
        else if (ext === '.mp3') contentType = 'audio/mpeg';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        fs.createReadStream(assetPath).pipe(res);
        return;
      } else {
        res.statusCode = 404;
        res.end('Asset not found');
        return;
      }
    }

    if (req.url?.startsWith('/api/upload-asset') && req.method === 'POST') {
      const assetsDir = path.join(process.cwd(), 'data', 'assets');
      if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
      }

      const urlObj = new URL(req.url, 'http://localhost:3000');
      const queryName = urlObj.searchParams.get('filename') || `asset_${Date.now()}.glb`;
      const filename = path.basename(queryName);
      const destPath = path.join(assetsDir, filename);

      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          fs.writeFileSync(destPath, buffer);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, url: `/api/assets/${filename}` }));
        } catch (err: any) {
          console.error('[API /api/upload-asset] Failed to save asset to disk:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    // 1. Image & Asset Proxy for 360 Panoramas, PLY/SPLAT assets, and GLB models (CORS safe)
    if (req.url?.startsWith('/api/proxy-image')) {
      try {
        const urlObj = new URL(req.url, 'http://localhost:3000');
        const targetUrl = urlObj.searchParams.get('url');
        if (!targetUrl) {
          res.statusCode = 400;
          res.end('Missing url param');
          return;
        }
        const fetchRes = await fetch(targetUrl);
        const arrayBuf = await fetchRes.arrayBuffer();
        const contentType = fetchRes.headers.get('content-type') || 'application/octet-stream';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.end(Buffer.from(arrayBuf));
        return;
      } catch (e: any) {
        res.statusCode = 500;
        res.end('Proxy error: ' + e.message);
        return;
      }
    }

    // 2. Dedicated HunyuanWorld 3D Scene Reconstruction (3D Gaussian Splats & World Mesh)
    if (req.url?.startsWith('/api/reconstruct-hunyuan-world') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          const tmpDir = os.tmpdir();
          console.log('[API /api/reconstruct-hunyuan-world] Connecting to HunyuanWorld ZeroGPU Engine...');
          const client = await getHunyuanWorldClient();

          const fileHandles: any[] = [];
          if (params.files && Array.isArray(params.files)) {
            for (let i = 0; i < params.files.length; i++) {
              const fData = params.files[i];
              const tmpFile = path.join(tmpDir, `hy_frame_${Date.now()}_${i}.png`);
              const base64Clean = fData.includes(',') ? fData.split(',')[1] : fData;
              fs.writeFileSync(tmpFile, Buffer.from(base64Clean, 'base64'));
              fileHandles.push(handle_file(tmpFile));
            }
          }

          if (fileHandles.length === 0) {
            throw new Error('Please upload at least 2 photos or a video walkthrough.');
          }

          console.log(`[API /api/reconstruct-hunyuan-world] Calling /reconstruct_world on ZeroGPU with ${fileHandles.length} views...`);
          const result = await client.predict('/reconstruct_world', [fileHandles]);
          const data = result.data as any[];

          let gaussianSplatUrl = '';
          let gaussianPlyUrl = '';

          for (const item of data) {
            const url = resolveMediaUrl(item);
            if (url.endsWith('.splat') || url.includes('.splat')) {
              gaussianSplatUrl = url;
            } else if (url.endsWith('.ply') || url.includes('.ply')) {
              gaussianPlyUrl = url;
            }
          }

          const rawSplat = gaussianSplatUrl || gaussianPlyUrl || resolveMediaUrl(data[0]);
          const primarySplat = await persistMediaLocally(rawSplat, 'hunyuan_world_splat');

          console.log('[API /api/reconstruct-hunyuan-world] Finished! 3DGS Splat URL:', primarySplat);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            success: true,
            gaussianPlyUrl: primarySplat,
            message: 'HunyuanWorld 3D Gaussian Splatting scene successfully reconstructed!'
          }));
        } catch (err: any) {
          console.error('[API /api/reconstruct-hunyuan-world] Error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
        }
      });
      return;
    }

    // 3. Strict 2-Step Chained Pipeline: Image -> 360 Panorama -> 4-View 3D Scene Mesh
    if (req.url?.startsWith('/api/generate-360-from-image') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          const tmpDir = os.tmpdir();

          // STEP 1: Generate Full 360° Panorama Sphere
          console.log('[Pipeline Step 1] Generating 360° Panorama on ZeroGPU...');
          const panoClient = await getPanoramaClient();
          let panoramaUrl = '';

          if (params.imageBase64 || params.imageUrl) {
            const tmpInputPath = path.join(tmpDir, `input_raw_${Date.now()}.png`);
            if (params.imageBase64) {
              const base64Data = params.imageBase64.includes(',')
                ? params.imageBase64.split(',')[1]
                : params.imageBase64;
              fs.writeFileSync(tmpInputPath, Buffer.from(base64Data, 'base64'));
            } else {
              const fetchRes = await fetch(params.imageUrl);
              const arrayBuf = await fetchRes.arrayBuffer();
              fs.writeFileSync(tmpInputPath, Buffer.from(arrayBuf));
            }

            console.log('[Pipeline Step 1] Placing image on 360 canvas with source_scale: 0.5...');
            const placeRes = await panoClient.predict('/place_on_canvas', [
              handle_file(tmpInputPath),
              0.5
            ]);
            const canvasData = placeRes.data[0];

            console.log('[Pipeline Step 1] Outpainting to full 360° sphere...');
            const outRes = await panoClient.predict('/outpaint_panorama', [
              canvasData,
              params.prompt || 'Expand this scene into a full 360-degree equirectangular panorama room, photorealistic, cinematic lighting',
              params.steps || 4,
              1.0,
              params.seed || 1234,
              true
            ]);

            panoramaUrl = resolveMediaUrl(outRes.data[0]);
          } else if (params.prompt) {
            const textRes = await panoClient.predict('/generate_panorama', [
              params.prompt,
              '1024',
              params.steps || 4,
              1.0,
              params.seed || 1234,
              true
            ]);
            panoramaUrl = resolveMediaUrl(textRes.data[0]);
          } else {
            throw new Error('Please provide an image or prompt for 360 world generation.');
          }

          console.log('[Pipeline Step 1] 360° Panorama Generated Successfully:', panoramaUrl);

          // STEP 2: Slicing GENERATED 360 Panorama into 4 Views and Reconstructing 3D Scene Mesh
          console.log('[Pipeline Step 2] Slicing GENERATED 360° Panorama into 4 Perspective Cameras...');
          const panoFetch = await fetch(panoramaUrl);
          const panoBuf = Buffer.from(await panoFetch.arrayBuffer());
          const generatedPanoPath = path.join(tmpDir, `generated_pano_${Date.now()}.png`);
          fs.writeFileSync(generatedPanoPath, panoBuf);

          const slicesDir = path.join(tmpDir, `sliced_views_${Date.now()}`);
          const slicerScript = path.join(process.cwd(), 'slice_equirect_views.py');
          execSync(`python3 "${slicerScript}" "${generatedPanoPath}" "${slicesDir}"`);

          const frontPath = path.join(slicesDir, 'slice_front.png');
          const backPath = path.join(slicesDir, 'slice_back.png');
          const leftPath = path.join(slicesDir, 'slice_left.png');
          const rightPath = path.join(slicesDir, 'slice_right.png');

          console.log('[Pipeline Step 2] Sending 4 perspective views to Hunyuan3D-2.0 / TRELLIS on ZeroGPU...');
          let glbUrl = '';
          try {
            const hyClient = await getHunyuan3DClient();
            const hyResult = await hyClient.predict('/generation_all', [
              params.prompt || 'Photorealistic 3D Environment Room and Scene',
              handle_file(frontPath),
              handle_file(frontPath),
              handle_file(backPath),
              handle_file(leftPath),
              handle_file(rightPath),
              20,
              7.5,
              1234,
              256,
              false,
              200000,
              true
            ]);

            const data = hyResult.data as any[];
            try {
              const file1 = normalizeGradioFileData(data[0]);
              const file2 = normalizeGradioFileData(data[1]);
              const exportRes = await hyClient.predict('/on_export_click', [
                file1,
                file2,
                'glb',
                false,
                true,
                50000
              ]);
              const exportData = exportRes.data as any[];
              for (let i = exportData.length - 1; i >= 0; i--) {
                const resolved = resolveMediaUrl(exportData[i]);
                if (resolved && (resolved.endsWith('.glb') || resolved.includes('.glb'))) {
                  glbUrl = resolved;
                  break;
                }
              }
              if (!glbUrl) glbUrl = resolveMediaUrl(exportData[1]) || resolveMediaUrl(exportData[0]);
            } catch (expErr) {
              console.warn('[Pipeline Step 2] on_export_click texture baking error:', expErr);
            }

            if (!glbUrl) {
              for (let i = data.length - 1; i >= 0; i--) {
                const resolved = resolveMediaUrl(data[i]);
                if (resolved && !resolved.endsWith('.mp4') && (resolved.endsWith('.glb') || resolved.includes('.glb'))) {
                  glbUrl = resolved;
                  break;
                }
              }
              if (!glbUrl) glbUrl = resolveMediaUrl(data[1]) || resolveMediaUrl(data[0]);
            }
          } catch (hyErr) {
            console.warn('[Pipeline Step 2] Hunyuan3D multi-view fallback to TRELLIS:', hyErr);
            const trellis = await getTrellisClient();
            const result = await trellis.predict('/generate_and_extract_glb', [
              handle_file(frontPath),
              [],
              false,
              params.seed || 1234,
              8.5,
              16,
              3.0,
              16,
              'stochastic',
              0.98,
              1024,
            ]);
            const data = result.data as any[];
            for (let i = data.length - 1; i >= 0; i--) {
              const resolved = resolveMediaUrl(data[i]);
              if (resolved && !resolved.endsWith('.mp4') && (resolved.endsWith('.glb') || resolved.includes('.glb'))) {
                glbUrl = resolved;
                break;
              }
            }
          }

          const persistentPanoUrl = await persistMediaLocally(panoramaUrl, 'pano_360');
          const persistentGlbUrl = await persistMediaLocally(glbUrl, 'multiview_scene');

          console.log('[Pipeline Complete!] 360° Panorama:', persistentPanoUrl, '3D Scene Mesh:', persistentGlbUrl);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            success: true,
            panoramaUrl: persistentPanoUrl,
            glbUrl: persistentGlbUrl,
            message: '2-Step 360° AI World & 3D Scene Geometry Successfully Synthesized!'
          }));
        } catch (err: any) {
          console.error('[API /api/generate-360-from-image] Error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
        }
      });
      return;
    }

    // 3.5 AI Reference Image Generation (for 3D Prop Generation)
    if (req.url?.startsWith('/api/generate-image') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          const prompt = (params.prompt || '').trim();
          if (!prompt) throw new Error('Please enter a description for the image.');

          const geminiKey = params.apiKey || (req.headers['x-gemini-key'] as string) || process.env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || '';
          const model = params.model || 'gemini-3.1-flash-lite-image';
          console.log(`[API /api/generate-image] Synthesizing reference image with ${model} (Key provided: ${!!geminiKey}): "${prompt}"...`);

          let imageBase64 = '';
          let lastGeminiError = '';
          let lastGeminiWasNetwork = false;
          let lastFallbackError = '';
          let usedProvider = '';

          const isolatedPrompt = `${prompt}, single isolated 3D prop asset centered, floating on pure solid pitch black background (#000000), absolutely no floor, no ground, no shadow underneath, no table, no room, no walls, studio object isolate, crisp sharp edges, 8k resolution, cinematic studio lighting, octane render.`;

          // 1. Try Gemini Multimodal Image Generation with requested model (gemini-3.1-flash-lite-image)
          if (geminiKey) {
            // A dropped connection ("fetch failed") is worth one immediate retry on a fresh
            // socket; a real API answer (bad key, quota, unknown model) is not.
            for (let attempt = 1; attempt <= 2 && !imageBase64; attempt++) {
            try {
              console.log(`[API /api/generate-image] Fast generateContent with ${model}${attempt > 1 ? ` (retry ${attempt - 1})` : ''}...`);
              const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [
                    {
                      parts: [
                        { text: `Generate a single isolated 3D prop asset: ${prompt}. The object must be floating in the center on a pure solid pitch black background (#000000). Absolutely no floor, no ground, no shadow on ground, no table, no room, no walls, no environment. Only the standalone 3D object completely isolated against a black void background, front 3/4 perspective hero angle, photorealistic, crisp sharp edges, 8k resolution, cinematic studio lighting.` }
                      ]
                    }
                  ],
                  generationConfig: {
                    responseModalities: ["IMAGE", "TEXT"],
                    temperature: 0.7,
                  }
                }),
                signal: AbortSignal.timeout(60000),
              });
              if (res.ok) {
                const genData = (await res.json()) as any;
                const candidates = genData.candidates || [];
                for (const cand of candidates) {
                  const parts = cand.content?.parts || [];
                  for (const part of parts) {
                    if (part.inlineData?.data) {
                      const mime = part.inlineData.mimeType || 'image/png';
                      imageBase64 = `data:${mime};base64,${part.inlineData.data}`;
                      usedProvider = `Gemini (${model})`;
                      break;
                    }
                  }
                  if (imageBase64) break;
                }
                if (imageBase64) {
                  console.log(`[API /api/generate-image] ✓ Successfully generated image via Gemini ${model}!`);
                }
              } else {
                const gErr = (await res.json().catch(() => ({}))) as any;
                lastGeminiError = gErr?.error?.message || `HTTP ${res.status}`;
                lastGeminiWasNetwork = false;
                console.warn(`[Gemini ${model} call error]:`, lastGeminiError);
                break; // the API answered; retrying the same request will not change it
              }
            } catch (gErr: any) {
              lastGeminiError = describeFetchError(gErr);
              lastGeminiWasNetwork = isTransportError(gErr) || gErr?.name === 'TimeoutError';
              console.warn(`[Gemini ${model} call exception]:`, lastGeminiError);
              if (!isTransportError(gErr) || attempt === 2) break;
              await new Promise((r) => setTimeout(r, 400));
            }
            }

            // Provider 1B: Imagen 3.0 fallback if primary model failed
            if (!imageBase64) {
              try {
                console.log('[API /api/generate-image] Trying Imagen-3.0 fallback...');
                const imgPayload = {
                  instances: [{ prompt: isolatedPrompt }],
                  parameters: { sampleCount: 1, aspectRatio: '1:1', outputMimeType: 'image/png' },
                };
                const resG = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${geminiKey}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(imgPayload),
                  signal: AbortSignal.timeout(18000),
                });
                if (resG.ok) {
                  const j = (await resG.json()) as any;
                  const preds = j.predictions || [];
                  if (preds[0]?.bytesBase64Encoded) {
                    imageBase64 = `data:image/png;base64,${preds[0].bytesBase64Encoded}`;
                    usedProvider = 'Google Imagen 3.0';
                    console.log('[API /api/generate-image] ✓ Successfully generated image via Imagen-3.0!');
                  }
                }
              } catch (gErr) {
                console.warn('[Gemini Imagen failed]:', gErr);
              }
            }
          }

          // 2. High-speed Pollinations FLUX / Turbo fallback (ultra fast & no key required)
          if (!imageBase64) {
            console.log('[API /api/generate-image] Trying Pollinations FLUX / Turbo fallback...');
            const seed = Math.floor(Math.random() * 1000000);
            const encodedPrompt = encodeURIComponent(isolatedPrompt);

            const endpoints = [
              `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}&model=flux`,
              `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}&model=turbo`,
              `https://gen.pollinations.ai/image/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`,
            ];

            for (const pUrl of endpoints) {
              try {
                const fetchRes = await fetch(pUrl, {
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                  },
                  signal: AbortSignal.timeout(15000),
                });
                if (fetchRes.ok) {
                  const arrayBuf = await fetchRes.arrayBuffer();
                  if (arrayBuf.byteLength > 1000) {
                    const b64 = Buffer.from(arrayBuf).toString('base64');
                    const mime = fetchRes.headers.get('content-type') || 'image/png';
                    imageBase64 = `data:${mime};base64,${b64}`;
                    usedProvider = 'Pollinations FLUX';
                    console.log(`[API /api/generate-image] ✓ Successfully generated image via Pollinations! (${(arrayBuf.byteLength / 1024).toFixed(1)} KB)`);
                    break;
                  }
                  lastFallbackError = 'Pollinations returned an empty image';
                } else {
                  const pBody = await fetchRes.text().catch(() => '');
                  let reason = `HTTP ${fetchRes.status}`;
                  try {
                    const parsed = JSON.parse(pBody);
                    // Pollinations nests the real reason (e.g. INSUFFICIENT_BALANCE) inside message.
                    reason = parsed?.message || parsed?.error?.message || parsed?.error || reason;
                  } catch (_) { /* not JSON */ }
                  lastFallbackError = String(reason).slice(0, 200);
                  console.warn(`[API /api/generate-image] Pollinations endpoint (${pUrl.slice(0, 50)}...) refused:`, lastFallbackError);
                }
              } catch (pErr: any) {
                lastFallbackError = describeFetchError(pErr);
                console.warn(`[API /api/generate-image] Pollinations endpoint (${pUrl.slice(0, 50)}...) failed:`, lastFallbackError);
              }
            }
          }

          if (!imageBase64) {
            const fallbackNote = lastFallbackError
              ? ` The free backup provider is also unavailable: ${lastFallbackError}.`
              : '';
            let failReason: string;
            if (!geminiKey) {
              failReason = `No Gemini API key is set, so only the free backup provider was tried.${fallbackNote || ' It did not respond.'} Add a Gemini key in Settings.`;
            } else if (lastGeminiWasNetwork) {
              // "fetch failed" / timeout: the request never reached Google, so the key is not the suspect.
              failReason = `Could not reach the Gemini servers: "${lastGeminiError}". This is a connection problem, not your API key — check your internet, VPN or firewall and try again.${fallbackNote}`;
            } else if (lastGeminiError) {
              failReason = `Gemini refused the request: "${lastGeminiError}".${fallbackNote}`;
            } else {
              failReason = `Gemini returned no image for this prompt.${fallbackNote}`;
            }
            throw new Error(failReason);
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            success: true,
            imageBase64,
            images: [imageBase64],
            prompt,
            model: usedProvider || (geminiKey ? 'imagen-3.0-generate-002' : 'pollinations-flux')
          }));
        } catch (err: any) {
          const errMsg = extractErrorMessage(err);
          console.error('[API /api/generate-image] Error:', errMsg);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: errMsg }));
        }
      });
      return;
    }

    // 4. 3D Model & Prop Generation (TRELLIS & Hunyuan3D-2.0)
    if (req.url?.startsWith('/api/generate-3d') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          const engine = params.engine || 'trellis';
          const userToken = (req.headers['x-hf-token'] as string) || params.hfToken;
          console.log(`[API /api/generate-3d] Generating 3D with engine: ${engine}... (Auth: ${userToken ? 'Custom HF Token' : 'Default'})`);

          let fileToPass: any = null;
          const tmpDir = os.tmpdir();

          if (params.imageBase64 || (params.imageUrl && params.imageUrl.startsWith('data:'))) {
            const rawBase64 = params.imageBase64 || params.imageUrl;
            const base64Data = rawBase64.includes(',')
              ? rawBase64.split(',')[1]
              : rawBase64;
            const buf = Buffer.from(base64Data, 'base64');
            const tmpPath = path.join(tmpDir, `3d_upload_${Date.now()}.png`);
            fs.writeFileSync(tmpPath, buf);
            fileToPass = handle_file(tmpPath);
          } else if (params.imageUrl && (params.imageUrl.startsWith('http://') || params.imageUrl.startsWith('https://'))) {
            const fetchRes = await fetch(params.imageUrl);
            const arrayBuf = await fetchRes.arrayBuffer();
            const buf = Buffer.from(arrayBuf);
            const tmpPath = path.join(tmpDir, `3d_remote_${Date.now()}.png`);
            fs.writeFileSync(tmpPath, buf);
            fileToPass = handle_file(tmpPath);
          }

          if (engine === 'hunyuan3d') {
            if (!fileToPass) throw new Error('Hunyuan3D requires a reference image.');
            let client = await getHunyuan3DClient(false, userToken);
            let result: any;
            try {
              result = await client.predict('/generation_all', [
                params.prompt || null,
                fileToPass,
                null,
                null,
                null,
                null,
                params.steps || 20,
                7.5,
                params.seed || 1234,
                256,
                true,
                200000,
                true
              ]);
            } catch (predErr: any) {
              console.warn('[Hunyuan3D] Reconnecting and retrying prediction...', extractErrorMessage(predErr));
              client = await getHunyuan3DClient(true, userToken);
              result = await client.predict('/generation_all', [
                params.prompt || null,
                fileToPass,
                null,
                null,
                null,
                null,
                params.steps || 20,
                7.5,
                params.seed || 1234,
                256,
                true,
                200000,
                true
              ]);
            }

            const data = result.data as any[];
            let glbUrl = '';

            // Step 2 for Hunyuan3D: Call /on_export_click with export_texture: true to bake textures into GLB
            try {
              console.log('[Hunyuan3D] Calling /on_export_click with normalized FileData & export_texture: true to generate fully textured GLB...');
              const file1 = normalizeGradioFileData(data[0]);
              const file2 = normalizeGradioFileData(data[1]);
              const exportRes = await client.predict('/on_export_click', [
                file1, // file_out (geometry FileData)
                file2, // file_out2 (texture data FileData)
                'glb', // file_type
                false, // reduce_face
                true,  // export_texture: TRUE
                50000  // target_face_num
              ]);
              const exportData = exportRes.data as any[];
              console.log('[Hunyuan3D] Export result data:', exportData);
              for (let i = exportData.length - 1; i >= 0; i--) {
                const resolved = resolveMediaUrl(exportData[i]);
                if (resolved && (resolved.endsWith('.glb') || resolved.includes('.glb'))) {
                  glbUrl = resolved;
                  break;
                }
              }
              if (!glbUrl) glbUrl = resolveMediaUrl(exportData[1]) || resolveMediaUrl(exportData[0]);
            } catch (exportErr) {
              console.warn('[Hunyuan3D] on_export_click texture baking error, falling back:', exportErr);
            }

            if (!glbUrl) {
              for (let i = data.length - 1; i >= 0; i--) {
                const resolved = resolveMediaUrl(data[i]);
                if (resolved && !resolved.endsWith('.mp4') && (resolved.endsWith('.glb') || resolved.includes('.glb'))) {
                  glbUrl = resolved;
                  break;
                }
              }
              if (!glbUrl) glbUrl = resolveMediaUrl(data[1]) || resolveMediaUrl(data[0]);
            }

            const persistentGlbUrl = await persistMediaLocally(glbUrl, 'hunyuan3d', userToken);
            console.log('[Hunyuan3D] Final Textured Model URL:', persistentGlbUrl);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, glbUrl: persistentGlbUrl, engine: 'hunyuan3d' }));
            return;
          }

          // Route 2: TRELLIS Neural Engine
          if (!fileToPass) {
            throw new Error('Please upload an image to generate a 3D model with TRELLIS.');
          }

          let client = await getTrellisClient(false, userToken);

          // Step 1: Preprocess image (rembg, center, uniform aspect ratio pad to square)
          // This is identical to the official Trellis demo UI and prevents non-square distortion (e.g. circle becoming ellipse)
          let fileForGeneration = fileToPass;
          try {
            console.log('[TRELLIS] Running /preprocess_image for aspect ratio preservation & background isolation...');
            const prepRes = await client.predict('/preprocess_image', [fileToPass]);
            if (prepRes && prepRes.data && prepRes.data[0]) {
              const norm = normalizeGradioFileData(prepRes.data[0]);
              if (norm) {
                fileForGeneration = norm;
                console.log('[TRELLIS] ✓ Image successfully preprocessed with preserved 1:1 aspect ratio!');
              }
            }
          } catch (prepErr) {
            console.warn('[TRELLIS] Preprocessing call warning (proceeding with raw image):', extractErrorMessage(prepErr));
          }

          let result: any;
          try {
            result = await client.predict('/generate_and_extract_glb', [
              fileForGeneration,
              [],
              null,
              params.seed ?? Math.floor(Math.random() * 2147483647),
              params.ssGuidance ?? 7.5,
              params.ssSteps ?? 12,
              params.slatGuidance ?? 3.0,
              params.slatSteps ?? 12,
              'stochastic',
              params.simplify ?? 0.95,
              params.textureSize ?? 1024,
            ]);
          } catch (predErr: any) {
            console.warn('[TRELLIS] Reconnecting and retrying prediction...', extractErrorMessage(predErr));
            client = await getTrellisClient(true, userToken);
            result = await client.predict('/generate_and_extract_glb', [
              fileForGeneration,
              [],
              null,
              params.seed ?? Math.floor(Math.random() * 2147483647),
              params.ssGuidance ?? 7.5,
              params.ssSteps ?? 12,
              params.slatGuidance ?? 3.0,
              params.slatSteps ?? 12,
              'stochastic',
              params.simplify ?? 0.95,
              params.textureSize ?? 1024,
            ]);
          }

          const data = result.data as any[];
          let videoData: any = null;
          let glbData: any = null;

          for (const item of data) {
            if (!item) continue;
            const resolved = resolveMediaUrl(item);
            if (resolved.endsWith('.mp4')) {
              videoData = resolved;
            } else if (resolved.endsWith('.glb') || resolved.endsWith('.gltf') || resolved.includes('.glb')) {
              glbData = resolved;
            }
          }

          const rawGlbUrl = typeof glbData === 'string' ? glbData : resolveMediaUrl(glbData);
          const rawVideoUrl = typeof videoData === 'string' ? videoData : resolveMediaUrl(videoData);

          const persistentGlbUrl = await persistMediaLocally(rawGlbUrl, 'trellis', userToken);
          const persistentVideoUrl = await persistMediaLocally(rawVideoUrl, 'trellis_preview', userToken);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, glbUrl: persistentGlbUrl, videoUrl: persistentVideoUrl, engine: engine }));
        } catch (err: any) {
          const errMsg = extractErrorMessage(err);
          console.error('[API /api/generate-3d] Error:', errMsg);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: errMsg }));
        }
      });
      return;
    }

    // 5. Character Animation Generation (NVIDIA Kimodo / SOMA Neural Motion Diffusion)
    if (req.url?.startsWith('/api/generate-motion') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          const prompt = (params.prompt || '').trim();
          if (!prompt) throw new Error('Prompt is required for Kimodo motion generation.');

          const token = (req.headers['x-hf-token'] as string) || params.hfToken || HF_TOKEN;
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (token) {
            headers['Authorization'] = `Bearer ${token}`;
          }

          // Forward the client's request as-is rather than rebuilding it from a
          // whitelist. The old whitelist (prompt, duration, seed, diffusion_steps,
          // constraints) silently dropped every field added later -- segments,
          // num_transition_frames, post_processing, root_margin -- so multi-text
          // reached the Space as just the main prompt. Only client-side fields are
          // stripped.
          const { hfToken: _hfToken, durationSeconds, actorId: _actorId, trajectoryMode: _trajectoryMode, ...forwarded } = params;
          const spaceBody = JSON.stringify({
            ...forwarded,
            prompt,
            duration: params.duration || durationSeconds || 4.0,
            diffusion_steps: params.diffusion_steps || 50,
            bvh_standard_tpose: params.bvh_standard_tpose ?? true,
          });

          const segmentCount = Array.isArray(params.segments) ? params.segments.length : 0;
          console.log(
            segmentCount > 0
              ? `[API /api/generate-motion] Calling Kimodo Stage (${KIMODO_SPACE}) with ${segmentCount} multi-text segments: ${params.segments.map((sg: any) => `"${sg.prompt}" (${sg.duration}s)`).join(' -> ')}`
              : `[API /api/generate-motion] Calling Kimodo Stage (${KIMODO_SPACE}) for prompt: "${prompt}"...`
          );

          // Call Kimodo FastAPI endpoint on Hugging Face Spaces
          let resp = await fetch(`${KIMODO_SPACE}/api/generate-motion`, {
            method: 'POST',
            headers,
            body: spaceBody,
          });

          // Fallback to /generate_motion if /api/generate-motion returns 404
          if (!resp.ok && resp.status === 404) {
            console.log('[API /api/generate-motion] Retrying with /generate_motion fallback...');
            resp = await fetch(`${KIMODO_SPACE}/generate_motion`, {
              method: 'POST',
              headers,
              body: spaceBody,
            });
          }

          if (!resp.ok) {
            const rawText = await resp.text();
            let errDetail = '';
            try {
              const errJson = JSON.parse(rawText);
              errDetail = errJson.detail || errJson.error || JSON.stringify(errJson);
            } catch {
              if (rawText.trim().startsWith('<')) {
                // HTML error page from Hugging Face Gateway (e.g. 502 Bad Gateway during container boot)
                try {
                  const statusCheck = await fetch('https://huggingface.co/api/spaces/dariushh/kimodo-virtual-stage', {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                  });
                  if (statusCheck.ok) {
                    const statusJson = (await statusCheck.json()) as any;
                    const stage = statusJson.runtime?.stage || 'STARTING';
                    errDetail = `Hugging Face Kimodo Space is currently in stage '${stage}'. Please wait ~1-2 minutes for the GPU container to finish booting and try again.`;
                  } else {
                    errDetail = `Hugging Face Space returned HTTP ${resp.status}. The container is currently booting up.`;
                  }
                } catch {
                  errDetail = `Hugging Face Space returned HTTP ${resp.status} (Container starting up).`;
                }
              } else {
                errDetail = rawText.slice(0, 300);
              }
            }
            throw new Error(errDetail || `Kimodo Space HTTP ${resp.status}`);
          }

          const result = (await resp.json()) as any;
          console.log(`[API /api/generate-motion] Kimodo generated ${result.num_frames || 0} frames at ${result.fps || 30} FPS!`);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (err: any) {
          console.error('[API /api/generate-motion] Error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
        }
      });
      return;
    }

    next();
  };
}
