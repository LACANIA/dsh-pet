/**
 * 为宿主与桌面进程提供批量文件日志；不负责业务日志内容，依赖 Node 文件系统。
 * 运行期间先缓冲，到达条数或时间阈值后串行提交；目录准备、大小检查与读取采用异步操作，
 * 追加与截断同步完成，使退出路径可以准确区分尚未提交的批次并补写，避免遗漏或重复。
 * 缓冲超限丢弃最旧日志，文件超限保留尾部；写盘失败静默，避免日志出口影响业务与退出清理。
 * @module dsh-pet/src/host/log-file
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 日志级别（与 DSH 的 `ctx.logger` 四档一致）。 */
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/** 与 DSH 的 `ctx.logger` 使用面一致的最小接口（各方法都可缺省）。 */
export interface LoggerLike {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
  debug?(message: string): void;
}

/** 文件日志出口：在 LoggerLike 之上多一个落盘句柄与身份标记。 */
export interface FileLogger extends Required<LoggerLike> {
  /** 日志文件路径（宿主据此判断能否复用，避免两个 logger 写同一个文件） */
  readonly file: string;
  /** 身份标记：`isFileLogger` 用它识别「这个 logger 已经是文件出口」 */
  readonly isFileLogger: true;
  /**
   * 把缓冲区写盘（并做大小检查）。可安全重复调用；并发调用共享同一次写入。
   * 调用方在进程退出前应 await 它。
   */
  flush(): Promise<void>;
  /** 停掉定时器并同步补写未提交日志；已启动的异步检查结束后不再截断文件。 */
  dispose(): void;
}

/** 判断一个对象是否已是本模块创建的文件 logger（standalone/app 会把它挂在 ctx.logger 上）。 */
export function isFileLogger(value: unknown): value is FileLogger {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { isFileLogger?: unknown; flush?: unknown; file?: unknown };
  return candidate.isFileLogger === true && typeof candidate.flush === 'function' && typeof candidate.file === 'string';
}

/** createFileLogger 的选项；全部可选，缺省值见下方常量。 */
export interface FileLoggerOptions {
  /** 日志文件绝对路径（父目录不存在会自动创建） */
  file: string;
  /** 原始终端/宿主 logger：日志同时转发给它，node 版终端里照旧可见 */
  base?: LoggerLike;
  /** 单文件上限，默认 1 MiB */
  maxBytes?: number;
  /** 超过上限后保留的尾部大小，默认 512 KiB */
  keepBytes?: number;
  /** 定时 flush 间隔，默认 1000ms */
  flushIntervalMs?: number;
  /** 攒够多少条立即 flush，默认 64 */
  flushThreshold?: number;
  /** 内存里最多缓冲多少条（超出丢最旧），默认 1000 */
  maxPending?: number;
  /** debug 级别是否落盘，默认关（`DSH_PET_LOG_DEBUG=1` 打开） */
  debugEnabled?: boolean;
  /** 时间源（测试注入用） */
  now?: () => Date;
}

/** 单文件上限：1 MiB。 */
export const LOG_MAX_BYTES = 1024 * 1024;
/** 截断后保留的尾部：512 KiB。 */
export const LOG_KEEP_BYTES = 512 * 1024;
/** 定时 flush 间隔。 */
export const LOG_FLUSH_MS = 1000;
/** 攒够多少条立即 flush。 */
export const LOG_FLUSH_LINES = 64;
/** 内存缓冲上限。 */
export const LOG_MAX_PENDING = 1000;

/**
 * 落盘前的脱敏：令牌等价登录态，不能因为「顺手记一行日志」就写进文件。
 * 只处理已知会出现在日志里的几种形态，宁可误伤（把值打码）也不漏。
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/(x-dsh-pet-token["'\s:=]+)[A-Za-z0-9_-]{16,}/gi, '$1***')
    .replace(/(token["'\s:=]+)[A-Za-z0-9_-]{32,}/gi, '$1***')
    .replace(/(#token=)[A-Za-z0-9_-]{16,}/g, '$1***')
    .replace(/(DSH_PET_SITE_URL=)\S+/g, '$1***');
}

/** 截断时保留尾部 `keepBytes` 字节；取尾部会切断多字节字符，调用方只用于拼日志文本，可接受。 */
export function tailForTrim(content: Buffer, keepBytes: number): Buffer {
  if (content.length <= keepBytes) return content;
  return content.subarray(content.length - keepBytes);
}

/** 一行日志的最终形态：`<ISO 时间> [级别] 正文`（正文里的换行保留，便于堆栈可读）。 */
export function formatLogLine(level: LogLevel, message: string, now: Date): string {
  return `${now.toISOString()} [${level}] ${message}\n`;
}

/** 创建一个文件日志出口：日志同时转发给 `base`，落盘按批量与大小上限处理。 */
export function createFileLogger(options: FileLoggerOptions): FileLogger {
  const file = options.file;
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const keepBytes = Math.max(0, Math.min(options.keepBytes ?? LOG_KEEP_BYTES, maxBytes));
  const flushMs = options.flushIntervalMs ?? LOG_FLUSH_MS;
  const threshold = Math.max(1, options.flushThreshold ?? LOG_FLUSH_LINES);
  const maxPending = Math.max(threshold, options.maxPending ?? LOG_MAX_PENDING);
  const debugEnabled = options.debugEnabled ?? false;
  const now = options.now ?? (() => new Date());

  let pending: string[] = [];
  let dropped = 0;
  /** 已离开 pending、正在等待目录准备的批次；提交前始终可由退出路径补写。 */
  let activeChunk = '';
  let flushing: Promise<void> | null = null;
  let disposed = false;
  /** 目录只建一次（首次 flush 时）；失败后不再重试，日志静默降级 */
  let dirReady: Promise<void> | null = null;
  const ensureDir = (): Promise<void> =>
    (dirReady ??= mkdir(dirname(file), { recursive: true })
      .then(() => undefined)
      .catch(() => undefined));

  const takePending = (): string => {
    const note = dropped > 0 ? formatLogLine('warn', `日志缓冲溢出，丢弃 ${dropped} 条`, now()) : '';
    const chunk = note + pending.join('');
    pending = [];
    dropped = 0;
    return chunk;
  };

  /** 退出与 dispose 共用；批次追加没有异步写入窗口，因此只需补尚未提交的内容。 */
  const flushSync = (): void => {
    const chunk = activeChunk + takePending();
    activeChunk = '';
    if (!chunk) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, chunk, 'utf8');
    } catch {
      /* 日志写入失败不影响退出清理 */
    }
  };

  const push = (level: LogLevel, message: string): void => {
    if (level === 'debug' && !debugEnabled) return;
    // 转发给原 logger 必须在自己的 try 里：宿主 logger 抛错不能影响落盘，更不能递归打日志
    try {
      options.base?.[level]?.(message);
    } catch {
      /* 忽略：日志出口自己不许成为故障源 */
    }
    pending.push(formatLogLine(level, redactSensitive(String(message)), now()));
    if (pending.length > maxPending) {
      // 丢弃最旧的一批：日志风暴时保住内存，也保住最近的现场
      dropped += pending.length - maxPending;
      pending.splice(0, pending.length - maxPending);
    }
    // app 的退出清理可能在 dispose 之后继续记录日志；此时没有定时器与 exit 监听可依赖。
    if (disposed) flushSync();
    else if (pending.length >= threshold) void flush();
  };

  const flush = async (): Promise<void> => {
    // 循环而不是「等一次就返回」：调用方在写入过程中调 flush 时，缓冲里可能还有后到的行，
    // 只等当前那次写盘会把它们留在内存里（表现为「最后几条日志不见了」）。
    for (;;) {
      if (disposed) {
        flushSync();
        return;
      }
      if (flushing) {
        await flushing;
        continue;
      }
      if (pending.length === 0) return;
      activeChunk = takePending();
      flushing = (async () => {
        await ensureDir();
        try {
          // 追加与清空标记在同一段同步执行；dispose 若已补写，这里不会重复追加。
          const chunk = activeChunk;
          activeChunk = '';
          if (chunk) appendFileSync(file, chunk, 'utf8');
        } catch {
          return; // 写盘失败：静默。日志系统不能因为磁盘问题把宿主拖垮
        }
        if (disposed) return;
        try {
          // 大小检查放在 flush 之后、每次 flush 至多一次 stat：这是「不每条碰盘」的关键
          const info = await stat(file);
          if (!disposed && info.size > maxBytes) {
            const content = await readFile(file);
            // 读取期间若已 dispose，退出补写的日志可能在读取快照之外，不能再用旧内容覆盖。
            if (!disposed) writeFileSync(file, tailForTrim(content, keepBytes));
          }
        } catch {
          /* 截断失败不影响后续写入（下一次 flush 会再试） */
        }
      })().finally(() => {
        flushing = null;
      });
      await flushing;
    }
  };

  const timer = setInterval(() => {
    void flush();
  }, flushMs);
  // 不阻止进程退出：宿主该退就退，最后一批由下面的 exit 钩子同步补齐
  timer.unref?.();

  // exit 里异步 IO 不会执行：用同步写补齐最后一批（不截断——退出路径上不值得再读一次文件）
  const onExit = (): void => flushSync();
  process.once('exit', onExit);

  return {
    file,
    isFileLogger: true,
    info: (message: string) => push('info', message),
    warn: (message: string) => push('warn', message),
    error: (message: string) => push('error', message),
    debug: (message: string) => push('debug', message),
    flush,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      process.removeListener('exit', onExit);
      flushSync();
    },
  };
}

/**
 * 无人值守路径上的便捷封装（debug 级别由环境变量控制）。
 * `src/app/main.ts` 这类没有 `ctx.logger` 的进程用它（见 app 主进程的 console 包装）。
 */
export function createPlainFileLogger(file: string, base?: LoggerLike): FileLogger {
  return createFileLogger({
    file,
    base,
    debugEnabled: process.env.DSH_PET_LOG_DEBUG === '1',
  });
}

/**
 * 模块级默认出口——给拿不到 `ctx.logger` 的纯模块用（./config、./chat、./whisper）。
 *
 * 这些模块是纯函数，签名里不该为一条告警塞一个 logger，但它们的 warn 同样是桌面版用户唯一能
 * 看到的线索。宿主在 apply 开始时 `setDefaultLogger(log)`，之后直接 `defaultLog('warn', ...)`；
 * 单测或极早期没有 logger 时退回 console，行为不变。
 */
let defaultLogger: LoggerLike | null = null;

/** 由宿主（apply / standalone / app）在拿到统一 logger 后调用；传 null 复位（测试用）。 */
export function setDefaultLogger(logger: LoggerLike | null): void {
  defaultLogger = logger;
}

/** 写一条模块级日志；没有统一 logger 时退回 console（debug 仍受环境变量控制）。 */
export function defaultLog(level: LogLevel, message: string): void {
  const sink = defaultLogger?.[level];
  if (sink) {
    sink.call(defaultLogger, message);
    return;
  }
  if (level === 'debug') {
    if (process.env.DSH_PET_LOG_DEBUG === '1') console.debug(message);
    return;
  }
  if (level === 'info') console.info(message);
  else if (level === 'warn') console.warn(message);
  else console.error(message);
}
