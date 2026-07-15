import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import FFT from "fft.js";
import ort from "onnxruntime-node";
import { run } from "../lib/exec.js";

// Standalone vocal-separation worker. Runs the MDX-Net model (UVR-MDX-NET-Voc_FT) in
// onnxruntime-node to isolate the sung vocals, so a karaoke transcript can be force-aligned to a
// clean voice instead of the full mix (wav2vec2 only hears words once the backing track is gone).
// Invoked as: node separate-worker.js <inputAudio> <outputVocalsWav>. The model memory dies with
// the process, same pattern as align-worker.

// UVR-MDX-NET-Voc_FT params, verified from UVR model_data_new.json + the ONNX I/O shape.
const N_FFT = 7680;
const HOP = 1024;
const DIM_F = 3072;
const DIM_T = 256;
const N_BINS = N_FFT / 2 + 1;
const CHUNK = HOP * (DIM_T - 1);
const TRIM = N_FFT / 2;
const GEN = CHUNK - 2 * TRIM;
const COMPENSATE = 1.021;
const SAMPLE_RATE = 44100;
const MODEL_PATH = process.env.MDX_MODEL ?? "/app/models/mdx/UVR-MDX-NET-Voc_FT.onnx";

const WINDOW = new Float64Array(N_FFT);
for (let n = 0; n < N_FFT; n++) WINDOW[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);

// Bluestein DFT for the non-power-of-two n_fft (7680 = 2^9*3*5), built on a power-of-two fft.js.
function makeDft(n: number): (
  re: Float64Array,
  im: Float64Array | null,
) => {
  re: Float64Array;
  im: Float64Array;
} {
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const fft = new FFT(m);
  const chirpRe = new Float64Array(n);
  const chirpIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const ang = (Math.PI * ((k * k) % (2 * n))) / n;
    chirpRe[k] = Math.cos(ang);
    chirpIm[k] = Math.sin(ang);
  }
  const filterTime = fft.createComplexArray();
  filterTime.fill(0);
  filterTime[0] = chirpRe[0];
  filterTime[1] = chirpIm[0];
  for (let k = 1; k < n; k++) {
    filterTime[2 * k] = chirpRe[k];
    filterTime[2 * k + 1] = chirpIm[k];
    filterTime[2 * (m - k)] = chirpRe[k];
    filterTime[2 * (m - k) + 1] = chirpIm[k];
  }
  const filterFreq = fft.createComplexArray();
  fft.transform(filterFreq, filterTime);
  const aTime = fft.createComplexArray();
  const aFreq = fft.createComplexArray();
  const product = fft.createComplexArray();
  return (re, im) => {
    aTime.fill(0);
    for (let k = 0; k < n; k++) {
      const xr = re[k] as number;
      const xi = im ? (im[k] as number) : 0;
      const wr = chirpRe[k] as number;
      const wi = chirpIm[k] as number;
      aTime[2 * k] = xr * wr + xi * wi;
      aTime[2 * k + 1] = xi * wr - xr * wi;
    }
    fft.transform(aFreq, aTime);
    for (let k = 0; k < m; k++) {
      const ar = aFreq[2 * k] as number;
      const ai = aFreq[2 * k + 1] as number;
      const br = filterFreq[2 * k] as number;
      const bi = filterFreq[2 * k + 1] as number;
      product[2 * k] = ar * br - ai * bi;
      product[2 * k + 1] = ar * bi + ai * br;
    }
    fft.inverseTransform(aTime, product);
    const outRe = new Float64Array(n);
    const outIm = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const cr = aTime[2 * k] as number;
      const ci = aTime[2 * k + 1] as number;
      const wr = chirpRe[k] as number;
      const wi = chirpIm[k] as number;
      outRe[k] = cr * wr + ci * wi;
      outIm[k] = ci * wr - cr * wi;
    }
    return { re: outRe, im: outIm };
  };
}
const dft = makeDft(N_FFT);

interface ChannelStft {
  re: Float32Array;
  im: Float32Array;
  frames: number;
}

// torch.stft(center=True): reflect-pad n_fft/2 each side, frame by hop, window, DFT, keep dim_f bins.
function stftChannel(signal: Float32Array): ChannelStft {
  const pad = N_FFT / 2;
  const padded = new Float64Array(signal.length + 2 * pad);
  for (let i = 0; i < signal.length; i++) padded[pad + i] = signal[i] as number;
  for (let i = 0; i < pad; i++) {
    padded[pad - 1 - i] = signal[i + 1] ?? 0;
    padded[pad + signal.length + i] = signal[signal.length - 2 - i] ?? 0;
  }
  const frames = 1 + Math.floor((padded.length - N_FFT) / HOP);
  const re = new Float32Array(DIM_F * frames);
  const im = new Float32Array(DIM_F * frames);
  const frame = new Float64Array(N_FFT);
  for (let t = 0; t < frames; t++) {
    const off = t * HOP;
    for (let n = 0; n < N_FFT; n++) frame[n] = (padded[off + n] as number) * (WINDOW[n] as number);
    const { re: R, im: I } = dft(frame, null);
    for (let f = 0; f < DIM_F; f++) {
      re[f * frames + t] = R[f] as number;
      im[f * frames + t] = I[f] as number;
    }
  }
  return { re, im, frames };
}

// torch.istft(center=True) for one channel; spec is [n_bins][frames] after zero-padding the freq axis.
function istftChannel(specRe: Float32Array, specIm: Float32Array, frames: number): Float32Array {
  const outLen = HOP * (frames - 1);
  const acc = new Float64Array(outLen + N_FFT);
  const wsum = new Float64Array(outLen + N_FFT);
  const invRe = new Float64Array(N_FFT);
  const invIm = new Float64Array(N_FFT);
  const pad = N_FFT / 2;
  for (let t = 0; t < frames; t++) {
    for (let k = 0; k < N_BINS; k++) {
      invRe[k] = specRe[k * frames + t] as number;
      invIm[k] = specIm[k * frames + t] as number;
    }
    for (let k = 1; k < N_FFT - N_BINS + 1; k++) {
      invRe[N_BINS - 1 + k] = specRe[(N_BINS - 1 - k) * frames + t] as number;
      invIm[N_BINS - 1 + k] = -(specIm[(N_BINS - 1 - k) * frames + t] as number);
    }
    // inverse DFT via forward DFT of the conjugate, divided by n
    const negIm = new Float64Array(N_FFT);
    for (let k = 0; k < N_FFT; k++) negIm[k] = -(invIm[k] as number);
    const { re: yr } = dft(invRe, negIm);
    const off = t * HOP;
    for (let n = 0; n < N_FFT; n++) {
      const sample = (yr[n] as number) / N_FFT;
      const wv = WINDOW[n] as number;
      acc[off + n] = (acc[off + n] as number) + sample * wv;
      wsum[off + n] = (wsum[off + n] as number) + wv * wv;
    }
  }
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const w = wsum[pad + i] as number;
    out[i] = w > 1e-8 ? (acc[pad + i] as number) / w : 0;
  }
  return out;
}

async function decodeStereo44k(audioPath: string): Promise<[Float32Array, Float32Array]> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-sep-"));
  try {
    const raw = join(dir, "audio.f32");
    await run("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-i",
      audioPath,
      "-ac",
      "2",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "f32le",
      raw,
    ]);
    const buf = await readFile(raw);
    const inter = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    const n = inter.length >> 1;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = inter[2 * i] as number;
      right[i] = inter[2 * i + 1] as number;
    }
    return [left, right];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function encodeWav(channels: Float32Array[], sampleRate: number): Buffer {
  const frames = channels[0]?.length ?? 0;
  const nc = channels.length;
  const data = Buffer.alloc(frames * nc * 2);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nc; c++) {
      const s = Math.max(-1, Math.min(1, (channels[c] as Float32Array)[i] as number));
      data.writeInt16LE(Math.round(s * 32767), (i * nc + c) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(nc, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * nc * 2, 28);
  header.writeUInt16LE(nc * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function separate(inputPath: string, outputPath: string): Promise<void> {
  const [left, right] = await decodeStereo44k(inputPath);
  const samples = left.length;
  const session = await ort.InferenceSession.create(MODEL_PATH);

  const pad = GEN - (samples % GEN);
  const total = TRIM + samples + pad + TRIM;
  const mixLeft = new Float32Array(total);
  const mixRight = new Float32Array(total);
  mixLeft.set(left, TRIM);
  mixRight.set(right, TRIM);

  const outLeft = new Float32Array(samples + pad);
  const outRight = new Float32Array(samples + pad);
  let produced = 0;
  for (let i = 0; i + CHUNK <= total; i += GEN) {
    const stftLeft = stftChannel(mixLeft.subarray(i, i + CHUNK));
    const stftRight = stftChannel(mixRight.subarray(i, i + CHUNK));
    const frames = stftLeft.frames;
    const plane = DIM_F * frames;
    const input = new Float32Array(4 * plane);
    input.set(stftLeft.re, 0 * plane);
    input.set(stftLeft.im, 1 * plane);
    input.set(stftRight.re, 2 * plane);
    input.set(stftRight.im, 3 * plane);
    const result = await session.run({
      input: new ort.Tensor("float32", input, [1, 4, DIM_F, frames]),
    });
    const outTensor = result.output;
    if (!outTensor) throw new Error("mdx model returned no output");
    const out = outTensor.data as Float32Array;
    const specReL = new Float32Array(N_BINS * frames);
    const specImL = new Float32Array(N_BINS * frames);
    const specReR = new Float32Array(N_BINS * frames);
    const specImR = new Float32Array(N_BINS * frames);
    for (let f = 0; f < DIM_F; f++) {
      for (let t = 0; t < frames; t++) {
        specReL[f * frames + t] = out[0 * plane + f * frames + t] as number;
        specImL[f * frames + t] = out[1 * plane + f * frames + t] as number;
        specReR[f * frames + t] = out[2 * plane + f * frames + t] as number;
        specImR[f * frames + t] = out[3 * plane + f * frames + t] as number;
      }
    }
    const wavLeft = istftChannel(specReL, specImL, frames);
    const wavRight = istftChannel(specReR, specImR, frames);
    for (let k = 0; k < GEN && produced + k < outLeft.length; k++) {
      outLeft[produced + k] = (wavLeft[TRIM + k] as number) * COMPENSATE;
      outRight[produced + k] = (wavRight[TRIM + k] as number) * COMPENSATE;
    }
    produced += GEN;
  }
  await writeFile(
    outputPath,
    encodeWav([outLeft.subarray(0, samples), outRight.subarray(0, samples)], SAMPLE_RATE),
  );
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) throw new Error("usage: separate-worker <input> <outputWav>");
  await separate(inputPath, outputPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
