import { config } from "../config.js";

export class ChatterboxNotConfiguredError extends Error {
  constructor() {
    super(
      "TTS is not configured: set CHATTERBOX_URL to a reachable chatterbox-tts-api service (see compose.yaml).",
    );
    this.name = "ChatterboxNotConfiguredError";
  }
}

export class ChatterboxRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatterboxRequestError";
  }
}

export interface ChatterboxParams {
  text: string;
  exaggeration: number;
  cfgWeight: number;
  temperature: number;
  voiceFile?: { buffer: Buffer; filename: string }; // reference clip to clone zero-shot
}

async function post(url: string, init: RequestInit, base: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.chatterbox.timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ChatterboxRequestError(`chatterbox returned ${res.status}: ${body.slice(0, 300)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (error) {
    if (error instanceof ChatterboxRequestError) throw error;
    if (controller.signal.aborted) {
      throw new ChatterboxRequestError(
        `chatterbox timed out after ${config.chatterbox.timeoutMs}ms (generation is slow; raise CHATTERBOX_TIMEOUT_MS for long text).`,
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ChatterboxRequestError(`chatterbox unreachable at ${base}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function synthesizeChatterbox(params: ChatterboxParams): Promise<Buffer> {
  const base = config.chatterbox.url;
  if (!base) throw new ChatterboxNotConfiguredError();
  const root = base.replace(/\/+$/, "");

  if (params.voiceFile) {
    const form = new FormData();
    form.set("input", params.text);
    form.set("exaggeration", String(params.exaggeration));
    form.set("cfg_weight", String(params.cfgWeight));
    form.set("temperature", String(params.temperature));
    form.set("voice_file", new Blob([params.voiceFile.buffer]), params.voiceFile.filename);
    return post(`${root}/v1/audio/speech/upload`, { method: "POST", body: form }, base);
  }

  return post(
    `${root}/v1/audio/speech`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: params.text,
        exaggeration: params.exaggeration,
        cfg_weight: params.cfgWeight,
        temperature: params.temperature,
      }),
    },
    base,
  );
}
