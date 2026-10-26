import { Chunker, encodeFrame, type Chunk } from './livemath';

export interface CaptureHandle { stop(): void }

const WORKLET_SRC = `
class SwLiveCapture extends AudioWorkletProcessor {
  process(inputs) {
    const inp = inputs[0];
    let ch;
    if (inp && inp.length) ch = inp.map((c) => c.slice());
    else ch = [new Float32Array(128)];
    this.port.postMessage({ t: currentTime, ch }, ch.map((c) => c.buffer));
    return true;
  }
}
registerProcessor('sw-live-capture', SwLiveCapture);
`;

/**
 * Capture `stream` audio on `ctx` into ~20 ms Int16 frames (see livemath.encodeFrame), each stamped with the
 * SERVER time of its first sample. AudioWorklet where available, ScriptProcessor otherwise.
 * The source is NOT connected to ctx.destination (no local monitoring from here).
 */
export async function startCapture(
  ctx: AudioContext,
  stream: MediaStream,
  opts: { channels: 1 | 2; serverNow: () => number; onFrame: (buf: ArrayBuffer) => void },
): Promise<CaptureHandle> {
  const { channels, serverNow, onFrame } = opts;
  let seq = 0;
  const chunker = new Chunker(ctx.sampleRate, channels, 20, (c: Chunk) => {
    // ctx time of first sample -> server time, using "now" on both clocks
    const captureServerTime = serverNow() - (ctx.currentTime - c.ctxStart) * 1000;
    onFrame(encodeFrame({ channels, frames: c.frames, seq: seq++, captureServerTime, sampleRate: ctx.sampleRate, pcm: c.pcm }));
  });
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});

  const src = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain(); // silent sink so the capture node is pulled by the graph
  sink.gain.value = 0;
  sink.connect(ctx.destination);
  let node: AudioNode;
  let url: string | null = null;

  if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      const w = new AudioWorkletNode(ctx, 'sw-live-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels],
        channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      w.port.onmessage = (e: MessageEvent) => chunker.push(e.data.ch as Float32Array[], e.data.t as number);
      node = w;
    } catch {
      node = null as unknown as AudioNode;
    }
  } else node = null as unknown as AudioNode;

  if (!node) {
    const bufSize = 2048;
    const sp = ctx.createScriptProcessor(bufSize, channels, channels);
    sp.channelCount = channels;
    sp.channelCountMode = 'explicit';
    sp.onaudioprocess = (e: AudioProcessingEvent) => {
      const blocks: Float32Array[] = [];
      for (let c = 0; c < channels; c++) blocks.push(new Float32Array(e.inputBuffer.getChannelData(c)));
      // input block began ~one buffer before its playbackTime
      chunker.push(blocks, e.playbackTime - bufSize / ctx.sampleRate);
    };
    node = sp;
  }
  src.connect(node);
  node.connect(sink);

  return {
    stop() {
      try { src.disconnect(); } catch { /* ignore */ }
      try { node.disconnect(); } catch { /* ignore */ }
      try { sink.disconnect(); } catch { /* ignore */ }
      if ((node as AudioWorkletNode).port) (node as AudioWorkletNode).port.onmessage = null;
      if ((node as ScriptProcessorNode).onaudioprocess !== undefined) (node as ScriptProcessorNode).onaudioprocess = null;
      if (url) URL.revokeObjectURL(url);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
