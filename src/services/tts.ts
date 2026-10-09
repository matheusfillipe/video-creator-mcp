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

// Reads a line on the OpenAI-compatible speech service (LocalAI) in one of its named voices,
// such as a designed voice profile. Returns WAV like Chatterbox does.
export async function synthesizeSpeechService(text: string, voice: string): Promise<Buffer> {
  const base = config.speech.url;
  if (!base)
    throw new ChatterboxRequestError(
      "speech_voice needs SPEECH_URL (an OpenAI-compatible speech service)",
    );
  const root = base.replace(/\/+$/, "");
  const url = `${root}/v1/audio/speech`;
  // When a LocalAI backend process dies mid-request, LocalAI keeps routing to the dead process
  // for about a minute. We ask it to drop that backend so the retry loads a fresh one.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.speech.model,
        input: text,
        voice,
        response_format: "wav",
      }),
      signal: AbortSignal.timeout(config.speech.timeoutMs),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const body = await res.text().catch(() => "");
    if (res.status < 500 || attempt >= SPEECH_ATTEMPTS)
      throw new ChatterboxRequestError(
        `speech service returned ${res.status}: ${body.slice(0, 300)}`,
      );
    await fetch(`${root}/backend/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.speech.model }),
      signal: AbortSignal.timeout(30_000),
    }).catch((error: unknown) => {
      if (!(error instanceof TypeError || (error as Error).name === "TimeoutError")) throw error;
    });
    await new Promise((resolve) => setTimeout(resolve, SPEECH_RETRY_DELAY_MS));
  }
}

const SPEECH_ATTEMPTS = 3;
const SPEECH_RETRY_DELAY_MS = 3_000;

// An instrumental music bed from the speech service's sound generation (ACE-Step on LocalAI).
export async function generateMusic(caption: string, durationSec: number): Promise<Buffer> {
  const base = config.speech.url;
  if (!base)
    throw new ChatterboxRequestError("video_music needs SPEECH_URL (the LocalAI audio service)");
  const res = await fetch(`${base.replace(/\/+$/, "")}/v1/sound-generation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: config.speech.musicModel,
      text: caption,
      duration_seconds: durationSec,
    }),
    signal: AbortSignal.timeout(config.speech.timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ChatterboxRequestError(
      `music generation returned ${res.status}: ${body.slice(0, 300)}`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}
