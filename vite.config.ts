import { defineConfig, loadEnv, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { configureEnv } from './server/lib/env';
import { createApiMiddleware } from './server/api';
import { attachCameraRemoteWs } from './server/cameraRemoteWs';

// The API itself lives in server/, so the dev server and the production server run the same code.
configureEnv(loadEnv('', process.cwd(), ''));

function apiMiddlewarePlugin(): Plugin {
  return {
    name: 'api-middleware',
    configureServer(server) {
      // The phone remote's motion sensors are secure-context only, so the dev server runs over
      // TLS and every URL we hand out has to match the scheme it is actually served on.
      const scheme = server.config.server.https ? 'https' : 'http';
      const devPort = server.config.server.port ?? 3000;

      attachCameraRemoteWs(server.httpServer);
      server.middlewares.use(createApiMiddleware({ scheme, port: devPort }));
    },
  };
}

export default defineConfig({
  // basicSsl serves the dev server over TLS. DeviceOrientationEvent, DeviceMotionEvent and the
  // Generic Sensor API are all gated behind a secure context, so the phone remote's gyro cannot
  // work at all when the LAN pairing URL is plain http://.
  plugins: [react(), basicSsl(), apiMiddlewarePlugin()],
  server: {
    port: 3000,
    strictPort: true,
    host: true,
    allowedHosts: true,
    // With TLS on, Vite only builds a plain HTTP/1.1 server when `server.proxy` is set; otherwise
    // it builds an http2 server. The camera-remote relay is a plain `ws` upgrade, which HTTP/2 has
    // no route for, so this empty proxy map keeps the server on HTTP/1.1 and leaves the WebSocket
    // handshake exactly as it was before TLS. basicSsl supplies server.https (cert + key).
    proxy: {},
  },
  resolve: {
    dedupe: ['@react-three/fiber', '@react-three/drei', 'three', 'react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['@react-three/fiber', '@react-three/drei', 'three', 'react', 'react-dom'],
  },
});
