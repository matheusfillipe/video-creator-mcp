import { config } from "../config.js";

export class ChatterboxNotConfiguredError extends Error {
  constructor() {
    super(
      "TTS is not configured: set CHATTERBOX_URL to a reachable chatterbox-tts service (see compose.yaml).",
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
  voice?: string; // a named voice known to the service (VOICES_DIR)
  voiceB64?: string; // base64 reference clip to clone zero-shot
}

export async function synthesizeChatterbox(params: ChatterboxParams): Promise<Buffer> {
  const base = config.chatterbox.url;
  if (!base) throw new ChatterboxNotConfiguredError();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.chatterbox.timeoutMs);
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: params.text,
        exaggeration: params.exaggeration,
        cfg_weight: params.cfgWeight,
        temperature: params.temperature,
        voice: params.voice ?? null,
        voice_b64: params.voiceB64 ?? null,
      }),
      signal: controller.signal,
    });
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
