import { afterEach, describe, expect, it, vi } from "vitest";
import { InvokeScheduler } from "../invokeScheduler.js";
import { DeviceLinkError } from "../protocol.js";
import { isBackgroundInvoke, bypassInvokeScheduling } from "../invokePolicy.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe("invoke admission", () => {
  it("runs a 32-request burst in bounded batches and prioritizes current work", async () => {
    const scheduler = new InvokeScheduler();
    const started: string[] = [];
    const pending = Array.from({ length: 32 }, deferred);
    const results = pending.map((job, index) =>
      scheduler.run("a", true, 30_000, () => {
        started.push(`background-${index}`);
        return job.promise;
      }),
    );
    const foreground = Array.from({ length: 8 }, deferred);
    const foregroundResults = foreground.map((job, index) =>
      scheduler.run("a", false, 30_000, () => {
        started.push(`foreground-${index}`);
        return job.promise;
      }),
    );
    expect(started).toEqual([
      "background-0",
      "background-1",
      ...Array.from({ length: 6 }, (_, i) => `foreground-${i}`),
    ]);
    pending[0].resolve();
    await flush();
    expect(started.at(-1)).toBe("foreground-6");
    pending[1].resolve();
    await flush();
    expect(started.at(-1)).toBe("foreground-7");
    for (const job of foreground) job.resolve();
    await flush();
    expect(started.slice(-2)).toEqual(["background-2", "background-3"]);
    for (const job of pending) job.resolve();
    await Promise.all([...results, ...foregroundResults]);
    expect(started).toHaveLength(40);
  });

  it("keeps two peers independent and never sends cancelled queued writes after reconnect", async () => {
    const scheduler = new InvokeScheduler();
    const active = deferred();
    const running = Array.from({ length: 8 }, () =>
      scheduler.run("a", false, 30_000, () => active.promise),
    );
    const write = vi.fn(async () => {});
    const queued = scheduler.run("a", false, 30_000, write);
    const rejected = expect(queued).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      inFlight: undefined,
    });
    const error = new DeviceLinkError("NOT_CONNECTED", "disconnected");
    scheduler.cancel("a", error);
    error.inFlight = true;
    await rejected;
    await expect(
      scheduler.run("b", false, 30_000, async () => 42),
    ).resolves.toBe(42);
    const fresh = vi.fn(async () => {});
    const next = scheduler.run("a", false, 30_000, fresh);
    expect(fresh).not.toHaveBeenCalled();
    active.resolve();
    await Promise.all([...running, next]);
    expect(fresh).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });

  it("expires unsent calls without retrying, and bounds queued calls", async () => {
    vi.useFakeTimers();
    const scheduler = new InvokeScheduler();
    const active = deferred();
    const running = Array.from({ length: 8 }, () =>
      scheduler.run("a", false, 30_000, () => active.promise),
    );
    const send = vi.fn(async () => {});
    const queued = Array.from({ length: 128 }, () =>
      scheduler
        .run("a", false, 1000, send)
        .catch((error: DeviceLinkError) => error.code),
    );
    await expect(scheduler.run("a", false, 1000, send)).rejects.toMatchObject({
      code: "BACKPRESSURE",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await Promise.all(queued)).toEqual(Array(128).fill("BACKPRESSURE"));
    active.resolve();
    await Promise.all(running);
    expect(send).not.toHaveBeenCalled();
  });

  it("checks elapsed queue time before dispatch when timer callbacks have not resumed", async () => {
    vi.useFakeTimers();
    const scheduler = new InvokeScheduler();
    const active = deferred();
    const running = Array.from({ length: 8 }, () =>
      scheduler.run("a", false, 30_000, () => active.promise),
    );
    const send = vi.fn(async () => {});
    const next = scheduler
      .run("a", false, 1000, send)
      .catch((error: DeviceLinkError) => error.code);
    vi.setSystemTime(Date.now() + 2000);
    active.resolve();
    await Promise.all(running);
    expect(await next).toBe("BACKPRESSURE");
    expect(send).not.toHaveBeenCalled();
  });

  it("releases slots after rejection and synchronous throw without retrying", async () => {
    const scheduler = new InvokeScheduler();
    await expect(
      scheduler.run("a", true, 1000, () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    await expect(
      scheduler.run("a", true, 1000, async () => {
        throw new Error("async");
      }),
    ).rejects.toThrow("async");
    await expect(
      scheduler.run("a", true, 1000, async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("reserves waiting positions for user actions when background refreshes fill their queue", async () => {
    const scheduler = new InvokeScheduler();
    const active = deferred();
    const pending = Array.from({ length: 98 }, () =>
      scheduler.run("a", true, 30_000, () => active.promise).catch((e) => e),
    );
    await expect(
      scheduler.run("a", true, 30_000, async () => {}),
    ).rejects.toMatchObject({ code: "BACKPRESSURE" });
    await expect(
      scheduler.run("a", false, 30_000, async () => "tag"),
    ).resolves.toBe("tag");
    scheduler.clear(new DeviceLinkError("NOT_CONNECTED", "stop"));
    active.resolve();
    await Promise.all(pending);
  });

  it("classifies PR reads as background and keeps control/lease maintenance outside the queue", () => {
    expect(isBackgroundInvoke("git-context:pr-refs:list")).toBe(true);
    expect(isBackgroundInvoke("git-context:pr-status")).toBe(true);
    expect(isBackgroundInvoke("local-db:task-tags:execute")).toBe(false);
    expect(
      bypassInvokeScheduling({ channel: "device-link:subscribe", args: [] }),
    ).toBe(true);
    expect(
      bypassInvokeScheduling({
        channel: "device-link:remote-desktop:v1",
        args: [{ op: "heartbeat" }],
      }),
    ).toBe(true);
    expect(bypassInvokeScheduling({ channel: "maker:send", args: [] })).toBe(
      false,
    );
  });
});
