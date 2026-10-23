/**
 * 独立模式的伪 Cordis 上下文 —— 让插件的**宿主半边**在 DSH 之外跑起来。
 *
 * 为什么不重写一份路由表：宿主半边（`src/host/index.ts` 的 `apply`）已经把路由表、
 * 配置聚合、状态仓、桌面 Helper 与 bridge 管道全写好了，它对外只要求一个 Cordis `ctx`。
 * 仓库自己的 `src/host/routes.test.ts` 早就用同一个手法（最小 ctx + `apply`）在 DSH 之外
 * 跑这份路由；独立模式把那套手法产品化：DSH 的服务换成"明确降级"的替身，
 * `apply` 注册的 prefix handler 接到一个真正的 `node:http` 服务器上（见 `./server`）。
 *
 * 收益：插件以后新增或修改任何端点，独立模式自动跟着变 —— 只有一份路由表，
 * 不存在"第二套实现对不上"的漂移（这正是 `routes.test.ts` 开头记的那类事故）。
 *
 * 服务替身的降级口径（都是显式失败，不假装成功）：
 *   - `agentDefaultModel.currentSelection()` → `{ provider: 'standalone', model: '' }`
 *     → 余额路由命中"未登记接口"分支 → `{ ok: false, reason: 'unsupported' }`
 *   - `credentials.resolve()` → 恒 `undefined` → 凭证类失败走 `credential-missing`
 *   - `llm.*` → 模型清单为空；生成调用直接抛错 → 碎碎念/对话明确失败，不会静默
 *   - `on(...)` → 不订阅任何事件：独立模式没有 DSH 会话，工作状态因此保持空闲
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createFileLogger } from '../host/log-file';

/** 独立模式下余额路由报出的服务商 id（未登记 → `unsupported`，气泡里能看到它） */
export const STANDALONE_PROVIDER = 'standalone';

/** 独立模式的日志接口（与插件对 `ctx.logger` 的使用面一致） */
export interface StandaloneLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** 插件注册到 `ctx.webServer` 的一条路由（字段原样保留，独立模式只做前缀匹配） */
export interface RegisteredRoute {
  /** `prefix`（插件当前只用这一种）或 `exact`，原样透传 */
  kind: string;
  /** 路由路径，例如 `/dsh-pet-7340`；独立模式按它做前缀匹配，不自己硬编码前缀 */
  path: string;
  /** 真实 Node HTTP handler：自己写响应头与 body（与 DSH WebServer 的契约一致） */
  handler: (req: IncomingMessage, res: ServerResponse) => unknown;
}

export interface StandaloneModelService {
  currentSelection(): { provider: string; model: string };
  listProviders(): unknown[];
  listModels(provider: string): Promise<unknown[]>;
  resolveModelInfo(provider?: string, model?: string, signal?: AbortSignal): Promise<unknown>;
  stream(options: unknown): AsyncIterable<unknown>;
  isReady(): boolean;
  canWhisper(): boolean;
  getSettings(): { whisperIntervalSec: number };
  dispose(): void;
}

export interface StandaloneContextOptions {
  /** 插件用它拼桌面 Helper 的 `DSH_PET_CONFIG_URL`；传函数可拿到"监听后才确定"的端口 */
  port: number | (() => number);
  logger: StandaloneLogger;
  /** 注入路由收集数组（独立模式先起服务拿到端口，再 `apply`，两者共用同一个数组） */
  routes?: RegisteredRoute[];
  ai?: StandaloneModelService;
  authenticatedUrl?: (baseUrl: string) => string;
  /**
   * 「关掉整个独立模式进程」的能力（桌面 Helper 托盘的「退出」，issue #178）。
   *
   * 只有独立模式有这个东西：helper 自己 `app.quit()` 会被宿主的崩溃重启逻辑当成异常退出、
   * 750ms 后原地复活，真正的退出必须让本进程走 `/shutdown` 那条收尾路径
   * （`context.dispose()` → 停 Helper → 关服务 → `exit 0`）。DSH 内的桌面模式**不挂**这个字段：
   * 关掉整个 DSH 不该由一只宠物的托盘决定，宿主路由据此回 `canQuit:false`（见 src/host/index.ts 的 /quit）。
   */
  shutdown?: (reason: string) => void;
}

export interface StandaloneContext {
  /** 交给 `apply()` 的伪 ctx */
  ctx: Record<string, unknown>;
  /** `apply()` 期间注册的路由（按注册顺序） */
  routes: RegisteredRoute[];
  /** 初始化期间被记录下来的异常（每项都已按 DSH 的 effect 隔离口径打了日志） */
  failures: string[];
  /** 释放全部 effect：停桌面 Helper、清掉周期定时器 */
  dispose(): Promise<void>;
}

/** `createStandaloneLogger` 的选项 */
export interface StandaloneLoggerOptions {
  /**
   * 落盘文件（单文件、按大小截断，见 ../host/log-file）。
   * 不给则只写控制台——`--check` 这类短命令不需要留文件。
   */
  file?: string;
}

/** 默认日志器：给了 file 就写成文件日志器，否则直接写控制台，格式与插件自身的 `[dsh-pet]` 前缀区分开 */
export function createStandaloneLogger(options: StandaloneLoggerOptions = {}): StandaloneLogger {
  if (options.file) {
    // 这个 logger 会挂到伪 ctx.logger 上：插件（host/index.ts）据此复用同一个文件出口，
    // 不再自建第二个写同一文件的 logger（两份缓冲/截断会互相踩）。
    return createFileLogger({
      file: options.file,
      base: console,
      debugEnabled: process.env.DSH_PET_LOG_DEBUG === '1',
    });
  }
  const stamp = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const write = (level: string, message: string): void => {
    console.log(`[dsh-pet-standalone ${stamp()}] ${level} ${message}`);
  };
  return {
    info: (message) => write('INFO ', message),
    warn: (message) => write('WARN ', message),
    error: (message) => write('ERROR', message),
    debug: (message) => {
      if (process.env.DSH_PET_STANDALONE_DEBUG === '1') write('DEBUG', message);
    },
  };
}

/**
 * 建一个独立模式的伪 ctx。
 * @param options 端口（或端口取值函数）、日志器与可选的路由收集数组
 * @returns 伪 ctx、路由列表、初始化失败记录与释放函数
 */
export function createStandaloneContext(options: StandaloneContextOptions): StandaloneContext {
  const { logger, ai } = options;
  const routes = options.routes ?? [];
  const failures: string[] = [];
  /** effect 释放函数（后注册先释放，与 Cordis 的逆序释放一致） */
  const disposers: Array<() => unknown> = [];
  /** 插件通过 ctx.provide 挂出去的服务（独立模式没有其他插件，通常为空） */
  const services = new Map<string, unknown>();
  let disposed = false;

  const portOf = (): number => (typeof options.port === 'function' ? options.port() : options.port);

  const webServer = {
    /** 读取时取值：服务先监听、端口确定后才 apply，插件在 launchHelper 里读到的就是真端口 */
    get port(): number {
      return portOf();
    },
    register(spec: RegisteredRoute): () => void {
      routes.push({ kind: spec.kind, path: spec.path, handler: spec.handler });
      return () => {
        const index = routes.findIndex((route) => route.handler === spec.handler);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };

  const context: Record<string, unknown> = {
    /**
     * 与 Cordis 同语义：跑一次注册函数并收集它返回的释放函数。
     * 单项失败按 DSH 的 effect 隔离口径处理：记录 + 打日志，不让整个插件起不来
     * （源码形态下包内 assets 不可达时，正是这里会抛）。
     */
    effect(fn: () => unknown): unknown {
      try {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose as () => unknown);
        return dispose;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        logger.error(`初始化某项失败（已跳过）：${message}`);
        return undefined;
      }
    },
    /** 对外服务注册（Cordis 的 ctx.provide 语义）：存起来供 get 读取，返回释放函数 */
    provide(name: string, value: unknown): () => void {
      services.set(name, value);
      return () => {
        if (services.get(name) === value) services.delete(name);
      };
    },
    /**
     * 服务查找（Cordis 的 ctx.get 语义）。先查注册表，再回落到 ctx 自身的属性——
     * 独立模式把可选能力（standaloneAi / shutdownApp）直接挂在伪 ctx 上，而不是走 provide 注册；
     * 而 host 侧统一用 `ctx.get(name, false)` 软取（DSH 的严格 getter 不允许裸读未 inject 的服务）。
     * 不回落的话，独立模式会把**本来就有的能力**判成没有：自动碎碎念被当成「未授权」、
     * 托盘退出的菜单项直接消失。
     */
    get(name: string): unknown {
      const registered = services.get(name);
      if (registered !== undefined) return registered;
      return (this as unknown as Record<string, unknown>)[name];
    },
    /** 独立模式没有 DSH 会话事件：不订阅，工作状态保持空闲 */
    on(): () => void {
      return () => {};
    },
    logger,
    webServer,
    connection: { authenticatedUrl: options.authenticatedUrl ?? ((baseUrl: string): string => baseUrl) },
    ...(ai
      ? {
          standaloneAi: {
            isReady: () => ai.isReady(),
            canWhisper: () => ai.canWhisper(),
            whisperIntervalSec: () => ai.getSettings().whisperIntervalSec,
          },
        }
      : {}),
    // 托盘「退出」的能力开关：宿主路由（src/host/index.ts 的 /quit）只看这个字段在不在，
    // 不关心它内部怎么停机——独立模式复用 cli.ts 已有的 /shutdown 收尾，不写第二套停机逻辑。
    ...(options.shutdown ? { shutdownApp: options.shutdown } : {}),
    commands: { register: (): (() => void) => () => {} },
    agentDefaultModel: {
      currentSelection: (): { provider: string; model: string } =>
        ai?.currentSelection() ?? { provider: STANDALONE_PROVIDER, model: '' },
    },
    credentials: { resolve: async (): Promise<undefined> => undefined },
    llm: ai
      ? {
          listProviders: () => ai.listProviders(),
          listModels: (provider: string) => ai.listModels(provider),
          resolveModelInfo: (provider?: string, model?: string, signal?: AbortSignal) =>
            ai.resolveModelInfo(provider, model, signal),
          stream: (request: unknown) => ai.stream(request),
        }
      : {
          listProviders: (): unknown[] => [],
          listModels: async (): Promise<unknown[]> => [],
          /**
           * 模型元数据查询。DSH 的契约是
           * `resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>` —— **异步**。
           * 替身必须同样返回 Promise：同步返回 undefined 时，任何 `.then()` 或不带 `?.` 的取值
           * 都会立刻炸（与 stream 同一类形状错误）。
           *
           * 目前唯一消费方 `supportsReasoningOff` 用 `await` + `?.` + try/catch 包着，所以不炸——
           * 但那是靠消费方防御，不是靠形状正确。形状对不上，就不该指望下一个消费方也这么写。
           */
          resolveModelInfo: async (): Promise<undefined> => undefined,
          /**
           * 生成入口：独立模式没有模型后端。
           *
           * 必须是 **AsyncIterable**——DSH 的契约是 `stream(options): AsyncIterable<StreamChunk>`，
           * 调用方一律 `for await (const chunk of llm.stream(...))` 消费。错误在首次 `next()` 时抛出，
           * 正好落在调用方已有的 try/catch 里，转成 `ok:false / generate-error` 的结构化失败。
           *
           * **不能**写成 `async () => { throw ... }`：那返回 Promise 而非 AsyncIterable，
           * `for await` 会立刻抛 TypeError（文案由 V8 生成，形如 "llm.stream(...) is not a function
           * or its return value is not async iterable"），同时那个 rejected promise 无人接管，
           * 以 unhandled rejection **直接终止进程**。0.3.4 的崩溃根因即此：配置里设了
           * whisperModel/chatModel 就必崩，因为只有配了模型才会真的走到这里。
           */
          // 不用 `async function*`：一个只有 throw、没有 yield 的生成器会被 eslint 的
          // require-yield 拦下；而这里恰恰不该 yield 任何东西（独立模式没有模型后端）。
          // 显式给出 AsyncIterable 的形状，也是对契约最直接的表达。
          stream: (): AsyncIterable<never> => ({
            [Symbol.asyncIterator](): AsyncIterator<never> {
              return {
                next: async (): Promise<IteratorResult<never>> => {
                  throw new Error('dsh-pet standalone: 独立模式未接入模型（碎碎念/对话不可用）');
                },
              };
            },
          }),
        },
  };

  return {
    ctx: context,
    routes,
    failures,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      ai?.dispose();
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch (error) {
          logger.warn(`释放某项失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}
