import * as THREE from 'three';
import {
  CameraRemoteMessage,
  DeviceOrientationData,
  RemoteMoveData,
  CameraRemoteState,
  CameraPoseData,
  Project,
} from '../types';

const DEG_TO_RAD = Math.PI / 180;
const ZEE = new THREE.Vector3(0, 0, 1);
const Q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X

/**
 * Calculates a Three.js Quaternion from standard mobile DeviceOrientationEvent angles,
 * properly accounting for landscape mode (90° / -90° screen orientation).
 */
export function computeDeviceQuaternion(
  alpha: number,
  beta: number,
  gamma: number,
  screenOrientation: number = 90
): THREE.Quaternion {
  const euler = new THREE.Euler();
  const q0 = new THREE.Quaternion();
  const quat = new THREE.Quaternion();

  // In landscape mode, screen orientation is typically 90 or -90 deg
  const _alpha = alpha ? alpha * DEG_TO_RAD : 0;
  const _beta = beta ? beta * DEG_TO_RAD : 0;
  const _gamma = gamma ? gamma * DEG_TO_RAD : 0;
  const _orient = screenOrientation ? screenOrientation * DEG_TO_RAD : 0;

  euler.set(_beta, _alpha, -_gamma, 'YXZ');
  quat.setFromEuler(euler);
  quat.multiply(Q1); // device points out back
  quat.multiply(q0.setFromAxisAngle(ZEE, -_orient));

  return quat;
}

export type MessageHandler = (msg: CameraRemoteMessage) => void;
export type StatusHandler = (connected: boolean, peerCount: number) => void;

export class CameraRemoteSocket {
  private ws: WebSocket | null = null;
  private url: string;
  public readonly role: 'host' | 'remote';
  public readonly roomId: string;
  private messageHandlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private reconnectTimer: any = null;
  private pingInterval: any = null;
  private isDestroyed: boolean = false;
  private peerCount: number = 0;

  constructor(role: 'host' | 'remote', roomId: string, customHost?: string) {
    this.role = role;
    this.roomId = roomId;

    const loc = window.location;
    const isHttps = loc.protocol === 'https:';
    const proto = isHttps ? 'wss:' : 'ws:';
    const host = customHost || loc.host;

    this.url = `${proto}//${host}/ws/camera-remote?role=${role}&room=${encodeURIComponent(roomId)}`;
    this.connect();
  }

  public connect() {
    if (this.isDestroyed) return;
    try {
      if (this.ws) {
        this.ws.close();
      }

      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.notifyStatus(true, this.peerCount);
        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        try {
          const data: CameraRemoteMessage = JSON.parse(event.data);
          if (data.type === 'peer_joined' || data.type === 'peer_left') {
            this.peerCount = data.peerCount;
            this.notifyStatus(this.isConnected(), this.peerCount);
          }
          this.messageHandlers.forEach((handler) => handler(data));
        } catch (_) {}
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();
        this.notifyStatus(false, 0);
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        try {
          this.ws?.close();
        } catch (_) {}
      };
    } catch (_) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.isDestroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.isConnected()) {
        try {
          this.ws?.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        } catch (_) {}
      }
    }, 12000);
  }

  private stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  public onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.isConnected(), this.peerCount);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  private notifyStatus(connected: boolean, count: number) {
    this.statusHandlers.forEach((handler) => handler(connected, count));
  }

  public send(msg: CameraRemoteMessage) {
    if (this.isConnected()) {
      try {
        this.ws?.send(JSON.stringify(msg));
      } catch (_) {}
    }
  }

  public sendGyro(orientation: DeviceOrientationData) {
    this.send({
      type: 'gyro',
      orientation,
      timestamp: performance.now(),
    });
  }

  public sendMove(move: RemoteMoveData) {
    this.send({
      type: 'move',
      move,
      timestamp: performance.now(),
    });
  }

  public sendLook(deltaPitch: number, deltaYaw: number) {
    this.send({
      type: 'look',
      deltaPitch,
      deltaYaw,
      timestamp: performance.now(),
    });
  }

  public sendToggleRecord() {
    this.send({ type: 'toggle_record' });
  }

  public sendFocalLength(focalLength: string) {
    this.send({ type: 'set_focal_length', focalLength });
  }

  public sendCalibrate() {
    this.send({ type: 'calibrate' });
  }

  public sendRewind() {
    this.send({ type: 'rewind' });
  }

  public sendTogglePlay() {
    this.send({ type: 'toggle_play' });
  }

  public sendInitScene(project: Project) {
    this.send({ type: 'init_scene', project });
  }

  public sendCameraPose(pose: CameraPoseData) {
    this.send({
      type: 'camera_pose',
      pose,
      timestamp: performance.now(),
    });
  }

  public sendHostState(state: CameraRemoteState) {
    this.send({ type: 'host_state', state });
  }

  public destroy() {
    this.isDestroyed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.close();
        } else if (this.ws.readyState === WebSocket.CONNECTING) {
          const wsToClose = this.ws;
          wsToClose.onopen = () => {
            try { wsToClose.close(); } catch (_) {}
          };
        }
      } catch (_) {}
      this.ws = null;
    }
    this.messageHandlers.clear();
    this.statusHandlers.clear();
  }
}
