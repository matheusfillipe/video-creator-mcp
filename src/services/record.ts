import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { config } from "../config.js";
import { sanitizedEnv } from "../lib/exec.js";
import { assertSafeUrl } from "../lib/net.js";
import { writeMediaFromBuffer } from "./media.js";
import { storage } from "./storage.js";

const CHROME = "/usr/bin/chromium";
export const MAX_RECORD_SECONDS = 600;
const MAX_SESSIONS = 3;
const BASE_PORT = 9500;
const BASE_DISPLAY = 99;
let seq = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface KeyDef {
  key: string;
  code: string;
  vk: number;
}
const KEYS: Record<string, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", vk: 13 },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Space: { key: " ", code: "Space", vk: 32 },
};
export const ALLOWED_KEYS = Object.keys(KEYS);

export type RecordAction =
  | { type: "click"; selector?: string; x?: number; y?: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dy: number; dx?: number }
  | { type: "navigate"; url: string }
  | { type: "wait"; ms: number };

export interface RecordResult {
  media_id: string;
  url?: string;
  duration_sec: number;
  has_audio: boolean;
  width: number;
  height: number;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

function getJson(port: number, path: string): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    httpGet(`http://127.0.0.1:${port}${path}`, (r) => {
      let s = "";
      r.on("data", (d) => {
        s += d;
      });
      r.on("end", () => {
        try {
          res(JSON.parse(s));
        } catch (e) {
          rej(e as Error);
        }
      });
    }).on("error", rej);
  });
}

class RecordSession {
  readonly id = randomUUID().slice(0, 8);
  readonly startedAt = Date.now();
  private readonly n = seq++;
  private readonly port = BASE_PORT + (this.n % 64);
  private readonly display = BASE_DISPLAY + (this.n % 64);
  private readonly pulseSock = `/tmp/vcm-pulse-${this.id}.sock`;
  private readonly userDataDir = `/tmp/vcm-cr-${this.id}`;
  private readonly outPath = join(config.workDir, `record-${this.id}.mp4`);
  private readonly deadline: number;
  private deadlineTimer?: NodeJS.Timeout;
  private pulse?: ChildProcess;
  private xvfb?: ChildProcess;
  private chrome?: ChildProcess;
  private ws?: WebSocket;
  private ff?: ChildProcess;
  private sid = "";
  private msgId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly eventWaiters: Array<{ method: string; resolve: () => void }> = [];
  state: "recording" | "finalizing" | "done" | "error" = "recording";
  private finalizePromise?: Promise<RecordResult>;
  private result?: RecordResult;
  private lastError?: string;

  constructor(
    private readonly url: string,
    readonly width: number,
    readonly height: number,
    readonly fps: number,
    maxSeconds: number,
  ) {
    this.deadline = this.startedAt + Math.min(maxSeconds, MAX_RECORD_SECONDS) * 1000;
  }

  private childEnv(): NodeJS.ProcessEnv {
    return {
      ...sanitizedEnv(),
      HOME: "/root",
      XDG_RUNTIME_DIR: "/tmp",
      DISPLAY: `:${this.display}`,
      PULSE_SERVER: `unix:${this.pulseSock}`,
    };
  }

  private track(child: ChildProcess, label: string): ChildProcess {
    child.on("error", (e) => void this.finalize("error", `${label}: ${e.message}`));
    return child;
  }

  async start(): Promise<void> {
    const env = this.childEnv();
    // A dedicated PulseAudio server per session (its own socket + null sink as the default)
    // isolates each recording's audio — chrome's Cubeb backend ignores PULSE_SINK and follows the
    // server default, so per-session servers are the only reliable way to keep concurrent captures
    // from bleeding into one another.
    this.pulse = this.track(
      spawn(
        "pulseaudio",
        [
          "-n",
          "--daemonize=no",
          "--exit-idle-time=-1",
          "--disable-shm=1",
          `--load=module-native-protocol-unix auth-anonymous=1 socket=${this.pulseSock}`,
          "--load=module-null-sink sink_name=rec",
          "--log-target=stderr",
        ],
        { env, stdio: "ignore" },
      ),
      "pulseaudio",
    );
    for (let i = 0; i < 60 && !existsSync(this.pulseSock); i++) await sleep(100);
    if (!existsSync(this.pulseSock)) throw new Error("pulseaudio did not start");

    await rm(`/tmp/.X${this.display}-lock`, { force: true }).catch(() => {});
    this.xvfb = this.track(
      spawn(
        "Xvfb",
        [`:${this.display}`, "-screen", "0", `${this.width}x${this.height}x24`, "-nolisten", "tcp"],
        { env, stdio: "ignore" },
      ),
      "xvfb",
    );
    await sleep(700);

    this.chrome = this.track(
      spawn(
        CHROME,
        [
          "--no-sandbox",
          "--disable-gpu",
          "--test-type",
          "--no-first-run",
          "--disable-dev-shm-usage",
          "--autoplay-policy=no-user-gesture-required",
          "--host-resolver-rules=MAP localhost ~NOTFOUND",
          "--start-fullscreen",
          "--window-position=0,0",
          `--window-size=${this.width},${this.height}`,
          `--user-data-dir=${this.userDataDir}`,
          `--remote-debugging-port=${this.port}`,
          "--remote-debugging-address=127.0.0.1",
          "about:blank",
        ],
        { env, stdio: "ignore" },
      ),
      "chromium",
    );

    let version: Record<string, unknown> | undefined;
    for (let i = 0; i < 100; i++) {
      try {
        version = await getJson(this.port, "/json/version");
        break;
      } catch {
        await sleep(100);
      }
    }
    if (!version?.webSocketDebuggerUrl) throw new Error("chromium devtools did not come up");

    this.ws = new WebSocket(version.webSocketDebuggerUrl as string);
    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error("no ws"));
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("cdp websocket failed"));
    });
    this.ws.onmessage = (ev) => this.onMessage(String(ev.data));
    this.ws.onclose = () => {
      if (this.state === "recording") void this.finalize("error", "browser closed unexpectedly");
    };

    const target = await this.send("Target.createTarget", { url: "about:blank" }, false);
    const attached = await this.send(
      "Target.attachToTarget",
      { targetId: target.targetId, flatten: true },
      false,
    );
    this.sid = attached.sessionId as string;
    await this.send("Page.enable");
    await this.send("DOM.enable");
    await this.navigate(this.url);

    this.ff = this.track(
      spawn(
        "ffmpeg",
        [
          "-y",
          "-f",
          "x11grab",
          "-framerate",
          String(this.fps),
          "-video_size",
          `${this.width}x${this.height}`,
          "-i",
          `:${this.display}`,
          "-f",
          "pulse",
          "-i",
          "rec.monitor",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-movflags",
          "+faststart",
          this.outPath,
        ],
        { env, stdio: ["pipe", "ignore", "ignore"] },
      ),
      "ffmpeg",
    );
    this.ff.on("close", () => {
      if (this.state === "recording") void this.finalize("error", "ffmpeg exited early");
    });
    this.ff.stdin?.on("error", () => {});
    this.deadlineTimer = setTimeout(
      () => void this.finalize("done", "reached max duration"),
      Math.max(0, this.deadline - Date.now()),
    );
  }

  private send(
    method: string,
    params: Record<string, unknown> = {},
    withSession = true,
  ): Promise<Record<string, unknown>> {
    if (!this.ws) throw new Error("session not connected");
    const id = ++this.msgId;
    const payload = withSession
      ? { id, method, params, sessionId: this.sid }
      : { id, method, params };
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`));
      }, 30_000);
    });
  }

  private onMessage(raw: string): void {
    let m: {
      id?: number;
      method?: string;
      result?: Record<string, unknown>;
      error?: { message: string };
    };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error.message));
      else p?.resolve(m.result ?? {});
      return;
    }
    if (m.method) {
      for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
        if (this.eventWaiters[i]?.method === m.method) {
          this.eventWaiters.splice(i, 1)[0]?.resolve();
        }
      }
    }
  }

  private waitEvent(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const waiter = {
        method,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const i = this.eventWaiters.indexOf(waiter);
        if (i >= 0) this.eventWaiters.splice(i, 1);
        resolve();
      }, timeoutMs);
      this.eventWaiters.push(waiter);
    });
  }

  private async selectorPoint(selector: string): Promise<{ x: number; y: number }> {
    const doc = await this.send("DOM.getDocument", { depth: 0 });
    const found = await this.send("DOM.querySelector", {
      nodeId: (doc.root as { nodeId: number }).nodeId,
      selector,
    });
    const nodeId = found.nodeId as number;
    if (!nodeId) throw new Error(`no element matches selector: ${selector}`);
    await this.send("DOM.scrollIntoViewIfNeeded", { nodeId }).catch(() => {});
    const box = await this.send("DOM.getBoxModel", { nodeId });
    const q = (box.model as { content: number[] }).content;
    if (q.length < 8) throw new Error(`element has no layout box: ${selector}`);
    const at = (i: number): number => q[i] ?? 0;
    return { x: (at(0) + at(2) + at(4) + at(6)) / 4, y: (at(1) + at(3) + at(5) + at(7)) / 4 };
  }

  private clamp(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.max(0, Math.min(this.width - 1, x)),
      y: Math.max(0, Math.min(this.height - 1, y)),
    };
  }

  async navigate(url: string): Promise<void> {
    const safe = (await assertSafeUrl(url)).toString();
    const loaded = this.waitEvent("Page.loadEventFired", 10_000);
    await this.send("Page.navigate", { url: safe });
    await loaded;
  }

  async act(action: RecordAction): Promise<void> {
    if (this.state !== "recording")
      throw new Error(`session ${this.id} is ${this.state}, not recording`);
    switch (action.type) {
      case "wait":
        await sleep(Math.max(0, Math.min(30_000, action.ms)));
        return;
      case "navigate":
        await this.navigate(action.url);
        return;
      case "type":
        await this.send("Input.insertText", { text: action.text });
        return;
      case "key": {
        const k = KEYS[action.key];
        if (!k)
          throw new Error(`unsupported key "${action.key}". allowed: ${ALLOWED_KEYS.join(", ")}`);
        await this.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: k.key,
          code: k.code,
          windowsVirtualKeyCode: k.vk,
          text: k.vk === 32 ? " " : undefined,
        });
        await this.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: k.key,
          code: k.code,
          windowsVirtualKeyCode: k.vk,
        });
        return;
      }
      case "scroll": {
        const { x, y } = this.clamp(this.width / 2, this.height / 2);
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: action.dx ?? 0,
          deltaY: action.dy,
        });
        return;
      }
      case "click": {
        let point: { x: number; y: number };
        if (action.selector) point = await this.selectorPoint(action.selector);
        else if (action.x !== undefined && action.y !== undefined)
          point = { x: action.x, y: action.y };
        else throw new Error("click needs a selector or x/y");
        const { x, y } = this.clamp(point.x, point.y);
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        for (const type of ["mousePressed", "mouseReleased"] as const) {
          await this.send("Input.dispatchMouseEvent", {
            type,
            x,
            y,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
        }
        return;
      }
    }
  }

  elapsedSec(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  finalize(state: "done" | "error", reason?: string): Promise<RecordResult> {
    if (!this.finalizePromise) this.finalizePromise = this.doFinalize(state, reason);
    return this.finalizePromise;
  }

  private async doFinalize(state: "done" | "error", reason?: string): Promise<RecordResult> {
    this.state = "finalizing";
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (reason && state === "error") this.lastError = reason;
    const durationSec = this.elapsedSec();

    const ff = this.ff;
    if (ff?.stdin?.writable) ff.stdin.write("q");
    if (ff) {
      await new Promise<void>((resolve) => {
        const to = setTimeout(() => {
          try {
            ff.kill("SIGKILL");
          } catch {}
          resolve();
        }, 15_000);
        ff.once("close", () => {
          clearTimeout(to);
          resolve();
        });
      });
    }

    try {
      const buffer = await readFile(this.outPath);
      if (buffer.length < 1024) throw new Error("recording produced no video");
      const meta = await writeMediaFromBuffer({
        idSeed: `record:${this.id}:${this.startedAt}`,
        buffer,
        ext: ".mp4",
        sourceUrl: this.url,
      });
      let url: string | undefined;
      try {
        url = await storage().save(buffer, `record-${meta.media_id}.mp4`, "video/mp4");
      } catch {
        url = undefined;
      }
      this.result = {
        media_id: meta.media_id,
        url,
        duration_sec: Math.round((meta.duration ?? durationSec) * 100) / 100,
        has_audio: meta.hasAudio,
        width: this.width,
        height: this.height,
      };
      this.state = "done";
    } catch (e) {
      this.state = "error";
      this.lastError = this.lastError ?? (e as Error).message;
      this.result = {
        media_id: "",
        duration_sec: Math.round(durationSec * 100) / 100,
        has_audio: false,
        width: this.width,
        height: this.height,
      };
    }
    this.cleanup();
    return this.result as RecordResult;
  }

  private cleanup(): void {
    for (const child of [this.ws, this.ff, this.chrome, this.xvfb, this.pulse]) {
      try {
        if (child && "close" in child) child.close();
        else child?.kill("SIGKILL");
      } catch {}
    }
    void rm(this.outPath, { force: true }).catch(() => {});
    void rm(this.userDataDir, { recursive: true, force: true }).catch(() => {});
    void rm(this.pulseSock, { force: true }).catch(() => {});
    void rm(`/tmp/.X${this.display}-lock`, { force: true }).catch(() => {});
    setTimeout(() => sessions.delete(this.id), 60_000);
  }

  status(): {
    session_id: string;
    state: string;
    elapsed_sec: number;
    error?: string;
    result?: RecordResult;
  } {
    return {
      session_id: this.id,
      state: this.state,
      elapsed_sec: Math.round(this.elapsedSec() * 100) / 100,
      error: this.lastError,
      result: this.result,
    };
  }
}

const sessions = new Map<string, RecordSession>();

export async function startRecording(params: {
  url: string;
  width: number;
  height: number;
  fps: number;
  maxSeconds: number;
}): Promise<RecordSession> {
  const live = [...sessions.values()].filter((s) => s.state === "recording").length;
  if (live >= MAX_SESSIONS) {
    throw new Error(`too many active recordings (${live}/${MAX_SESSIONS}); stop one first`);
  }
  const safe = (await assertSafeUrl(params.url)).toString();
  const session = new RecordSession(
    safe,
    params.width,
    params.height,
    params.fps,
    params.maxSeconds,
  );
  sessions.set(session.id, session);
  try {
    await session.start();
  } catch (e) {
    await session.finalize("error", (e as Error).message);
    throw e;
  }
  return session;
}

export function getRecording(id: string): RecordSession {
  const s = sessions.get(id);
  if (!s) throw new Error(`no recording session ${id} (it may have expired)`);
  return s;
}
