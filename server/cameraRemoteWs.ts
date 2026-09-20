import { WebSocketServer } from 'ws';

/**
 * Relay for the phone camera remote: every socket joins a room and whatever one peer sends is
 * forwarded to the others. Mounted on the dev server and on the production server alike.
 */
/** Anything with an 'upgrade' event: node's http/https Server, or Vite's http2 dev server. */
type UpgradableServer = { on(event: 'upgrade', cb: (req: any, socket: any, head: any) => void): unknown };

export function attachCameraRemoteWs(httpServer: UpgradableServer | null | undefined) {
  // Setup WebSocket relay for mobile camera controller
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map<string, Set<any>>();

  httpServer?.on('upgrade', (req, socket, head) => {
    try {
      const parsedUrl = new URL(req.url || '', 'http://localhost:3000');
      if (parsedUrl.pathname === '/ws/camera-remote') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      }
    } catch (err) {
      console.error('[WS Upgrade Error]', err);
    }
  });

  wss.on('connection', (ws: any, req) => {
    try {
      const parsedUrl = new URL(req.url || '', 'http://localhost:3000');
      const roomId = parsedUrl.searchParams.get('room') || 'default';
      const role = parsedUrl.searchParams.get('role') || 'remote';

      ws.roomId = roomId;
      ws.role = role;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }
      rooms.get(roomId)!.add(ws);

      console.log(`[Camera Remote WS] ${role} joined room ${roomId} (Total in room: ${rooms.get(roomId)!.size})`);

      const notifyPayload = JSON.stringify({
        type: 'peer_joined',
        role,
        peerCount: rooms.get(roomId)!.size,
        timestamp: Date.now(),
      });

      for (const client of rooms.get(roomId)!) {
        if (client.readyState === 1) {
          client.send(notifyPayload);
        }
      }

      ws.on('message', (data: any, isBinary: boolean) => {
        const clientSet = rooms.get(roomId);
        if (clientSet) {
          for (const client of clientSet) {
            if (client !== ws && client.readyState === 1) {
              client.send(data, { binary: isBinary });
            }
          }
        }
      });

      ws.on('close', () => {
        const clientSet = rooms.get(roomId);
        if (clientSet) {
          clientSet.delete(ws);
          console.log(`[Camera Remote WS] ${role} left room ${roomId} (Remaining: ${clientSet.size})`);
          if (clientSet.size === 0) {
            rooms.delete(roomId);
          } else {
            const leavePayload = JSON.stringify({
              type: 'peer_left',
              role,
              peerCount: clientSet.size,
              timestamp: Date.now(),
            });
            for (const client of clientSet) {
              if (client.readyState === 1) {
                client.send(leavePayload);
              }
            }
          }
        }
      });
    } catch (wsErr) {
      console.error('[Camera Remote WS Connection Error]', wsErr);
    }
  });
}
