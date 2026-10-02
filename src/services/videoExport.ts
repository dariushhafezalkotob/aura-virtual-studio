import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

/**
 * Frame-by-frame MP4 export at an exact frame rate.
 *
 * The first export recorded the viewport live (canvas.captureStream + MediaRecorder): the "60 fps"
 * was a target, every frame was stamped with the wall clock, and a heavy scene dropped or repeated
 * frames, so an editor saw a variable frame rate. Here the caller renders each frame at its exact
 * time and hands it over; the browser's own H.264 encoder (WebCodecs) compresses it and every frame
 * is written with the timestamp frame/fps. The file is constant frame rate however long a frame
 * took to draw.
 */

export const EXPORT_FRAME_RATES = [24, 25, 30] as const;
export type ExportFrameRate = (typeof EXPORT_FRAME_RATES)[number];

export interface FrameExporter {
  /** Encodes the canvas as frame `index`. Waits when the encoder falls behind. */
  addFrame: (canvas: HTMLCanvasElement, index: number) => Promise<void>;
  /** Flushes the encoder and returns the finished file. */
  finish: () => Promise<Blob>;
  /** Stops without producing a file. */
  cancel: () => void;
}

// High, Main, then Baseline, all at level 4.0 (1080p up to 30 fps).
const H264_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'];

/** Null when this browser cannot encode H.264 itself; the caller falls back to the live recording. */
export async function createFrameExporter(opts: {
  width: number;
  height: number;
  fps: number;
  bitrate?: number;
}): Promise<FrameExporter | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  const { width, height, fps } = opts;
  const bitrate = opts.bitrate ?? 12_000_000;

  let config: VideoEncoderConfig | null = null;
  for (const codec of H264_CODECS) {
    const candidate: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps };
    try {
      if ((await VideoEncoder.isConfigSupported(candidate)).supported) {
        config = candidate;
        break;
      }
    } catch {
      // Try the next profile.
    }
  }
  if (!config) return null;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    // The index goes at the front of the file, so it starts playing before it is fully read.
    fastStart: 'in-memory',
  });

  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      failure = e;
    },
  });
  encoder.configure(config);

  const frameMicros = 1_000_000 / fps;

  return {
    async addFrame(canvas, index) {
      if (failure) throw failure;
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(index * frameMicros),
        duration: Math.round(frameMicros),
      });
      // A key frame every two seconds keeps the file easy to scrub in an editor.
      encoder.encode(frame, { keyFrame: index % (fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 4));
    },
    async finish() {
      await encoder.flush();
      if (failure) throw failure;
      encoder.close();
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    },
    cancel() {
      try {
        encoder.close();
      } catch {
        // Already closed.
      }
    },
  };
}
