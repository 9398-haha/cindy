import { DeviceLinkError } from "./protocol.js";

const MAX_ACTIVE = 8;
const MAX_BACKGROUND_ACTIVE = 2;
const MAX_QUEUED = 128;
// Background refreshes cannot consume the last waiting positions for user actions.
const MAX_BACKGROUND_QUEUED = 96;

interface Job {
  background: boolean;
  start(): void;
  cancel(error: DeviceLinkError): void;
}
interface PeerQueue {
  active: number;
  background: number;
  jobs: Job[];
}

/** Local admission only: never retries or cancels an operation already sent. */
export class InvokeScheduler {
  private readonly peers = new Map<string, PeerQueue>();

  run<T>(
    deviceId: string,
    background: boolean,
    waitMs: number,
    run: () => Promise<T>,
  ): Promise<T> {
    let peer = this.peers.get(deviceId);
    if (!peer) {
      peer = { active: 0, background: 0, jobs: [] };
      this.peers.set(deviceId, peer);
    }
    const state = peer;
    if (
      state.jobs.length >= (background ? MAX_BACKGROUND_QUEUED : MAX_QUEUED)
    ) {
      return Promise.reject(
        new DeviceLinkError(
          "BACKPRESSURE",
          "local remote invoke queue is full",
        ),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const queuedAt = Date.now();
      const job: Job = {
        background,
        cancel: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        start: () => {
          clearTimeout(timer);
          // A suspended app may resume before its expired timers run. Never send stale work.
          if (Date.now() - queuedAt >= waitMs) {
            reject(
              new DeviceLinkError(
                "BACKPRESSURE",
                "remote invoke expired before dispatch",
              ),
            );
            return;
          }
          state.active++;
          if (background) state.background++;
          let result: Promise<T>;
          try {
            result = run();
          } catch (error) {
            result = Promise.reject(error);
          }
          void result.then(resolve, reject).finally(() => {
            state.active--;
            if (background) state.background--;
            this.drain(deviceId, state);
          });
        },
      };
      const timer = setTimeout(() => {
        const index = state.jobs.indexOf(job);
        if (index < 0) return;
        state.jobs.splice(index, 1);
        job.cancel(
          new DeviceLinkError(
            "BACKPRESSURE",
            "remote invoke expired before dispatch",
          ),
        );
        this.drain(deviceId, state);
      }, waitMs);
      state.jobs.push(job);
      this.drain(deviceId, state);
    });
  }

  /** Keep active slots until their promises settle, including across reconnects. */
  cancel(deviceId: string, error: DeviceLinkError): void {
    const state = this.peers.get(deviceId);
    if (!state) return;
    for (const job of state.jobs.splice(0)) {
      // The transport may mark its error inFlight later; queued calls were never sent.
      job.cancel(new DeviceLinkError(error.code, error.message));
    }
    this.drain(deviceId, state);
  }

  clear(error: DeviceLinkError): void {
    for (const deviceId of this.peers.keys()) this.cancel(deviceId, error);
  }

  private drain(deviceId: string, state: PeerQueue): void {
    while (state.active < MAX_ACTIVE && state.jobs.length) {
      let index = state.jobs.findIndex((job) => !job.background);
      if (index < 0) {
        if (state.background >= MAX_BACKGROUND_ACTIVE) break;
        index = 0;
      }
      state.jobs.splice(index, 1)[0].start();
    }
    if (!state.active && !state.jobs.length) this.peers.delete(deviceId);
  }
}
