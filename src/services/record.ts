import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
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

// Injected once during the pre-roll: flash the whole viewport white and play a beep on the SAME
// tick, through the page's own audio path. The recorded gap between the flash (video) and the beep
// (audio) is the exact capture skew for this page's audio source, which we then correct.
const SYNC_MARKER_JS = `(() => {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:2147483647;pointer-events:none';
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const fire = () => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 1000; o.connect(g); g.connect(ac.destination);
    g.gain.setValueAtTime(0.8, ac.currentTime);
    (document.body || document.documentElement).appendChild(el);
    o.start(); o.stop(ac.currentTime + 0.15);
    setTimeout(() => el.remove(), 140);
  };
  ac.state === 'suspended' ? ac.resume().then(fire) : fire();
})();`;

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

// A scripted interaction that fires on its own, `at` seconds after capture starts (default 0 = the
// moment recording begins, right after page load). Lets a recording drive itself in one call
// instead of a live round-trip per action.
export interface ScriptStep {
  at?: number;
  action: RecordAction;
}

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

function getJsonArray(port: number, path: string): Promise<Array<Record<string, unknown>>> {
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
  // Each session needs its own XDG_RUNTIME_DIR: PulseAudio keeps a PID lock there, so a shared
  // dir makes a second concurrent session's daemon refuse to start.
  private readonly runtimeDir = `/tmp/vcm-run-${this.id}`;
  private readonly userDataDir = `/tmp/vcm-cr-${this.id}`;
  private readonly outPath = join(config.workDir, `record-${this.id}.mp4`);
  // Counted from when ffmpeg actually starts, not session construction: browser launch, page load
  // and the settle all precede capture, so the requested duration must count from the first frame.
  private readonly maxSeconds: number;
  private deadlineTimer?: NodeJS.Timeout;
  private pulse?: ChildProcess;
  private xvfb?: ChildProcess;
  private chrome?: ChildProcess;
  private ws?: WebSocket;
  private ff?: ChildProcess;
  private msgId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly eventWaiters: Array<{ method: string; resolve: () => void }> = [];
  state: "recording" | "finalizing" | "done" | "error" = "recording";
  private finalizePromise?: Promise<RecordResult>;
  private result?: RecordResult;
  private lastError?: string;
  private resolveDone!: (r: RecordResult) => void;
  // Resolves when the recording finalizes (auto-stop or explicit stop), without triggering it —
  // lets a blocking caller await the finished result instead of stopping the capture early.
  readonly done = new Promise<RecordResult>((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(
    private readonly url: string,
    readonly width: number,
    readonly height: number,
    readonly fps: number,
    maxSeconds: number,
    private readonly script: ScriptStep[] = [],
    private readonly settleMs = 500,
    private readonly audioSyncMs?: number,
  ) {
    this.maxSeconds = Math.min(maxSeconds, MAX_RECORD_SECONDS);
  }

  private childEnv(): NodeJS.ProcessEnv {
    return {
      ...sanitizedEnv(),
      HOME: "/root",
      XDG_RUNTIME_DIR: this.runtimeDir,
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
    await mkdir(this.runtimeDir, { recursive: true }).catch(() => {});
    await mkdir(config.workDir, { recursive: true }).catch(() => {});
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
    for (let i = 0; i < 80 && !existsSync(this.pulseSock); i++) await sleep(100);
    if (!existsSync(this.pulseSock)) throw new Error("pulseaudio did not start");
    await sleep(500);

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
          // Deny chrome the "localhost" hostname so a recorded page can't fetch the pod's own
          // in-cluster services (loopback is not governed by the egress NetworkPolicy).
          "--host-resolver-rules=MAP localhost ~NOTFOUND",
          "--start-fullscreen",
          "--window-position=0,0",
          `--window-size=${this.width},${this.height}`,
          `--user-data-dir=${this.userDataDir}`,
          `--remote-debugging-port=${this.port}`,
          "--remote-debugging-address=127.0.0.1",
          this.url,
        ],
        { env, stdio: "ignore" },
      ),
      "chromium",
    );

    // Connect CDP straight to the page's own debugger endpoint, not the browser endpoint plus a
    // flatten session: synthetic Input events only count as a user activation on a per-page
    // connection, so a browser-session click never unlocks the page's Web Audio and captured audio
    // stays silent. This also records the existing on-screen tab (a fresh Target.createTarget opens
    // off-screen, where x11grab wouldn't see it).
    let pageWsUrl: string | undefined;
    for (let i = 0; i < 100; i++) {
      try {
        const list = await getJsonArray(this.port, "/json");
        const page = list.find(
          (t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string",
        );
        if (page) {
          pageWsUrl = page.webSocketDebuggerUrl as string;
          break;
        }
      } catch {
        // devtools not up yet
      }
      await sleep(100);
    }
    if (!pageWsUrl) throw new Error("chromium devtools did not come up");

    this.ws = new WebSocket(pageWsUrl);
    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error("no ws"));
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("cdp websocket failed"));
    });
    this.ws.onmessage = (ev) => this.onMessage(String(ev.data));
    this.ws.onclose = () => {
      if (this.state === "recording") void this.finalize("error", "browser closed unexpectedly");
    };

    await this.send("Page.enable");
    await this.send("DOM.enable");
    await this.send("Page.bringToFront").catch(() => {});
    await Promise.race([this.waitEvent("Page.loadEventFired", 12_000), sleep(12_000)]);
    await sleep(this.settleMs);
    await this.primeAudio();

    const syncMs = this.audioSyncMs ?? (await this.measureSyncOffset());

    this.ff = this.track(
      spawn(
        "ffmpeg",
        [
          "-y",
          "-thread_queue_size",
          "1024",
          "-f",
          "x11grab",
          "-framerate",
          String(this.fps),
          "-video_size",
          `${this.width}x${this.height}`,
          "-i",
          `:${this.display}`,
          "-thread_queue_size",
          "1024",
          "-f",
          "pulse",
          "-i",
          "rec.monitor",
          // Pad the audio by the skew measured in the pre-roll so it lines up with the video (input
          // timestamp offsets get normalized away by the mp4 muxer, so real leading silence is what
          // survives).
          "-af",
          `adelay=${Math.round(syncMs)}:all=1`,
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
        { env, stdio: ["pipe", "ignore", "pipe"] },
      ),
      "ffmpeg",
    );
    let ffTail = "";
    this.ff.stderr?.on("data", (d) => {
      ffTail = (ffTail + d).slice(-2000);
    });
    this.ff.on("close", () => {
      if (this.state === "recording")
        void this.finalize(
          "error",
          `ffmpeg exited early: ${ffTail.replace(/\s+/g, " ").slice(-300)}`,
        );
    });
    this.ff.stdin?.on("error", () => {});
    this.deadlineTimer = setTimeout(
      () => void this.finalize("done", "reached max duration"),
      this.maxSeconds * 1000,
    );
    void this.runScript();
  }

  // Drive the pre-supplied script on the live recording. Each step fires `at` seconds after capture
  // starts; steps at the same offset run in array order. A failing step is skipped, never crashing
  // the recording. Runs concurrently with the capture, which still auto-stops at its deadline.
  private async runScript(): Promise<void> {
    const base = Date.now();
    const steps = [...this.script].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    for (const step of steps) {
      const wait = base + (step.at ?? 0) * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      if (this.state !== "recording") return;
      await this.doAct(step.action).catch(() => {});
    }
  }

  private send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!this.ws) throw new Error("session not connected");
    const id = ++this.msgId;
    this.ws.send(JSON.stringify({ id, method, params }));
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
    await this.doAct(action);
  }

  private async doAct(action: RecordAction): Promise<void> {
    // Re-focus the page on every interaction: on a WM-less Xvfb the tab's focus goes stale between
    // the separate input calls, and a keypress to an unfocused page is dropped (e.g. Space never
    // starts a player).
    await this.send("Page.bringToFront").catch(() => {});
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

  // A page's Web Audio starts suspended until a real user gesture; chrome resumes it on a trusted
  // click, not on a synthetic keydown. Without this, a media page renders visually but stays silent
  // (no audio stream reaches the capture sink). One click at viewport center at start unlocks it.
  private async primeAudio(): Promise<void> {
    const { x, y } = this.clamp(this.width / 2, this.height / 2);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }).catch(() => {});
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      }).catch(() => {});
    }
  }

  // Measure this page's true audio/video capture skew instead of guessing a constant: record a short
  // pre-roll, fire a simultaneous white-flash + beep into it, and read back the gap between the two
  // in the captured file. That gap is how far the audio leads the video for this page's audio source;
  // returns the ms of leading silence to pad. Falls back to 0 (no correction) if measurement fails.
  private async measureSyncOffset(): Promise<number> {
    const env = this.childEnv();
    const preroll = `/tmp/vcm-preroll-${this.id}.mp4`;
    const ff = spawn(
      "ffmpeg",
      [
        "-y",
        "-thread_queue_size",
        "1024",
        "-f",
        "x11grab",
        "-framerate",
        String(this.fps),
        "-video_size",
        `${this.width}x${this.height}`,
        "-i",
        `:${this.display}`,
        "-thread_queue_size",
        "1024",
        "-f",
        "pulse",
        "-i",
        "rec.monitor",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        preroll,
      ],
      { env, stdio: ["pipe", "ignore", "ignore"] },
    );
    ff.on("error", () => {});
    ff.stdin?.on("error", () => {});
    try {
      await sleep(600);
      await this.send("Runtime.enable").catch(() => {});
      await this.send("Runtime.evaluate", {
        expression: SYNC_MARKER_JS,
        awaitPromise: true,
      }).catch(() => {});
      await sleep(1000);
      if (ff.stdin?.writable) ff.stdin.write("q");
      await new Promise<void>((resolve) => {
        const to = setTimeout(() => {
          try {
            ff.kill("SIGKILL");
          } catch {}
          resolve();
        }, 5000);
        ff.once("close", () => {
          clearTimeout(to);
          resolve();
        });
      });
      const flash = await this.firstWhiteFrame(preroll);
      const beep = await this.firstBeep(preroll);
      if (flash === null || beep === null) return 0;
      const leadSec = flash - beep;
      if (leadSec < 0.03 || leadSec > 4) return 0;
      return Math.round(leadSec * 1000);
    } finally {
      await rm(preroll, { force: true }).catch(() => {});
    }
  }

  private runFfmpeg(args: string[]): Promise<string> {
    return new Promise((resolve) => {
      const p = spawn("ffmpeg", args, {
        env: this.childEnv(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      p.stderr?.on("data", (d) => {
        err = (err + d).slice(-40000);
      });
      p.on("error", () => resolve(err));
      p.on("close", () => resolve(err));
    });
  }

  private async firstWhiteFrame(path: string): Promise<number | null> {
    const out = `/tmp/vcm-white-${this.id}.txt`;
    await this.runFfmpeg([
      "-i",
      path,
      "-vf",
      `signalstats,metadata=print:file=${out}`,
      "-an",
      "-f",
      "null",
      "-",
    ]);
    const txt = await readFile(out, "utf8").catch(() => "");
    await rm(out, { force: true }).catch(() => {});
    let t: number | null = null;
    for (const line of txt.split("\n")) {
      const pt = line.match(/pts_time:([0-9.]+)/);
      if (pt?.[1]) {
        t = Number.parseFloat(pt[1]);
        continue;
      }
      const y = line.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
      if (y?.[1] && t !== null && Number.parseFloat(y[1]) > 180) return t;
    }
    return null;
  }

  private async firstBeep(path: string): Promise<number | null> {
    const err = await this.runFfmpeg([
      "-i",
      path,
      "-af",
      "silencedetect=noise=-40dB:d=0.05",
      "-f",
      "null",
      "-",
    ]);
    const m = err.match(/silence_end:\s*([0-9.]+)/);
    return m?.[1] ? Number.parseFloat(m[1]) : null;
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
    this.resolveDone(this.result as RecordResult);
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
    void rm(this.runtimeDir, { recursive: true, force: true }).catch(() => {});
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
  script?: ScriptStep[];
  settleMs?: number;
  audioSyncMs?: number;
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
    params.script ?? [],
    params.settleMs,
    params.audioSyncMs,
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
