import { describe, expect, it } from "vitest";
import { Limiter } from "../../src/lib/queue.js";

function deferred(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Limiter", () => {
  it("never exceeds the concurrency cap", async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await deferred(10);
        active -= 1;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it("serializes with a cap of 1", async () => {
    const limiter = new Limiter(1);
    const order: number[] = [];
    const task = (id: number) =>
      limiter.run(async () => {
        order.push(id);
        await deferred(5);
      });
    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
  });
});
