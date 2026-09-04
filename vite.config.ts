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

const connectOpts = HF_TOKEN ? { hf_token: HF_TOKEN as `hf_${string}` } : {};

let trellisClient: any = null;
let hunyuan3DClient: any = null;
let hunyuanWorldClient: any = null;
let kimodoClient: any = null;
let panoramaClient: any = null;

async function getTrellisClient(forceFresh = false) {
  if (!trellisClient || forceFresh) {
    console.log(`[ZeroGPU] Connecting to TRELLIS Engine at ${TRELLIS_SPACE}...`);
    trellisClient = await Client.connect(TRELLIS_SPACE, connectOpts);
  }
  return trellisClient;
}

async function getHunyuan3DClient(forceFresh = false) {
  if (!hunyuan3DClient || forceFresh) {
    console.log(`[ZeroGPU] Connecting to Hunyuan3D Engine at ${HUNYUAN_3D_SPACE}...`);
    hunyuan3DClient = await Client.connect(HUNYUAN_3D_SPACE, connectOpts);
  }
  return hunyuan3DClient;
}

async function getHunyuanWorldClient(forceFresh = false) {
  if (!hunyuanWorldClient || forceFresh) {
    console.log(`[ZeroGPU] Connecting to HunyuanWorld Engine at ${HUNYUAN_WORLD_SPACE}...`);
    hunyuanWorldClient = await Client.connect(HUNYUAN_WORLD_SPACE, connectOpts);
  }
  return hunyuanWorldClient;
}

async function getKimodoClient(forceFresh = false) {
  if (!kimodoClient || forceFresh) {
    console.log(`[ZeroGPU] Connecting to Kimodo Stage at ${KIMODO_SPACE}...`);
    kimodoClient = await Client.connect(KIMODO_SPACE, connectOpts);
  }
  return kimodoClient;
}

async function getPanoramaClient(forceFresh = false) {
  if (!panoramaClient || forceFresh) {
    console.log(`[ZeroGPU] Connecting to 360 Panorama at ${PANORAMA_360_SPACE}...`);
    panoramaClient = await Client.connect(PANORAMA_360_SPACE, connectOpts);
  }
  return panoramaClient;
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
                for (let i = data.length - 1; i >= 0; i--) {
                  const resolved = resolveMediaUrl(data[i]);
                  if (resolved && !resolved.endsWith('.mp4') && (resolved.endsWith('.glb') || resolved.includes('.glb'))) {
                    glbUrl = resolved;
                    break;
                  }
                }
                if (!glbUrl) glbUrl = resolveMediaUrl(data[1]) || resolveMediaUrl(data[0]);
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

        // 4. 3D Model & Prop Generation (TRELLIS & Hunyuan3D-2.0)
        if (req.url?.startsWith('/api/generate-3d') && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const params = JSON.parse(body);
              const engine = params.engine || 'trellis';
              console.log(`[API /api/generate-3d] Generating 3D with engine: ${engine}...`);

              let fileToPass: any = null;
              const tmpDir = os.tmpdir();

              if (params.imageBase64) {
                const base64Data = params.imageBase64.includes(',')
                  ? params.imageBase64.split(',')[1]
                  : params.imageBase64;
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
                let client = await getHunyuan3DClient();
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
                  console.warn('[Hunyuan3D] Reconnecting and retrying prediction...', predErr.message);
                  client = await getHunyuan3DClient(true);
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
                for (let i = data.length - 1; i >= 0; i--) {
                  const resolved = resolveMediaUrl(data[i]);
                  if (resolved && !resolved.endsWith('.mp4') && (resolved.endsWith('.glb') || resolved.includes('.glb'))) {
                    glbUrl = resolved;
                    break;
                  }
                }
                if (!glbUrl) glbUrl = resolveMediaUrl(data[1]) || resolveMediaUrl(data[0]);

                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, glbUrl, engine: 'hunyuan3d' }));
                return;
              }

              // Route 2: TRELLIS Neural Engine
              if (!fileToPass) {
                throw new Error('Please upload an image to generate a 3D model with TRELLIS.');
              }

              let client = await getTrellisClient();
              let result: any;
              try {
                result = await client.predict('/generate_and_extract_glb', [
                  fileToPass,
                  [],
                  false,
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
                console.warn('[TRELLIS] Reconnecting and retrying prediction...', predErr.message);
                client = await getTrellisClient(true);
                result = await client.predict('/generate_and_extract_glb', [
                  fileToPass,
                  [],
                  false,
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
              console.error('[API /api/generate-3d] Error:', err);
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
            }
          });
          return;
        }

        // 5. Character Animation Generation (Kimodo / SOMA-X)
        if (req.url?.startsWith('/api/generate-motion') && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const params = JSON.parse(body);
              const client = await getKimodoClient();
              const result = await client.predict('/predict', [params.prompt]);
              const data = result.data as any[];
              const bvhUrl = typeof data[0] === 'string' ? data[0] : data[0]?.url;

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, bvhUrl, animationName: params.prompt }));
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
