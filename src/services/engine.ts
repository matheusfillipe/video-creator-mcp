import { config } from "../config.js";
import { Limiter, type LimiterStatus } from "../lib/queue.js";

const engine = new Limiter(config.renderConcurrency);

/**
 * Funnels every Hyperframes/ffmpeg-heavy operation (render, timeline assembly, lint,
 * background removal) through one shared concurrency limiter so they never starve the host.
 */
export function runOnEngine<T>(fn: () => Promise<T>): Promise<T> {
  return engine.run(fn);
}

export function engineStatus(): LimiterStatus {
  return engine.status();
}
