/**
 * annotationBurnInQueue.ts — 标注烧录 WebView 的任务队列与生命周期(纯逻辑)。
 * ---------------------------------------------------------------------------
 * AnnotationBurnInWebView 的 React hook 只负责把 WebView 挂上 / 摘下;任务串行、
 * 就绪握手、超时、进程崩溃与预热全部在这里,依赖注入 host 与计时器,node 可单测。
 *
 * 不变量:
 *   - 每次(重新)挂载都换一个新的 sessionKey。宿主以它作 WebView 的 React key,
 *     「卸载后立刻再挂载」被批处理合并时也一定是一次真实的重挂载,必然重新发
 *     ready——不会出现旧实现里 ready 已被清零、WebView 却没重建、任务永远等不到
 *     ready 的情况。旧 session 的迟到消息 / 崩溃事件按 key 丢弃。
 *   - 任务超时只覆盖真正注入 WebView 的队首任务(排队不计时);ready 超时只在
 *     有任务等待时计时(预热期间不计)。
 *   - WebView 进程被系统杀掉 / 加载失败时,队首任务立即失败(不再干等 30s),
 *     剩余任务在一个新挂载的 WebView 上继续;每次崩溃至少消耗一个任务,不会
 *     无限重挂载。
 *   - 没有任务、也没有预热持有者时卸载 WebView(空闲零开销)。
 */
import {
  buildAnnotationBurnInInvocation,
  parseAnnotationBurnInMessage,
  type AnnotationStroke,
} from '@/session/imageAnnotationModel';

export interface AnnotationBurnInInput {
  /** 原图字节(纯 base64,无 data: 前缀)。 */
  base64: string;
  mimeType: string;
  strokes: readonly AnnotationStroke[];
  /** 见 AnnotationBurnInRequest.strokeSpace。 */
  strokeSpace?: { width: number; height: number };
}

export interface AnnotationBurnInResult {
  base64: string;
  mimeType: string;
  /** 烧录输出的像素尺寸(0 = WebView 回包缺失):供上传前降采样决策使用。 */
  width: number;
  height: number;
}

/** 单次烧录超时:大图解码 + 编码在低端机上也应远低于此,超时视为失败降级。 */
export const BURN_IN_TIMEOUT_MS = 30_000;
/**
 * WebView 挂载 → ready 回包的兜底超时:WebView 加载失败 / JS 早退 / 低内存被杀
 * 时永远等不到 ready,任务级超时(注入时刻才起表)覆盖不到这段。
 */
export const WEBVIEW_READY_TIMEOUT_MS = 10_000;

export interface AnnotationBurnInQueueHost {
  /** 以新的 sessionKey 挂载(或重挂载)WebView。 */
  mount(sessionKey: number): void;
  /** 卸载 WebView。 */
  unmount(): void;
  /** 向 sessionKey 对应的 WebView 注入脚本;WebView 不可用时返回 false。 */
  inject(sessionKey: number, script: string): boolean;
}

export interface AnnotationBurnInQueueOptions {
  readyTimeoutMs?: number;
  jobTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface AnnotationBurnInQueue {
  burnIn(input: AnnotationBurnInInput): Promise<AnnotationBurnInResult>;
  /** 预热:持有期间 WebView 保持挂载(空闲也不卸载);返回幂等的释放函数。 */
  acquireWarm(): () => void;
  handleMessage(sessionKey: number, raw: string): void;
  /** WebView 进程终止 / 渲染进程消失 / 加载失败。 */
  handleProcessGone(sessionKey: number, reason: string): void;
  /** 宿主卸载:全部任务显式 reject 并清理计时器(之后仍可重新使用)。 */
  dispose(): void;
}

interface BurnInJob {
  id: string;
  input: AnnotationBurnInInput;
  resolve: (result: AnnotationBurnInResult) => void;
  reject: (error: Error) => void;
  /** 注入 WebView 时才起表;非 null = 已派发(必为队首)。 */
  timer: unknown;
  dispatched: boolean;
}

export function createAnnotationBurnInQueue(
  host: AnnotationBurnInQueueHost,
  options: AnnotationBurnInQueueOptions = {},
): AnnotationBurnInQueue {
  const readyTimeoutMs = options.readyTimeoutMs ?? WEBVIEW_READY_TIMEOUT_MS;
  const jobTimeoutMs = options.jobTimeoutMs ?? BURN_IN_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  const queue: BurnInJob[] = [];
  let jobSeq = 0;
  let keySeq = 0;
  /** 当前挂载的 WebView session;null = 未挂载。 */
  let sessionKey: number | null = null;
  let ready = false;
  let readyTimer: unknown = null;
  let warmCount = 0;

  function clearReadyTimer(): void {
    if (readyTimer !== null) clearTimer(readyTimer);
    readyTimer = null;
  }

  function mountFresh(): void {
    keySeq += 1;
    sessionKey = keySeq;
    ready = false;
    clearReadyTimer();
    host.mount(keySeq);
  }

  function unmount(): void {
    clearReadyTimer();
    ready = false;
    if (sessionKey === null) return;
    sessionKey = null;
    host.unmount();
  }

  function ensureMounted(): void {
    if (sessionKey === null) mountFresh();
  }

  function armReadyTimer(): void {
    if (ready || readyTimer !== null || queue.length === 0 || sessionKey === null) return;
    readyTimer = setTimer(() => {
      readyTimer = null;
      if (ready || queue.length === 0) return;
      failAllQueued(new Error('annotation burn-in webview failed to initialize'));
      // 起不来的 WebView 不再复用:预热中则换一个新实例(无任务不计时,不会循环),
      // 否则卸载,下次任务重新挂载重试。
      if (warmCount > 0) mountFresh();
      else unmount();
    }, readyTimeoutMs);
  }

  function failAllQueued(error: Error): void {
    const jobs = queue.splice(0);
    for (const job of jobs) {
      if (job.timer !== null) clearTimer(job.timer);
      job.reject(error);
    }
  }

  /** 队首任务落定后:继续派发下一个,或在空闲时卸载。 */
  function afterSettle(): void {
    if (queue.length > 0) {
      if (ready) dispatchHead();
      else armReadyTimer();
      return;
    }
    if (warmCount === 0) unmount();
  }

  /** WebView 不再可信(崩溃 / 超时):有后续需求则换新实例,否则卸载。 */
  function replaceWebView(): void {
    if (queue.length > 0 || warmCount > 0) {
      mountFresh();
      armReadyTimer();
    } else {
      unmount();
    }
  }

  function takeHead(job: BurnInJob): boolean {
    if (queue[0] !== job) return false;
    queue.shift();
    if (job.timer !== null) clearTimer(job.timer);
    job.timer = null;
    return true;
  }

  function dispatchHead(): void {
    const job = queue[0];
    if (!job || job.dispatched || !ready || sessionKey === null) return;
    job.dispatched = true;
    const key = sessionKey;
    job.timer = setTimer(() => {
      if (!takeHead(job)) return;
      job.reject(new Error('annotation burn-in timed out'));
      // 超时的 WebView 可能仍卡在解码大图上,后续任务在新实例上跑。
      replaceWebView();
    }, jobTimeoutMs);
    let injected = false;
    try {
      injected = host.inject(key, buildAnnotationBurnInInvocation({
        id: job.id,
        base64: job.input.base64,
        mimeType: job.input.mimeType,
        strokes: job.input.strokes,
        ...(job.input.strokeSpace ? { strokeSpace: job.input.strokeSpace } : {}),
      }));
    } catch {
      injected = false;
    }
    if (!injected) handleProcessGone(key, 'webview unavailable');
  }

  function handleProcessGone(key: number, reason: string): void {
    if (key !== sessionKey) return; // 旧实例的迟到事件
    ready = false;
    clearReadyTimer();
    const head = queue[0];
    if (head && takeHead(head)) {
      head.reject(new Error(`annotation burn-in webview terminated: ${reason}`));
    }
    replaceWebView();
  }

  return {
    burnIn(input) {
      return new Promise<AnnotationBurnInResult>((resolve, reject) => {
        jobSeq += 1;
        queue.push({ id: `burn-${jobSeq}`, input, resolve, reject, timer: null, dispatched: false });
        ensureMounted();
        if (ready) dispatchHead();
        else armReadyTimer();
      });
    },

    acquireWarm() {
      warmCount += 1;
      ensureMounted();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        warmCount = Math.max(0, warmCount - 1);
        if (warmCount === 0 && queue.length === 0) unmount();
      };
    },

    handleMessage(key, raw) {
      if (key !== sessionKey) return; // 旧实例的迟到消息
      const message = parseAnnotationBurnInMessage(raw);
      if (!message) return;
      if ('ready' in message) {
        ready = true;
        clearReadyTimer();
        dispatchHead();
        return;
      }
      const active = queue[0];
      // 过期回包(超时后到达 / 非队首)丢弃。
      if (!active || !active.dispatched || message.id !== active.id) return;
      takeHead(active);
      if (message.ok) {
        active.resolve({
          base64: message.base64,
          mimeType: message.mimeType,
          width: message.width,
          height: message.height,
        });
      } else {
        active.reject(new Error(`annotation burn-in failed: ${message.error}`));
      }
      afterSettle();
    },

    handleProcessGone,

    dispose() {
      clearReadyTimer();
      failAllQueued(new Error('annotation burn-in host unmounted'));
      warmCount = 0;
      ready = false;
      sessionKey = null;
    },
  };
}
