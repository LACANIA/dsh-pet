import {
  currentTaskFromTodo,
  completedState,
  goalUpdateAction,
  WORK_STATUS_PRIORITY,
  type HostWorkStatusState,
} from './work-status';

type State = HostWorkStatusState | null;
export const ACTIVITY_WINDOW_MS = 3000;
interface Operation {
  kind: string;
  label: string;
  at: number;
}
interface Offer {
  id: number;
  sessionId: string;
  title: string;
  pending: number;
}
export interface TrackedSession {
  id: string;
  title: string;
  state: State;
}
export interface ProgressSnapshot {
  state: State;
  task: string | null;
  progress: {
    mode: 'idle' | 'task';
    summary: string | null;
    action: 'typing' | 'viewing' | 'working' | null;
    offer: Offer | null;
    sessionId: string | null;
    sessionTitle: string | null;
    pinnedSessionId: string | null;
    sessions: TrackedSession[];
  };
}
interface Entry extends TrackedSession {
  running: boolean;
  operations: Operation[];
  task: string | null;
  todo: string | null;
  pending: Map<string, string>;
  order: number;
  seq: number;
  named: boolean;
  goalRound: boolean;
  closing: 'complete' | 'blocked' | null;
}
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f]/g;
const text = (value: unknown, max = 40): string =>
  typeof value === 'string'
    ? Array.from(value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('')
    : '';
const basename = (value: unknown): string => text(value, 500).split(/[\\/]/).pop() || '';

/** Public message text only; reasoning parts and tool results are never copied into bubbles. */
function messageText(value: unknown): string {
  const content = obj(value).content;
  if (typeof content === 'string') return text(content, 18);
  if (!Array.isArray(content)) return '';
  return text(
    content
      .filter((part) => obj(part).type === 'text')
      .map((part) => obj(part).text)
      .join(' '),
    18,
  );
}

/** Compact operation labels from known fields, without dumping arguments or command output. */
export function toolProgressText(name: unknown, args: unknown): string {
  const tool = text(name, 64).split(/[/.]/).pop()?.toLowerCase() || '工具';
  let data: Record<string, unknown> = {};
  try {
    data = obj(typeof args === 'string' ? JSON.parse(args) : args);
  } catch {
    /* use the tool label */
  }
  const fullFile = basename(data.file_path ?? data.filePath ?? data.path ?? data.image_path ?? data.imagePath);
  const file = text(fullFile, 22);
  if (
    /^(view_image|viewimage|read_image|read_images|open_image|openimage|image_view)$/.test(tool) ||
    (/^(read|read_file|readfile)$/.test(tool) && /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|ico|avif)$/i.test(fullFile))
  )
    return '正在查看图片' + (file ? ' ' + file : '');
  if (/^(read|read_file|readfile)$/.test(tool)) return '正在读取' + (file ? ' ' + file : '文件');
  if (/^(write|write_file|edit|edit_file|apply_patch)$/.test(tool)) return '正在修改' + (file ? ' ' + file : '文件');
  if (/^(grep|glob|search|rg|find)$/.test(tool)) return '正在搜索代码';
  if (/^(bash|shell|exec|exec_command|run_command|execute)$/.test(tool)) {
    const command = text(data.command ?? data.cmd, 500);
    // Show a short executable/action, rather than flags, environment variables or credentials.
    const safe = command.match(/^(npm|pnpm|yarn|git|python3?|pytest|node|cargo|go)\s+(?:run\s+)?[\w.-]+/);
    return safe ? '正在执行 ' + text(safe[0], 28) : '正在执行命令';
  }
  if (tool === 'ask_user_question') return '等待你的选择';
  return '正在调用 ' + text(tool, 24);
}

/** Experimental in-memory monitor; selection never follows the foreground chat. */
export class TaskProgressStore {
  declare private readonly entries: Map<string, Entry>;
  declare private pinned: string | null;
  declare private order: number;
  declare private mode: 'idle' | 'task';
  declare private readonly clock: () => number;
  declare private readonly offers: Map<string, number>;
  declare private offerSeq: number;
  declare private following: string | null;
  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.offers = new Map();
    this.offerSeq = 0;
    this.following = null;
    this.entries = new Map();
    this.pinned = null;
    this.order = 0;
    this.mode = 'idle';
  }

  setMode(mode: 'idle' | 'task'): void {
    this.mode = mode;
    if (mode === 'idle') this.offers.clear();
    else {
      if (!this.pinned) this.following = this.chosen()?.id ?? null;
      if (this.pinned ?? this.following) this.offers.delete((this.pinned ?? this.following)!);
    }
  }

  select(id: string | null): boolean {
    if (id !== null && !this.entries.has(id)) return false;
    this.pinned = id;
    this.following = null;
    if (id === null && this.mode === 'task') this.following = this.chosen()?.id ?? null;
    return true;
  }

  isTaskMode(): boolean {
    return this.mode === 'task';
  }

  respondOffer(id: number, accept: boolean): boolean {
    const item = [...this.offers].find(([, value]) => value === id);
    if (!item || !this.entries.get(item[0])?.running) return false;
    this.offers.delete(item[0]);
    if (accept) {
      this.pinned = item[0];
      this.following = null;
      this.mode = 'task';
    }
    return true;
  }

  private chosen(): Entry | undefined {
    const explicit = this.pinned ?? this.following;
    return explicit
      ? this.entries.get(explicit)
      : [...this.entries.values()]
          .filter((e) => e.state)
          .sort((a, b) => WORK_STATUS_PRIORITY[b.state!] - WORK_STATUS_PRIORITY[a.state!] || b.order - a.order)[0];
  }

  private summary(entry: Entry | undefined): string | null {
    if (!entry || !['working', 'thinking'].includes(entry.state ?? '')) return null;
    const recent = entry.operations.filter((v) => this.clock() - v.at < ACTIVITY_WINDOW_MS);
    if (!recent.length) return null;
    if (recent.length === 1)
      return entry.state === 'working' ? entry.task : '刚才：' + recent[0].label.replace(/^正在/, '');
    const groups = new Map<string, number>();
    for (const operation of recent) groups.set(operation.kind, (groups.get(operation.kind) ?? 0) + 1);
    const latestKind = recent[recent.length - 1].kind;
    const parts = [...groups]
      .sort(([a], [b]) => Number(b === latestKind) - Number(a === latestKind))
      .map(
        ([kind, count]) =>
          kind + ' ' + count + (kind === '读取' || kind === '修改' ? ' 个文件' : kind === '查看图片' ? ' 张' : ' 次'),
      );
    return '最近：' + parts.slice(0, 2).join(' · ') + (parts.length > 2 ? ' 等操作' : '');
  }

  clear(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.state = null;
      entry.running = false;
      entry.operations = [];
      this.offers.delete(id);
      entry.task = null;
      entry.todo = null;
      entry.pending.clear();
    }
  }

  accept(session: unknown, event: unknown): boolean {
    const header = obj(obj(session).header);
    if (header.origin === 'subagent' || Number(header.delegationDepth) > 0) return false;
    const id = text(header.id ?? obj(session).id, 256);
    const e = obj(event),
      data = obj(e.data);
    const type = String(e.type ?? '');
    if (
      !id ||
      ![
        'turn/start',
        'step/start',
        'user/message',
        'tool/call',
        'tool/result',
        'todo/write',
        'approval/asked',
        'turn/end',
      ].includes(type)
    )
      return false;
    let entry = this.entries.get(id);
    if (entry && typeof e.seq === 'number' && e.seq <= entry.seq) return false;
    if (!entry) {
      // Bound retained sessions; the selected session is never evicted.
      if (this.entries.size >= 32) {
        const oldest = [...this.entries.values()]
          .filter((v) => v.id !== this.pinned && v.id !== this.following)
          .sort((a, b) => a.order - b.order)[0];
        if (oldest) {
          this.entries.delete(oldest.id);
          this.offers.delete(oldest.id);
        }
      }
      const title = text(obj(session).title, 18);
      entry = {
        id,
        title: title || '会话 ' + id.slice(-6),
        running: false,
        operations: [],
        state: null,
        task: null,
        todo: null,
        pending: new Map(),
        order: 0,
        seq: -1,
        named: !!title,
        goalRound: false,
        closing: null,
      };
      this.entries.set(id, entry);
    }
    const trackedId = this.chosen()?.id;
    entry.order = ++this.order;
    if (typeof e.seq === 'number') entry.seq = e.seq;
    if (type === 'user/message') {
      if (obj(data.source).kind === 'goal') entry.goalRound = true;
      if (!entry.named && !['goal', 'inject', 'context'].includes(String(obj(data.source).kind ?? ''))) {
        const title = messageText(data.message ?? data);
        if (title) {
          entry.title = title;
          entry.named = true;
        }
      }
    } else if (type === 'turn/start') {
      if (!entry.running && !(this.mode === 'task' && trackedId === id)) this.offers.set(id, ++this.offerSeq);
      entry.running = true;
      entry.operations = [];
      entry.state = 'thinking';
      entry.task = null;
      entry.todo = null;
      entry.pending.clear();
      entry.goalRound = false;
      entry.closing = null;
    } else if (type === 'step/start') {
      if (!entry.pending.size) {
        entry.state = 'thinking';
        entry.task = null;
      }
    } else if (type === 'tool/call') {
      if (!entry.running) {
        entry.running = true;
        if (!(this.mode === 'task' && trackedId === id)) this.offers.set(id, ++this.offerSeq);
      }
      const summary = toolProgressText(data.name, data.arguments);
      const kind = summary.includes('查看图片')
        ? '查看图片'
        : summary.includes('读取')
          ? '读取'
          : summary.includes('修改')
            ? '修改'
            : summary.includes('搜索')
              ? '搜索'
              : summary.includes('执行')
                ? '执行'
                : '调用工具';
      entry.operations = entry.operations.filter((v) => this.clock() - v.at < ACTIVITY_WINDOW_MS).slice(-127);
      entry.operations.push({ kind, label: summary, at: this.clock() });
      if (data.name === 'update_goal' && typeof data.arguments === 'string')
        entry.closing = goalUpdateAction(data.arguments);
      entry.pending.set(String(data.callId ?? data.name ?? 'tool'), summary);
      entry.state = data.name === 'ask_user_question' ? 'waiting' : 'working';
      entry.task = summary;
    } else if (type === 'tool/result') {
      const callId = data.callId ?? obj(data.message).toolCallId ?? obj(obj(data.message).source).callId;
      if (callId === undefined) entry.pending.clear();
      else entry.pending.delete(String(callId));
      entry.state = entry.pending.size ? 'working' : 'thinking';
      entry.task = [...entry.pending.values()].pop() ?? null;
    } else if (type === 'todo/write') {
      entry.todo = currentTaskFromTodo({ data: { todos: Array.isArray(data.todos) ? data.todos : [] } });
      if (entry.state === 'working') entry.task = entry.todo ?? [...entry.pending.values()].pop() ?? null;
    } else if (type === 'approval/asked') {
      entry.state = 'waiting';
      entry.task = '需要你确认权限';
    } else if (type === 'turn/end') {
      const kind = obj(data.reason).kind;
      entry.pending.clear();
      entry.state =
        kind === 'completed'
          ? completedState(entry)
          : kind === 'blocked'
            ? 'waiting'
            : ['error', 'timeout', 'max-tokens'].includes(String(kind))
              ? 'error'
              : null;
      if (entry.state === 'success' || entry.state === 'error' || entry.state === null) {
        entry.running = false;
        entry.operations = [];
        this.offers.delete(id);
        if (this.mode === 'task' && trackedId === id) {
          this.mode = 'idle';
          this.following = null;
        }
      }
      entry.task =
        entry.state === 'success'
          ? '任务已完成'
          : entry.state === 'error'
            ? '执行遇到问题'
            : entry.state === 'waiting'
              ? '等待你的操作'
              : entry.state === 'result'
                ? '继续执行任务'
                : null;
    }
    if (this.mode === 'task' && !this.pinned && !this.following && entry.state) this.following = id;
    return true;
  }

  snapshot(): ProgressSnapshot {
    const sorted = [...this.entries.values()].sort((a, b) => b.order - a.order);
    const selected = this.chosen();
    const summary = this.summary(selected);
    const operation =
      selected?.state === 'working'
        ? [...selected.pending.values()].pop()
        : selected?.state === 'thinking' && summary
          ? selected.operations[selected.operations.length - 1]?.label
          : null;
    const action = !operation
      ? null
      : operation.startsWith('正在修改')
        ? 'typing'
        : operation.startsWith('正在查看图片')
          ? 'viewing'
          : 'working';
    const queued = [...this.offers].filter(([id]) => this.entries.get(id)?.running);
    const first = queued[0];
    const offer =
      this.mode === 'idle' && first
        ? { id: first[1], sessionId: first[0], title: this.entries.get(first[0])!.title, pending: queued.length }
        : null;
    return {
      state: selected?.state ?? null,
      task: selected?.task ?? null,
      progress: {
        mode: this.mode,
        summary,
        action,
        offer,
        sessionId: selected?.id ?? null,
        sessionTitle: selected?.title ?? null,
        pinnedSessionId: this.pinned,
        sessions: sorted.map(({ id, title, state }) => ({ id, title, state })),
      },
    };
  }
}

/** Keep recent transitions so a fast tool result cannot erase its preceding call in a long poll. */
export class TaskProgressTimeline {
  declare private frames: Array<ProgressSnapshot & { seq: number; at: number }>;
  declare private signature: string;
  declare private source: string | null | undefined;
  declare private stream: string;
  declare private seq: number;
  declare private readonly clock: () => number;
  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.frames = [];
    this.signature = '';
    this.source = undefined;
    this.seq = 0;
    this.stream = String(clock());
  }
  capture(snapshot: ProgressSnapshot) {
    const signature = JSON.stringify(snapshot);
    if (signature !== this.signature) {
      if (snapshot.progress.sessionId !== this.source) {
        this.source = snapshot.progress.sessionId;
        this.stream = String(this.clock()) + ':' + ++this.seq;
        this.frames = [];
      }
      this.signature = signature;
      this.frames.push({ ...snapshot, seq: ++this.seq, at: this.clock() });
      this.frames = this.frames.slice(-256);
    }
    return { ...snapshot, progress: { ...snapshot.progress, timeline: { stream: this.stream, frames: this.frames } } };
  }
}
