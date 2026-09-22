import { WebSocketServer } from 'ws';
import { REMOTE_PASS_COOKIE, passForToken } from './lib/cameraPairing';
import { parseCookies, userForSession } from './lib/users';
import { SESSION_COOKIE } from './lib/users';

/**
 * Relay for the phone camera remote: every socket joins a room and whatever one peer sends is
 * forwarded to the others. Mounted on the dev server and on the production server alike.
 *
 * Who is allowed in. This used to be nobody's question: the relay accepted every connection and
 * fell back to a room literally called 'default' when none was named, which on a LAN meant "the
 * people in this building" and on the open internet means anyone who finds the URL - free rein
 * over whichever camera they land next to. Now:
 *
 *   the laptop joins with its ordinary session, because it is signed in anyway;
 *   the phone joins with a remote pass, which is good for one room and nothing else;
 *   an unnamed room is refused outright.
 */
/** Anything with an 'upgrade' event: node's http/https Server, or Vite's http2 dev server. */
type UpgradableServer = { on(event: 'upgrade', cb: (req: any, socket: any, head: any) => void): unknown };

/** Returns the room the caller may join, or null when they may not join at all. */
async function authorizeSocket(req: any, room: string): Promise<{ who: string } | null> {
  const cookies = parseCookies(req.headers?.cookie);

  // A signed-in account (the laptop running the studio).
  const user = await userForSession(cookies[SESSION_COOKIE]).catch(() => null);
  if (user) return { who: user.email || 'account' };

  // A paired device (the phone). The pass names the room; it cannot wander into another one.
  const pass = await passForToken(cookies[REMOTE_PASS_COOKIE]);
  if (pass && pass.room === room) return { who: 'paired device' };

  return null;
}

export function attachCameraRemoteWs(httpServer: UpgradableServer | null | undefined) {
  // Setup WebSocket relay for mobile camera controller
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map<string, Set<any>>();

  httpServer?.on('upgrade', (req, socket, head) => {
    (async () => {
      try {
        const parsedUrl = new URL(req.url || '', 'http://localhost:3000');
        if (parsedUrl.pathname !== '/ws/camera-remote') return;

        const room = parsedUrl.searchParams.get('room');
        if (!room) {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }

        const allowed = await authorizeSocket(req, room);
        if (!allowed) {
          console.warn(`[Camera Remote WS] refused an unauthenticated join of room ${room}`);
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          (ws as any).who = allowed.who;
          wss.emit('connection', ws, req);
        });
      } catch (err) {
        console.error('[WS Upgrade Error]', err);
        try { socket.destroy(); } catch (_) {}
      }
    })();
  });

  wss.on('connection', (ws: any, req) => {
    try {
      const parsedUrl = new URL(req.url || '', 'http://localhost:3000');
      // Guaranteed present: the upgrade handler refuses a socket without one.
      const roomId = parsedUrl.searchParams.get('room')!;
      const role = parsedUrl.searchParams.get('role') || 'remote';

      ws.roomId = roomId;
      ws.role = role;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }
      rooms.get(roomId)!.add(ws);

      console.log(`[Camera Remote WS] ${role} (${ws.who}) joined room ${roomId} (Total in room: ${rooms.get(roomId)!.size})`);

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
