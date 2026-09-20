import { Client } from '@gradio/client';
import { getHfToken } from './env';

export const TRELLIS_SPACE = 'https://dariushh-trellis-3d-engine.hf.space';
export const HUNYUAN_3D_SPACE = 'https://dariushh-hunyuan3d-2-engine.hf.space';
export const HUNYUAN_WORLD_SPACE = 'https://dariushh-hunyuanworld-engine.hf.space';
export const KIMODO_SPACE = 'https://dariushh-kimodo-virtual-stage.hf.space';
export const PANORAMA_360_SPACE = 'https://hugging-apps-krea2-360-panorama-lora.hf.space';

function getConnectOpts(token?: string) {
  const t = token || getHfToken();
  return t ? { hf_token: t as `hf_${string}` } : {};
}

let trellisClient: any = null;
let hunyuan3DClient: any = null;
let hunyuanWorldClient: any = null;
let kimodoClient: any = null;
let panoramaClient: any = null;

export async function getTrellisClient(forceFresh = false, token?: string) {
  if (!trellisClient || forceFresh || token) {
    console.log(`[ZeroGPU] Connecting to TRELLIS Engine at ${TRELLIS_SPACE}...`);
    const c = await Client.connect(TRELLIS_SPACE, getConnectOpts(token));
    if (!token) trellisClient = c;
    return c;
  }
  return trellisClient;
}

export async function getHunyuan3DClient(forceFresh = false, token?: string) {
  if (!hunyuan3DClient || forceFresh || token) {
    console.log(`[ZeroGPU] Connecting to Hunyuan3D Engine at ${HUNYUAN_3D_SPACE}...`);
    const c = await Client.connect(HUNYUAN_3D_SPACE, getConnectOpts(token));
    if (!token) hunyuan3DClient = c;
    return c;
  }
  return hunyuan3DClient;
}

export async function getHunyuanWorldClient(forceFresh = false, token?: string) {
  if (!hunyuanWorldClient || forceFresh || token) {
    console.log(`[ZeroGPU] Connecting to HunyuanWorld Engine at ${HUNYUAN_WORLD_SPACE}...`);
    const c = await Client.connect(HUNYUAN_WORLD_SPACE, getConnectOpts(token));
    if (!token) hunyuanWorldClient = c;
    return c;
  }
  return hunyuanWorldClient;
}

export async function getKimodoClient(forceFresh = false, token?: string) {
  if (!kimodoClient || forceFresh || token) {
    console.log(`[ZeroGPU] Connecting to Kimodo Stage at ${KIMODO_SPACE}...`);
    const c = await Client.connect(KIMODO_SPACE, getConnectOpts(token));
    if (!token) kimodoClient = c;
    return c;
  }
  return kimodoClient;
}

export async function getPanoramaClient(forceFresh = false, token?: string) {
  if (!panoramaClient || forceFresh || token) {
    console.log(`[ZeroGPU] Connecting to 360 Panorama at ${PANORAMA_360_SPACE}...`);
    const c = await Client.connect(PANORAMA_360_SPACE, getConnectOpts(token));
    if (!token) panoramaClient = c;
    return c;
  }
  return panoramaClient;
}
