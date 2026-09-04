import { defineConfig, loadEnv, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { Client, handle_file } from '@gradio/client';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const env = { ...process.env, ...loadEnv('', process.cwd(), '') };
const HF_TOKEN = env.HF_TOKEN || env.VITE_HF_TOKEN || '';
const TRELLIS_SPACE = 'https://dariushh-trellis-3d-engine.hf.space';
const HUNYUAN_3D_SPACE = 'https://dariushh-hunyuan3d-2-engine.hf.space';
const HUNYUAN_WORLD_SPACE = 'https://dariushh-hunyuanworld-engine.hf.space';
const KIMODO_SPACE = 'https://dariushh-kimodo-virtual-stage.hf.space';
const PANORAMA_360_SPACE = 'https://hugging-apps-krea2-360-panorama-lora.hf.space';

function getConnectOpts(token?: string) {
  const t = token || HF_TOKEN;
  return t ? { hf_token: t as `hf_${string}` } : {};
}

function extractErrorMessage(err: any): string {
  if (!err) return 'Unknown generation error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.title && err.message) return `${err.title}: ${err.message}`;
  if (err.title) return err.title;
  if (err.error) return typeof err.error === 'string' ? err.error : extractErrorMessage(err.error);
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

let trellisClient: any = null;
let hunyuan3DClient: any = null;
let hunyuanWorldClient: any = null;
let kimodoClient: any = null;
let panoramaClient: any = null;

async function getTrellisClient(forceFresh = false, token?: string) {
  if (!trellisClient || forceFresh || token) {
    console.log(`[ZeroGPU] Connecting to TRELLIS Engine at ${TRELLIS_SPACE}...`);
    const c = await Client.connect(TRELLIS_SPACE, getConnectOpts(token));
    if (!token) trellisClient = c;
    return c;
  }
  return trellisClient;
}

async function getHunyuan3DClient(forceFresh = false, token?: string) {
  if (!hunyuan3DClient || forceFresh || token) {
    console.log(`[ZeroGPU] Connecting to Hunyuan3D Engine at ${HUNYUAN_3D_SPACE}...`);
    const c = await Client.connect(HUNYUAN_3D_SPACE, getConnectOpts(token));
    if (!token) hunyuan3DClient = c;
    return c;
  }
  return hunyuan3DClient;
}

async function getHunyuanWorldClient(forceFresh = false, token?: string) {
  if (!hunyuanWorldClient || forceFresh || token) {
    console.log(`[ZeroGPU] Connecting to HunyuanWorld Engine at ${HUNYUAN_WORLD_SPACE}...`);
    const c = await Client.connect(HUNYUAN_WORLD_SPACE, getConnectOpts(token));
    if (!token) hunyuanWorldClient = c;
    return c;
  }
  return hunyuanWorldClient;
}

async function getKimodoClient(forceFresh = false, token?: string) {
  if (!kimodoClient || forceFresh || token) {
    console.log(`[ZeroGPU] Connecting to Kimodo Stage at ${KIMODO_SPACE}...`);
    const c = await Client.connect(KIMODO_SPACE, getConnectOpts(token));
    if (!token) kimodoClient = c;
    return c;
  }
  return kimodoClient;
}

async function getPanoramaClient(forceFresh = false, token?: string) {
  if (!panoramaClient || forceFresh || token) {
    console.log(`[ZeroGPU] Connecting to 360 Panorama at ${PANORAMA_360_SPACE}...`);
    const c = await Client.connect(PANORAMA_360_SPACE, getConnectOpts(token));
    if (!token) panoramaClient = c;
    return c;
  }
  return panoramaClient;
}

function normalizeGradioFileData(item: any): any {
  if (!item) return null;
  const path = item.path || item.value?.path || (typeof item === 'string' ? item : null);
  const url = item.url || item.value?.url || null;
  const orig_name = item.orig_name || item.value?.orig_name || (path ? path.split('/').pop() : 'mesh.glb');
  const mime_type = item.mime_type || item.value?.mime_type || 'model/gltf-binary';
  return {
    path: path,
    url: url,
    orig_name: orig_name,
    mime_type: mime_type,
    meta: {
      _type: 'gradio.FileData',
    },
  };
}

function resolveMediaUrl(item: any): string {
  if (!item) return '';
  if (typeof item === 'string') return item;
  if (item.url) return item.url;
  if (item.video?.url) return item.video.url;
  if (item.value) {
    if (typeof item.value === 'string') return item.value;
    if (item.value.url) return item.value.url;
    if (item.value.path) return item.value.path;
  }
  if (item.path) return item.path;
  return '';
}

function apiMiddlewarePlugin(): Plugin {
  return {
    name: 'api-middleware',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
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

              const primarySplat = gaussianSplatUrl || gaussianPlyUrl || resolveMediaUrl(data[0]);

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

              console.log('[Pipeline Complete!] 360° Panorama:', panoramaUrl, '3D Scene Mesh:', glbUrl);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                success: true,
                panoramaUrl,
                glbUrl,
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

              let imageBase64: string | null = null;

              // 1. Try Gemini Multimodal / Image Generation if API key is present
              if (geminiKey) {
                // Method A: Gemini generateContent with IMAGE output modality
                try {
                  console.log(`[API /api/generate-image] Attempting Gemini ${model}:generateContent with pure black background isolate...`);
                  const genRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      contents: [
                        {
                          parts: [
                            { text: `Generate a single isolated 3D prop asset: ${prompt}. The object must be floating in the center on a pure solid pitch black background (#000000). Absolutely no floor, no ground, no shadow on ground, no table, no room, no walls, no environment. Only the standalone 3D object completely isolated against a black void background, photorealistic, crisp sharp edges, 8k resolution, cinematic studio lighting.` }
                          ]
                        }
                      ],
                      generationConfig: {
                        responseModalities: ["IMAGE", "TEXT"]
                      }
                    }),
                  });

                  if (genRes.ok) {
                    const genData = await genRes.json();
                    const candidates = genData.candidates || [];
                    for (const cand of candidates) {
                      const parts = cand.content?.parts || [];
                      for (const part of parts) {
                        if (part.inlineData?.data) {
                          const mime = part.inlineData.mimeType || 'image/png';
                          imageBase64 = `data:${mime};base64,${part.inlineData.data}`;
                          console.log(`[API /api/generate-image] Successfully generated image via Gemini ${model}!`);
                          break;
                        }
                      }
                      if (imageBase64) break;
                    }
                  } else {
                    const errTxt = await genRes.text();
                    console.warn(`[Gemini ${model} generateContent failed]:`, errTxt);
                  }
                } catch (gErr) {
                  console.warn(`[Gemini ${model} call error]:`, gErr);
                }

                // Method B: Try Imagen 3.0 predict if generateContent was not available
                if (!imageBase64) {
                  try {
                    console.log('[API /api/generate-image] Attempting imagen-3.0-generate-002:predict with black background isolate...');
                    const imgPayload = {
                      instances: [{ prompt: `${prompt}, single 3D prop asset centered, floating isolated on pure solid pitch black background (#000000), no floor, no ground plane, no shadow underneath, no table, no room, no walls, clean sharp silhouette, photorealistic, 8k resolution, octane render.` }],
                      parameters: { sampleCount: 1, aspectRatio: '1:1', outputMimeType: 'image/png' },
                    };
                    const resG = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${geminiKey}`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(imgPayload),
                    });
                    if (resG.ok) {
                      const j = await resG.json();
                      const b64 = j.predictions?.[0]?.bytesBase64Encoded;
                      if (b64) {
                        imageBase64 = `data:image/png;base64,${b64}`;
                        console.log('[API /api/generate-image] Successfully generated image via Imagen-3.0!');
                      }
                    }
                  } catch (gErr) {
                    console.warn('[Gemini Imagen failed]:', gErr);
                  }
                }
              }

              // 2. High-speed, high-quality Pollinations Flux / Turbo engine fallback
              if (!imageBase64) {
                console.log('[API /api/generate-image] Using Pollinations fast rendering engine fallback (black background isolate)...');
                const encodedPrompt = encodeURIComponent(`${prompt}, single isolated 3d asset centered, floating on pure solid pitch black background, no floor, no ground, no table, no room, no walls, studio object isolate, sharp edges, octane render 8k`);
                const seed = Math.floor(Math.random() * 1000000);
                const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`;
                const fetchRes = await fetch(pollinationsUrl);
                if (!fetchRes.ok) throw new Error(`Image generator returned ${fetchRes.status}`);
                const arrayBuf = await fetchRes.arrayBuffer();
                const b64 = Buffer.from(arrayBuf).toString('base64');
                imageBase64 = `data:image/png;base64,${b64}`;
              }

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                success: true,
                imageBase64,
                prompt,
                model: geminiKey ? (model || 'imagen-3.0-generate-002') : 'pollinations-flux'
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

                console.log('[Hunyuan3D] Final Textured Model URL:', glbUrl);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, glbUrl, engine: 'hunyuan3d' }));
                return;
              }

              // Route 2: TRELLIS Neural Engine
              if (!fileToPass) {
                throw new Error('Please upload an image to generate a 3D model with TRELLIS.');
              }

              let client = await getTrellisClient(false, userToken);
              let result: any;
              try {
                result = await client.predict('/generate_and_extract_glb', [
                  fileToPass,
                  [],
                  null,
                  params.seed ?? Math.floor(Math.random() * 2147483647),
                  params.ssGuidance ?? 7.5,
                  params.ssSteps ?? 12,
                  params.slatGuidance ?? 3.0,
                  params.slatSteps ?? 12,
                  'stochastic',
                  params.simplify ?? 0.98,
                  params.textureSize ?? 1024,
                ]);
              } catch (predErr: any) {
                console.warn('[TRELLIS] Reconnecting and retrying prediction...', extractErrorMessage(predErr));
                client = await getTrellisClient(true, userToken);
                result = await client.predict('/generate_and_extract_glb', [
                  fileToPass,
                  [],
                  null,
                  params.seed ?? Math.floor(Math.random() * 2147483647),
                  params.ssGuidance ?? 7.5,
                  params.ssSteps ?? 12,
                  params.slatGuidance ?? 3.0,
                  params.slatSteps ?? 12,
                  'stochastic',
                  params.simplify ?? 0.98,
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

              const glbUrl = typeof glbData === 'string' ? glbData : resolveMediaUrl(glbData);
              const videoUrl = typeof videoData === 'string' ? videoData : resolveMediaUrl(videoData);

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, glbUrl, videoUrl, engine: engine }));
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

              console.log(`[API /api/generate-motion] Calling Kimodo Stage on ZeroGPU (${KIMODO_SPACE}/api/generate-motion) for prompt: "${prompt}"...`);

              // Call Kimodo FastAPI endpoint on Hugging Face Spaces
              let resp = await fetch(`${KIMODO_SPACE}/api/generate-motion`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  prompt,
                  duration: params.duration || params.durationSeconds || 4.0,
                  seed: params.seed,
                  diffusion_steps: params.diffusion_steps || 50,
                  bvh_standard_tpose: true,
                }),
              });

              // Fallback to /generate_motion if /api/generate-motion returns 404
              if (!resp.ok && resp.status === 404) {
                console.log('[API /api/generate-motion] Retrying with /generate_motion fallback...');
                resp = await fetch(`${KIMODO_SPACE}/generate_motion`, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({
                    prompt,
                    duration: params.duration || params.durationSeconds || 4.0,
                    seed: params.seed,
                    diffusion_steps: params.diffusion_steps || 50,
                    bvh_standard_tpose: true,
                  }),
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
                        const statusJson = await statusCheck.json();
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

              const result = await resp.json();
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
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiMiddlewarePlugin()],
  server: {
    port: 3000,
    host: true,
  },
});
