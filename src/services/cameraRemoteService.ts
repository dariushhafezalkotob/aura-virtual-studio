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
const Q_EARTH_TO_THREE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const V_Z = new THREE.Vector3(0, 0, 1);
const V_X = new THREE.Vector3(1, 0, 0);
const V_Y = new THREE.Vector3(0, 1, 0);

/**
 * Calculates a Three.js Quaternion from standard mobile DeviceOrientationEvent angles,
 * using intrinsic W3C rotation order (Z -> X -> Y) to completely avoid Euler gimbal lock,
 * and properly mapping screen orientation for 16:9 landscape mode.
 */
export function computeDeviceQuaternion(
  alpha: number,
  beta: number,
  gamma: number,
  screenOrientation: number = 90
): THREE.Quaternion {
  const _alpha = (alpha || 0) * DEG_TO_RAD;
  const _beta = (beta || 0) * DEG_TO_RAD;
  const _gamma = (gamma || 0) * DEG_TO_RAD;
  const _orient = (screenOrientation || 90) * DEG_TO_RAD;

  // Intrinsic W3C spec rotations: Z (alpha), X (beta), Y (gamma)
  const qAlpha = new THREE.Quaternion().setFromAxisAngle(V_Z, _alpha);
  const qBeta = new THREE.Quaternion().setFromAxisAngle(V_X, _beta);
  const qGamma = new THREE.Quaternion().setFromAxisAngle(V_Y, _gamma);

  const qDevice = qAlpha.multiply(qBeta).multiply(qGamma);

  // Transform from Earth frame (Z-up) to Three.js world frame (Y-up):
  const qChassisWorld = Q_EARTH_TO_THREE.clone().multiply(qDevice);

  // Adjust for screen orientation in landscape mode:
  const qCameraFrame = new THREE.Quaternion().setFromAxisAngle(V_Z, -_orient);

  return qChassisWorld.multiply(qCameraFrame);
}

export type MessageHandler = (msg: CameraRemoteMessage) => void;
export type StatusHandler = (connected: boolean, peerCount: number) => void;

/** What the link is doing right now, for the HUD and for judging any change to it. */
export interface LinkStats {
  /** 'direct' once the phone and laptop are talking to each other without the server. */
  transport: 'direct' | 'relay' | 'offline';
  /** Round trip in ms over whichever transport is carrying traffic, or null before the first reply. */
  rttMs: number | null;
  /** Samples thrown away because the link was still busy with the previous one. */
  dropped: number;
}
export type StatsHandler = (stats: LinkStats) => void;

/**
 * Messages safe to throw away when the link is congested.
 *
 * These are streams: each one supersedes the last, so a stale sample is worth less than nothing -
 * it arrives late and moves the camera somewhere it no longer points. Everything else (record,
 * rewind, focal length, the scene itself) happens once and must not be dropped.
 */
const DROPPABLE: ReadonlySet<string> = new Set(['gyro', 'move', 'look', 'camera_pose']);

/** Past this many bytes still waiting, the link is behind and new samples are pointless. */
const BACKPRESSURE_BYTES = 2048;

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

  // The direct link. The relay stays connected underneath it: it carries the handshake, it is the
  // fallback if the direct link never forms, and it is how we notice the peer coming and going.
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private statsHandlers: Set<StatsHandler> = new Set();
  private rttMs: number | null = null;
  private dropped: number = 0;
  private negotiating: boolean = false;
  /**
   * Candidates that arrived before we had a description to attach them to.
   *
   * The relay delivers the offer and the first candidates back to back, and answering is async, so
   * candidates routinely turn up mid-await. addIceCandidate throws in that state; without this
   * queue they were swallowed by the catch and the connection simply never had a route to try.
   */
  private pendingIce: any[] = [];

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
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.notifyStatus(true, this.peerCount);
        this.startHeartbeat();
      };

      this.ws.onmessage = async (event) => {
        try {
          let rawText: string;
          if (typeof event.data === 'string') {
            rawText = event.data;
          } else if (event.data instanceof ArrayBuffer) {
            rawText = new TextDecoder().decode(event.data);
          } else if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
            rawText = await event.data.text();
          } else {
            rawText = String(event.data);
          }
          const data: CameraRemoteMessage = JSON.parse(rawText);
          if (data.type === 'peer_joined' || data.type === 'peer_left') {
            this.peerCount = data.peerCount;
            this.notifyStatus(this.isConnected(), this.peerCount);
            // The laptop opens the direct link when the phone arrives, and tears it down when it
            // leaves so a reconnecting phone negotiates afresh rather than inheriting a dead one.
            if (data.type === 'peer_joined' && this.role === 'host' && data.role === 'remote') {
              this.startDirectLink();
            }
            if (data.type === 'peer_left') {
              this.closeDirectLink();
            }
          }
          if (this.handleTransportMessage(data)) return;
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

  // ----------------------------------------------------------------------------------
  // The direct link
  //
  // Phone and laptop are on the same WiFi on set, so they can talk to each other across the room
  // instead of sending every gyro sample to the server and back. That matters more now than it
  // ever did locally: the server is in another country, and a round trip there is the difference
  // between a camera you aim and a camera that follows you a moment later.
  //
  // No ICE servers are configured on purpose. Browsers find each other on a shared network by
  // themselves (host candidates, with the local address hidden behind mDNS), so there is nothing
  // external to depend on, nothing to pay for, and no address handed to a third party. Two devices
  // on different networks simply never connect, and everything keeps flowing over the relay.
  //
  // The channel is unreliable and unordered on purpose too: a late gyro sample is worse than a
  // missing one, and TCP's insistence on delivering everything in order is what made a brief WiFi
  // stall arrive as a burst of stale poses.
  // ----------------------------------------------------------------------------------

  private newPeerConnection(): RTCPeerConnection | null {
    if (typeof RTCPeerConnection === 'undefined') return null;
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = (e) => {
      if (e.candidate) this.sendOverRelay({ type: 'rtc_ice', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.closeDirectLink();
      }
    };
    return pc;
  }

  private attachDataChannel(dc: RTCDataChannel) {
    this.dc = dc;
    dc.onopen = () => this.notifyStats();
    dc.onclose = () => {
      if (this.dc === dc) this.dc = null;
      this.notifyStats();
    };
    dc.onerror = () => {
      if (this.dc === dc) this.dc = null;
      this.notifyStats();
    };
    dc.onmessage = (event) => {
      try {
        const msg: CameraRemoteMessage = JSON.parse(String(event.data));
        if (this.handleTransportMessage(msg)) return;
        this.messageHandlers.forEach((handler) => handler(msg));
      } catch (_) {}
    };
  }

  private async startDirectLink() {
    if (this.isDestroyed || this.negotiating || this.isDirect()) return;
    const pc = this.newPeerConnection();
    if (!pc) return;

    this.negotiating = true;
    this.pc = pc;
    try {
      this.attachDataChannel(pc.createDataChannel('camera', { ordered: false, maxRetransmits: 0 }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendOverRelay({ type: 'rtc_offer', sdp: pc.localDescription });
    } catch (_) {
      this.closeDirectLink();
    } finally {
      this.negotiating = false;
    }
  }

  /** Returns true when the message was the transport's own business and the app must not see it. */
  private handleTransportMessage(msg: CameraRemoteMessage): boolean {
    switch (msg.type) {
      case 'ping':
        // Echo the sender's own clock back so only their clock is ever used for the maths.
        this.sendRaw({ type: 'pong', timestamp: (msg as any).timestamp });
        return true;

      case 'pong': {
        const sent = (msg as any).timestamp;
        if (typeof sent === 'number') {
          this.rttMs = Math.max(0, Math.round(performance.now() - sent));
          this.notifyStats();
        }
        return true;
      }

      case 'rtc_offer':
        void this.acceptOffer((msg as any).sdp);
        return true;

      case 'rtc_answer':
        void (async () => {
          try {
            await this.pc?.setRemoteDescription((msg as any).sdp);
            await this.drainPendingIce();
          } catch (_) {}
        })();
        return true;

      case 'rtc_ice':
        void this.addIceCandidate((msg as any).candidate);
        return true;

      default:
        return false;
    }
  }

  private async acceptOffer(sdp: any) {
    if (this.isDestroyed) return;
    try {
      this.closeDirectLink();
      const pc = this.newPeerConnection();
      if (!pc) return;
      this.pc = pc;
      pc.ondatachannel = (e) => this.attachDataChannel(e.channel);
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sendOverRelay({ type: 'rtc_answer', sdp: pc.localDescription });
      await this.drainPendingIce();
    } catch (_) {
      this.closeDirectLink();
    }
  }

  /** Holds a candidate until there is a remote description to hang it on, then adds it. */
  private async addIceCandidate(candidate: any) {
    if (!candidate) return;
    if (!this.pc || !this.pc.remoteDescription) {
      this.pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (_) {}
  }

  private async drainPendingIce() {
    if (!this.pc || !this.pc.remoteDescription) return;
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (_) {}
    }
  }

  private closeDirectLink() {
    this.pendingIce = [];
    try { this.dc?.close(); } catch (_) {}
    try { this.pc?.close(); } catch (_) {}
    this.dc = null;
    this.pc = null;
    this.rttMs = null;
    this.notifyStats();
  }

  public isDirect(): boolean {
    return this.dc !== null && this.dc.readyState === 'open';
  }

  public getStats(): LinkStats {
    return {
      transport: this.isDirect() ? 'direct' : this.isConnected() ? 'relay' : 'offline',
      rttMs: this.rttMs,
      dropped: this.dropped,
    };
  }

  public onStats(handler: StatsHandler): () => void {
    this.statsHandlers.add(handler);
    handler(this.getStats());
    return () => {
      this.statsHandlers.delete(handler);
    };
  }

  private notifyStats() {
    const stats = this.getStats();
    this.statsHandlers.forEach((h) => h(stats));
  }

  private scheduleReconnect() {
    if (this.isDestroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  /**
   * Keeps the socket warm AND measures the round trip, which nothing used to do: there was a ping
   * every 12 seconds that no peer ever answered, so the lag everyone complained about was never
   * once measured. The timestamp is this device's own clock, echoed back untouched, so the two
   * clocks never have to agree.
   */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.isDirect() || this.isConnected()) {
        this.sendRaw({ type: 'ping', timestamp: performance.now() });
      }
    }, 2000);
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

  /** Straight down the relay, whatever the direct link is doing. Used for the handshake itself. */
  private sendOverRelay(msg: CameraRemoteMessage) {
    if (!this.isConnected()) return;
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch (_) {}
  }

  /** Down whichever transport is live, ignoring congestion. For the transport's own traffic. */
  private sendRaw(msg: CameraRemoteMessage) {
    const text = JSON.stringify(msg);
    try {
      if (this.isDirect()) {
        this.dc!.send(text);
        return;
      }
      if (this.isConnected()) this.ws!.send(text);
    } catch (_) {}
  }

  /**
   * The direct link when it exists, the relay otherwise - and nothing at all when the link is
   * already behind with a sample of the same kind.
   *
   * That last part is the fix for the burst. At ~66Hz a brief stall used to queue twenty poses
   * that then arrived together, whipping the camera through positions the operator had already
   * left. Dropping a sample instead costs 15ms of staleness; queueing it costs a jolt.
   */
  public send(msg: CameraRemoteMessage) {
    const text = JSON.stringify(msg);
    const droppable = DROPPABLE.has(msg.type);

    if (this.isDirect()) {
      if (droppable && this.dc!.bufferedAmount > BACKPRESSURE_BYTES) {
        this.dropped++;
        return;
      }
      try {
        this.dc!.send(text);
        return;
      } catch (_) {
        // Fall through to the relay: the channel died between the check and the send.
      }
    }

    if (!this.isConnected()) return;
    if (droppable && (this.ws as any).bufferedAmount > BACKPRESSURE_BYTES) {
      this.dropped++;
      return;
    }
    try {
      this.ws?.send(text);
    } catch (_) {}
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
    if (!project) return;
    const lightweightProject: Partial<Project> = {
      id: project.id,
      name: project.name,
      scenes: project.scenes || [],
      characters: project.characters || [],
      panoramaUrl: project.panoramaUrl,
      panoramaRotation: project.panoramaRotation,
      splatUrl: project.splatUrl,
    };
    this.send({ type: 'init_scene', project: lightweightProject as Project });
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
    this.closeDirectLink();
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
    this.statsHandlers.clear();
  }
}
