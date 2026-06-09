// Animated macOS-terminal composition. The visual + GSAP timeline are vendored from
// HeyGen's Hyperframes catalog block "code-snippet-apple-terminal-homebrew" (frozen here so
// the injection points never drift), adapted to: load GSAP from the bundled asset instead of
// a CDN (renders run with no external egress), carry its own data-duration, and accept the
// command / output / prompt as data so an agent drives it without touching markup.

import { escapeHtml } from "./html.js";

export interface TerminalOptions {
  command: string;
  output: string[];
  prompt?: string;
  durationSeconds: number;
}

export function buildOutputLines(output: string[]): string {
  return output
    .map((line) => `<span class="output-line">${escapeHtml(line)}</span>`)
    .join("\n            ");
}

export function terminalHtml(options: TerminalOptions): string {
  const prompt = escapeHtml(options.prompt ?? "user@Mac ~ % ");
  const outputLines = buildOutputLines(options.output);
  const command = JSON.stringify(options.command);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>Terminal</title>
    <script src="assets/gsap.min.js"></script>
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
        width: 1920px;
        height: 1080px;
        overflow: hidden;
        background: #000000;
        font-family: "SF Mono", Menlo, Monaco, Consolas, "Courier New", monospace;
      }
      #scene {
        width: 1920px;
        height: 1080px;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        background: radial-gradient(ellipse at center, #0d1a0d 0%, #000000 70%);
      }
      .terminal-window {
        width: 1400px;
        height: 600px;
        border-radius: 10px;
        overflow: hidden;
        box-shadow:
          0 30px 80px rgba(0, 207, 0, 0.18),
          0 10px 30px rgba(0, 0, 0, 0.85);
        display: flex;
        flex-direction: column;
      }
      .titlebar {
        height: 38px;
        background: #1c1c1c;
        display: flex;
        align-items: center;
        padding: 0 14px;
        flex-shrink: 0;
        border-bottom: 1px solid #006900;
        position: relative;
      }
      .traffic-lights {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .traffic-lights span {
        width: 13px;
        height: 13px;
        border-radius: 50%;
        display: inline-block;
      }
      .traffic-lights .close {
        background: #ff5f57;
        border: 1px solid #e0443e;
      }
      .traffic-lights .minimize {
        background: #ffbd2e;
        border: 1px solid #dfa123;
      }
      .traffic-lights .fullscreen {
        background: #28c840;
        border: 1px solid #1aab29;
      }
      .window-title {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        font-size: 13px;
        color: #00cf00;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
        font-weight: 500;
        letter-spacing: -0.1px;
      }
      .terminal-canvas {
        flex: 1;
        background: #000000;
        overflow: hidden;
        position: relative;
        font-size: 18px;
        line-height: 1.55;
        color: #00cf00;
      }
      #term-content {
        padding: 22px 26px;
        position: relative;
        will-change: transform;
      }
      .output-lines {
        margin-bottom: 4px;
      }
      .output-line {
        display: block;
        white-space: pre;
        opacity: 0;
        color: #00cf00;
      }
      .input-line {
        display: flex;
        align-items: center;
        white-space: pre;
      }
      .prompt {
        color: #48f800;
        font-weight: bold;
        user-select: none;
      }
      .typed-command {
        color: #00cf00;
      }
      .cursor-block {
        display: inline-block;
        width: 9px;
        height: 16px;
        background: #48f800;
        vertical-align: text-bottom;
        margin-left: 1px;
      }
    </style>
  </head>
  <body>
    <div
      id="scene"
      data-composition-id="main"
      data-start="0"
      data-duration="${options.durationSeconds}"
      data-width="1920"
      data-height="1080"
    >
      <div class="terminal-window">
        <div class="titlebar">
          <div class="traffic-lights">
            <span class="close"></span>
            <span class="minimize"></span>
            <span class="fullscreen"></span>
          </div>
          <span class="window-title">bash — 80×24</span>
        </div>
        <div class="terminal-canvas">
          <div id="term-content">
            <div class="input-line" id="cmd-line">
              <span class="prompt">${prompt}</span><span class="typed-command"></span><span class="cursor-block" id="type-cursor"></span>
            </div>
            <div class="output-lines">
              ${outputLines}
            </div>
            <div class="input-line" id="final-line" style="opacity: 0">
              <span class="prompt">${prompt}</span><span class="cursor-block" id="final-cursor"></span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const command = ${command};
      const typedEl = document.querySelector("#cmd-line .typed-command");
      const typeCursor = document.getElementById("type-cursor");
      const outputLines = document.querySelectorAll(".output-line");
      const finalLine = document.getElementById("final-line");
      const finalCursor = document.getElementById("final-cursor");
      const content = document.getElementById("term-content");
      const canvas = document.querySelector(".terminal-canvas");

      // Scroll the content up so an element stays in view once output overflows
      // the visible canvas — a real terminal keeps the newest line on screen.
      function scrollToShow(el, atTime) {
        const need = el.offsetTop + el.offsetHeight - canvas.clientHeight;
        if (need > 0) {
          tl.to(content, { y: -need, duration: 0.2, ease: "power1.out" }, atTime);
        }
      }

      const tl = gsap.timeline({ paused: true });
      tl.add(() => {
        typedEl.textContent = "";
      }, 0);

      // Type the command out; it stays on screen, the way a real terminal keeps
      // the command above its output.
      const charDuration = command.length ? 1.5 / command.length : 0.1;
      command.split("").forEach((char, i) => {
        tl.add(() => {
          typedEl.textContent = command.slice(0, i + 1);
        }, 0.5 + i * charDuration);
      });
      const cmdDone = 0.5 + 1.5;
      tl.set(typeCursor, { opacity: 0 }, cmdDone + 0.1);

      // Output reveals line by line below the command, scrolling up once it
      // overflows. Pace so all lines reveal within the composition duration.
      const duration = ${options.durationSeconds};
      const revealSpan = Math.max(0.5, duration - cmdDone - 1.6);
      const step = outputLines.length
        ? Math.min(0.12, revealSpan / outputLines.length)
        : 0.12;
      outputLines.forEach((line, i) => {
        const at = cmdDone + 0.4 + i * step;
        tl.set(line, { opacity: 1 }, at);
        scrollToShow(line, at);
      });

      // A fresh prompt appears below the output and its cursor blinks.
      const outDone = cmdDone + 0.4 + outputLines.length * step + 0.2;
      tl.set(finalLine, { opacity: 1 }, outDone);
      scrollToShow(finalLine, outDone);
      const blinkStart = outDone + 0.3;
      [0, 1, 2, 3, 4, 5].forEach((i) => {
        tl.add(() => {
          finalCursor.style.opacity = i % 2 === 0 ? "0" : "1";
        }, blinkStart + i * 0.4);
      });
      tl.add(() => {
        finalCursor.style.opacity = "1";
      }, blinkStart + 2.6);

      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`;
}
