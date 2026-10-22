import type { Animations, EventSlot } from './types';
// 工作状态联动（workStatus）——浏览器侧纯逻辑（src/shared 单一来源）。
// host 侧（src/host/work-status.ts）有自己的自包含实现（DSH 单文件加载约束，host 不 import 本目录），
// 负责监听 session/event 聚合成快照并写进 /state 的 sections.workStatus；本模块只做：
//   档位常量（WORK_STATUS_STATES / WORK_STATUS_INDEX，与 events.workStatus 数组索引一致）+ 叶子解析。
//   气泡文案不在代码里：浏览器直接读配置 events.workStatusTexts（host 不内置文案）。
// 纯函数无副作用；不依赖 React/DOM。

/** 工作状态档位（对应 animations.events.workStatus 数组索引，顺序即档位，勿在中间插入新档） */
export const WORK_STATUS_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'] as const;
export type WorkStatusState = (typeof WORK_STATUS_STATES)[number];

/** 档位 → workStatus 数组索引（与 events.workStatus 数组顺序严格一致） */
export const WORK_STATUS_INDEX: Record<WorkStatusState, number> = {
  thinking: 0, // turn/start → 思考
  working: 1, // tool/call → 工作
  result: 2, // tool/result → 整理
  waiting: 3, // approval/asked → 等待
  success: 4, // turn/end completed → 完成
  error: 5, // turn/end error/max-tokens → 出错
};

/** 工作状态快照（= /state 里 sections.workStatus 的 data，与 host 的 WorkStatusSnapshot 同构）。
 *  没有 ts：「变了没有」由叶子的 counter 承担（ts 是改造前的第二信号，已删）。
 *  text 不在此：气泡文案由客户端读配置 events.workStatusTexts，host 不生成。 */
export interface WorkStatusSnapshot {
  state: WorkStatusState | null; // null = 空闲
  task: string | null; // 当前任务详情（todo/write 提供，可 null）
  progress?: TaskProgress;
}

export interface TaskProgress {
  mode: 'idle' | 'task';
  summary?: string | null;
  action?: 'typing' | 'viewing' | 'working' | null;
  timeline?: { stream: string; frames: WorkStatusFrame[] };
  offer?: { id: number; sessionId: string; title: string; pending: number } | null;
  sessionId: string | null;
  sessionTitle: string | null;
  pinnedSessionId: string | null;
  sessions: Array<{ id: string; title: string; state: WorkStatusState | null }>;
}

export interface WorkStatusFrame extends WorkStatusSnapshot {
  seq: number;
  at: number;
}

export function workAction(snapshot: WorkStatusSnapshot | null | undefined): TaskProgress['action'] {
  const progress = snapshot?.progress;
  if (progress?.mode !== 'task') return null;
  if (progress.action !== undefined) return progress.action;
  // Compatibility with an already-running host from the earlier local build.
  const label = snapshot?.state === 'working' ? snapshot.task || progress.summary : progress.summary;
  if (!label) return null;
  if (/^(?:正在|刚才：|最近：)?修改/.test(label)) return 'typing';
  if (/^(?:正在|刚才：|最近：)?查看图片/.test(label)) return 'viewing';
  return 'working';
}

/** Retained activity text and its animation finish together before returning to pure thinking. */
export function workAnimationState(snapshot: WorkStatusSnapshot | null | undefined): WorkStatusState | null {
  if (
    snapshot?.state === 'thinking' &&
    snapshot.progress?.mode === 'task' &&
    snapshot.progress.summary &&
    workAction(snapshot)
  )
    return 'working';
  return snapshot?.state ?? null;
}

export function workAnimationKey(snapshot: WorkStatusSnapshot | null | undefined): string | null {
  const state = workAnimationState(snapshot);
  return state
    ? state + (state === 'working' && snapshot?.progress?.mode === 'task' ? ':' + workAction(snapshot) : '')
    : null;
}

/** Reuse assets declared by this pet; custom pets without these names retain their configured work slot. */
export function workAnimationSlot(
  snapshot: WorkStatusSnapshot | null | undefined,
  animations: Animations,
): EventSlot | undefined {
  const state = workAnimationState(snapshot);
  if (!state) return undefined;
  if (state === 'working' && snapshot?.progress?.mode === 'task') {
    const action = workAction(snapshot);
    if (action === 'typing' && animations.categories.some((c) => c.actions.includes('写代码'))) return '写代码';
    if (action === 'viewing' && animations.turn.includes('东张西望')) return '东张西望';
  }
  return animations.events?.workStatus?.[WORK_STATUS_INDEX[state]];
}

export function workStatusText(snapshot: WorkStatusSnapshot, fallback?: string): string | null {
  if (snapshot.progress?.mode !== 'task') return snapshot.task || fallback || null;
  if (!snapshot.state) return null;
  if (snapshot.state === 'thinking' && !snapshot.progress.summary) return '💡';
  const label = snapshot.progress.summary || snapshot.task || fallback || '正在执行任务';
  return snapshot.progress.sessionTitle ? snapshot.progress.sessionTitle + '\n' + label : label;
}

export const TASK_PROGRESS_CSS =
  '.is-task-progress{font-size:max(11px,calc(var(--f)*.7473))!important}.is-task-progress .pet-bub-row{white-space:pre-line}.is-task-thinking{min-width:1em!important;text-align:center;padding:.25em .4em!important}.is-task-thinking .pet-bub-row{font-size:0;display:block;width:calc(var(--f)*1.5);height:calc(var(--f)*1.7);background:center/contain no-repeat url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2028%22%20fill%3D%22none%22%20stroke%3D%22%23c58a12%22%20stroke-width%3D%221.8%22%20stroke-linecap%3D%22round%22%3E%3Cpath%20fill%3D%22%23ffe48a%22%20d%3D%22M7%2017a7%207%200%201%201%2010%200c-2%202-2%203-2%204H9c0-1%200-2-2-4Z%22%2F%3E%3Cpath%20d%3D%22M9%2024h6m-5%203h4M12%201v1M2%205l1%201m18-1-1%201M1%2012h1m20%200h1%22%2F%3E%3C%2Fsvg%3E")}';

/** 快照解析：档位不认识 → 归一成 null（空闲）；形状非法 → null（消费端跳过这一拍，不抛） */
export function toWorkStatus(raw: unknown): WorkStatusSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { state?: unknown; task?: unknown; progress?: unknown };
  const state: WorkStatusState | null =
    r.state === null || (typeof r.state === 'string' && (WORK_STATUS_STATES as readonly string[]).includes(r.state))
      ? (r.state as WorkStatusState | null)
      : null;
  const result: WorkStatusSnapshot = { state, task: typeof r.task === 'string' ? r.task : null };
  if (r.progress && typeof r.progress === 'object') {
    const p = r.progress as Partial<TaskProgress>;
    result.progress = {
      mode: p.mode === 'task' ? 'task' : 'idle',
      summary: typeof p.summary === 'string' ? p.summary.slice(0, 100) : null,
      ...(p.action !== undefined
        ? { action: p.action === 'typing' || p.action === 'viewing' || p.action === 'working' ? p.action : null }
        : {}),
      offer:
        p.offer &&
        Number.isSafeInteger(p.offer.id) &&
        typeof p.offer.sessionId === 'string' &&
        typeof p.offer.title === 'string'
          ? {
              id: p.offer.id,
              sessionId: p.offer.sessionId,
              title: p.offer.title.slice(0, 80),
              pending: Math.max(1, Math.min(32, Number(p.offer.pending) || 1)),
            }
          : null,
      sessionId: typeof p.sessionId === 'string' ? p.sessionId : null,
      sessionTitle: typeof p.sessionTitle === 'string' ? p.sessionTitle.slice(0, 80) : null,
      pinnedSessionId: typeof p.pinnedSessionId === 'string' ? p.pinnedSessionId : null,
      sessions: Array.isArray(p.sessions)
        ? p.sessions
            .filter((s) => s && typeof s.id === 'string' && typeof s.title === 'string')
            .slice(0, 32)
            .map((s) => ({
              id: s.id,
              title: s.title.slice(0, 80),
              state: WORK_STATUS_STATES.includes(s.state as WorkStatusState) ? s.state : null,
            }))
        : [],
    };
    if (p.timeline && typeof p.timeline.stream === 'string' && Array.isArray(p.timeline.frames)) {
      const frames: WorkStatusFrame[] = [];
      for (const frame of p.timeline.frames.slice(-256)) {
        if (!frame || !Number.isSafeInteger(frame.seq) || !Number.isFinite(frame.at)) continue;
        const parsed = toWorkStatus({
          ...frame,
          progress: frame.progress ? { ...frame.progress, timeline: undefined } : undefined,
        });
        if (parsed) frames.push({ ...parsed, seq: frame.seq, at: frame.at });
      }
      result.progress.timeline = { stream: p.timeline.stream.slice(0, 100), frames };
    }
  }
  return result;
}

export const TASK_DISPLAY_DELAY_MS = 300;

interface ThinkingInterval {
  start: number;
  end: number | null;
}

/** Shift text and animation together, using the same window to omit short thinking intervals. */
export class WorkStatusPlayback {
  declare private stream: string | null;
  declare private cursor: number;
  declare private queue: Array<{ frame: WorkStatusFrame; thinking: ThinkingInterval | null }>;
  declare private thinking: ThinkingInterval | null;
  declare private timer: ReturnType<typeof setTimeout> | null;
  declare private readonly display: (snapshot: WorkStatusSnapshot) => void;
  declare private readonly clock: () => number;
  declare private readonly schedule: typeof setTimeout;
  declare private readonly cancel: typeof clearTimeout;
  constructor(
    display: (snapshot: WorkStatusSnapshot) => void,
    clock: () => number = Date.now,
    schedule: typeof setTimeout = setTimeout,
    cancel: typeof clearTimeout = clearTimeout,
  ) {
    this.stream = null;
    this.cursor = 0;
    this.queue = [];
    this.thinking = null;
    this.timer = null;
    this.display = display;
    this.clock = clock;
    this.schedule = schedule;
    this.cancel = cancel;
  }
  push(snapshot: WorkStatusSnapshot): void {
    const timeline = snapshot.progress?.timeline;
    if (!timeline?.frames.length) {
      this.dispose();
      this.display(snapshot);
      return;
    }
    let skipBefore = 0;
    if (timeline.stream !== this.stream) {
      const alreadyConnected = this.stream !== null;
      this.dispose();
      this.stream = timeline.stream;
      // A newly opened window starts at the latest state, rather than replaying old tasks.
      skipBefore = alreadyConnected ? 0 : timeline.frames[timeline.frames.length - 1].seq - 1;
    }
    for (const frame of timeline.frames) {
      if (frame.seq <= this.cursor) continue;
      if (frame.state === 'thinking' && frame.progress?.mode === 'task') {
        this.thinking ??= { start: frame.at, end: null };
      } else if (this.thinking) {
        this.thinking.end = frame.at;
        this.thinking = null;
      }
      if (frame.seq > skipBefore) this.queue.push({ frame, thinking: this.thinking });
      this.cursor = frame.seq;
    }
    this.queue = this.queue.slice(-256);
    this.arm();
  }
  private arm(): void {
    if (this.timer !== null || !this.queue.length) return;
    const next = this.queue[0];
    const schedule = this.schedule;
    this.timer = schedule(
      () => {
        this.timer = null;
        const next = this.queue.shift();
        if (next) {
          const { frame, thinking } = next;
          const short =
            thinking !== null && thinking.end !== null && thinking.end - thinking.start < TASK_DISPLAY_DELAY_MS;
          if (!short) this.display(frame);
        }
        this.arm();
      },
      Math.max(0, next.frame.at + TASK_DISPLAY_DELAY_MS - this.clock()),
    );
  }
  dispose(): void {
    const cancel = this.cancel;
    if (this.timer !== null) cancel(this.timer);
    this.timer = null;
    this.queue = [];
    this.thinking = null;
    this.stream = null;
    this.cursor = 0;
  }
}
