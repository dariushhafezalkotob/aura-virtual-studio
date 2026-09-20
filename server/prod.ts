/**
 * Production server.
 *
 * It mounts exactly the same API middleware and WebSocket relay that the Vite dev server mounts,
 * and serves the built frontend from dist/. There is no second copy of any route: if it works in
 * `npm run dev`, it works here.
 *
 *   npm run build      -> dist/ (frontend) + dist-server/prod.mjs (this file, bundled)
 *   npm start          -> runs it
 *
 * Environment: PORT (default 3000), PUBLIC_SCHEME (default https - the phone remote's gyro needs a
 * secure context), plus the same GEMINI_API_KEY / HF_TOKEN the dev server reads.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApiMiddleware } from './api';
import { attachCameraRemoteWs } from './cameraRemoteWs';

const PORT = Number(process.env.PORT || 3000);
const SCHEME = process.env.PUBLIC_SCHEME || 'https';
const DIST = path.resolve(process.cwd(), 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.splat': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

const api = createApiMiddleware({ scheme: SCHEME, port: PORT });

function sendFile(res: http.ServerResponse, filePath: string, immutable: boolean) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  // Vite fingerprints everything under /assets, so those can be cached hard; index.html cannot.
  res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  api(req, res, () => {
    // Not an API route: serve the built frontend, falling back to index.html for client routing.
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const candidate = path.join(DIST, urlPath);

    // Keep the response inside dist/ even if the URL contains ../
    if (!candidate.startsWith(DIST)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    if (urlPath !== '/' && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      sendFile(res, candidate, urlPath.startsWith('/assets/'));
      return;
    }

    const indexHtml = path.join(DIST, 'index.html');
    if (!fs.existsSync(indexHtml)) {
      res.statusCode = 500;
      res.end('dist/index.html is missing - run `npm run build` first.');
      return;
    }
    sendFile(res, indexHtml, false);
  });
});

attachCameraRemoteWs(server);

server.listen(PORT, () => {
  console.log(`[aura] serving dist/ and the API on port ${PORT} (public scheme: ${SCHEME})`);
});
