/**
 * dev/mock-server.mjs —— 桌面模式运行时验证用 mock DSH 宿主（开发自测工具，不入 npm 包）。
 *
 * 模拟 /dsh-pet-7340 前缀的宿主端点（与浏览器 overlay 共用同一套契约）：
 *   GET  /dsh-pet-7340/config              成品配置聚合（{ main: <真实 config.jsonc 解析> }，
 *                                        mock 环境无用户层/文件宠物，只有 main 条目）
 *   GET  /dsh-pet-7340/thumb/<petId>/<name>.webm  从 assets/webm 读素材（petId 段剥掉，统一素材根）
 *   GET  /dsh-pet-7340/state                当前状态，支持 since/timeout 长轮询
 *   POST /dsh-pet-7340/balance              刷新模拟余额并写入状态，返回 {ok}
 *   GET  /dsh-pet-7340/font/<name>.ttf      包内字体
 *   GET  /dsh-pet-7340/pic/<name>.png       包内光标等图片
 *
 * 系统通知是浏览器半侧（notify.ts）的独立能力，走 DSH 网页自身事件流，与桌面模式/mock 无关。
 *
 * 用法：npm run dev:mock -- [port] [money|windows|points]（默认 8231 / money）
 * 配合：npm run start:desktop -- http://127.0.0.1:<port>/dsh-pet-7340/config
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PollStateStore, parseStateWaitQuery } from '../../src/host/state.ts';

const PORT = Number(process.argv[2] || 8231);
const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PACKAGE_ROOT = resolve(here, '..', '..');
const WEBM_ROOT = join(PACKAGE_ROOT, 'assets', 'webm');
const CONFIG_FILE = join(PACKAGE_ROOT, 'assets', 'config.jsonc');
const balanceShape = process.argv[3] || 'money';
const fixtures = {
  money: {
    ok: true,
    provider: 'mock-money',
    shape: 'money',
    data: { wallets: [{ currency: 'CNY', total: '11.06', granted: '5.00', toppedUp: '10.00', fullBalance: '20' }] },
  },
  windows: {
    ok: true,
    provider: 'mock-windows',
    shape: 'windows',
    data: {
      rolling: 20,
      weekly: 65,
      monthly: 45,
      rollingResetsAt: new Date(Date.now() + 5 * 3600000).toISOString(),
      weeklyResetsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      monthlyResetsAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    },
  },
  points: {
    ok: true,
    provider: 'mock-points',
    shape: 'points',
    data: { unit: '积分', total: '800', full: '1000' },
  },
};
if (!Object.hasOwn(fixtures, balanceShape)) {
  console.error('[mock-server] unknown balance shape: ' + balanceShape + ' (money|windows|points)');
  process.exit(1);
}
const state = new PollStateStore();
const refreshBalance = (manual) => state.writeSection('balance', { ...fixtures[balanceShape], manual });
refreshBalance(false);

/** 剥除 JSONC 注释（与真实宿主 readAllConfig 的 stripJsonc 同规则），返回纯 JSON */
const stripJsonc = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/dsh-pet-7340/state') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const wait = parseStateWaitQuery(url.searchParams.get('since'), url.searchParams.get('timeout'));
    if (wait.kind === 'error') {
      sendJson(res, 400, { error: wait.error });
      return;
    }
    const respond = () => sendJson(res, 200, state.read());
    if (wait.kind === 'ok' && wait.since === state.read().counter) {
      const cancel = state.wait({ since: wait.since, timeoutMs: wait.timeoutMs, onWake: respond });
      res.once('close', cancel);
    } else respond();
    return;
  }

  if (pathname === '/dsh-pet-7340/balance') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    refreshBalance(true);
    sendJson(res, 200, { ok: true });
    return;
  }

  // 成品配置：mock 环境无用户层/文件宠物 → 只有 main 条目（= 内置默认，字段原样保留）；
  // 消费端按成品结构读取（不校验）。
  if (pathname === '/dsh-pet-7340/config') {
    if (!existsSync(CONFIG_FILE)) {
      res.writeHead(404);
      res.end('no config.jsonc');
      return;
    }
    sendJson(res, 200, { main: JSON.parse(stripJsonc(readFileSync(CONFIG_FILE, 'utf8'))) });
    return;
  }

  // 动画文件：/dsh-pet-7340/thumb/<petId>/<name>.webm（与宿主路由同一形态）。
  // petId 仅作归属标识：mock 服务器从统一素材根读（开发环境不模拟独立素材目录）；
  // 剥掉 petId 段后按文件名解析，目标仍在 WEBM_ROOT 内才放行。
  const asset = [
    { prefix: '/dsh-pet-7340/thumb/', root: WEBM_ROOT, type: 'video/webm' },
    { prefix: '/dsh-pet-7340/font/', root: join(PACKAGE_ROOT, 'assets/fonts'), type: 'font/ttf' },
    { prefix: '/dsh-pet-7340/pic/', root: join(PACKAGE_ROOT, 'assets/pic'), type: 'image/png' },
  ].find((entry) => pathname.startsWith(entry.prefix));
  if (asset) {
    let rel = pathname.slice(asset.prefix.length);
    if (asset.root === WEBM_ROOT) {
      const slash = rel.indexOf('/');
      rel = slash >= 0 ? rel.slice(slash + 1) : rel;
    }
    if (!rel || rel.length === 0) {
      res.writeHead(400);
      res.end('bad path');
      return;
    }
    const candidate = normalize(join(asset.root, rel));
    const rootWithSep = asset.root.endsWith(sep) ? asset.root : asset.root + sep;
    if (candidate !== asset.root && !candidate.startsWith(rootWithSep)) {
      res.writeHead(400);
      res.end('bad path');
      return;
    }
    if (!existsSync(candidate)) {
      res.writeHead(404);
      res.end('asset not found');
      return;
    }
    const info = statSync(candidate);
    if (!info.isFile()) {
      res.writeHead(404);
      res.end('asset not found');
      return;
    }
    res.writeHead(200, {
      'content-type': asset.type,
      'content-length': info.size,
      'cache-control': 'public, max-age=3600',
    });
    createReadStream(candidate).pipe(res);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`mock: not found ${pathname}`);
});

server.listen(PORT, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`[mock-server] listening on http://127.0.0.1:${port}/dsh-pet-7340/`);
  console.log(`[mock-server] config:  http://127.0.0.1:${port}/dsh-pet-7340/config`);
  console.log(`[mock-server] balance: ${balanceShape}; use POST /dsh-pet-7340/balance to show the bubble`);
  console.log(`[mock-server] assets:  ${WEBM_ROOT}`);
});
