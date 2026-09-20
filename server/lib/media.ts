import fs from 'node:fs';
import path from 'node:path';

export function normalizeGradioFileData(item: any): any {
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

export function resolveMediaUrl(item: any): string {
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

export async function persistMediaLocally(
  remoteUrl: string,
  prefix: string,
  userToken?: string
): Promise<string> {
  if (!remoteUrl) return '';
  if (remoteUrl.startsWith('/api/assets/') || (!remoteUrl.startsWith('http://') && !remoteUrl.startsWith('https://'))) {
    return remoteUrl;
  }

  try {
    const assetsDir = path.join(process.cwd(), 'data', 'assets');
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }

    const headers: Record<string, string> = {};
    if (userToken) {
      headers['Authorization'] = `Bearer ${userToken}`;
    }

    const res = await fetch(remoteUrl, { headers });
    if (!res.ok) {
      console.warn(`[Asset Cache] Failed to download remote asset from ${remoteUrl} (HTTP ${res.status})`);
      return remoteUrl;
    }

    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.length === 0) return remoteUrl;

    let ext = '.glb';
    const lower = remoteUrl.toLowerCase();
    if (lower.includes('.mp4')) ext = '.mp4';
    else if (lower.includes('.png')) ext = '.png';
    else if (lower.includes('.jpg') || lower.includes('.jpeg')) ext = '.jpg';
    else if (lower.includes('.splat')) ext = '.splat';
    else if (lower.includes('.ply')) ext = '.ply';
    else if (lower.includes('.gltf')) ext = '.gltf';
    else if (lower.includes('.glb')) ext = '.glb';

    const cleanPrefix = prefix.replace(/[^a-zA-Z0-9_]/g, '_');
    const filename = `${cleanPrefix}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`;
    const localPath = path.join(assetsDir, filename);

    fs.writeFileSync(localPath, buf);
    console.log(`[Asset Cache] ✓ Permanently cached ${prefix} to disk: ${localPath} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
    return `/api/assets/${filename}`;
  } catch (err) {
    console.warn(`[Asset Cache] Could not cache remote asset ${remoteUrl}:`, err);
    return remoteUrl;
  }
}
