import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.ts';
import { createStandaloneContext } from '../standalone/context.ts';

test('real host routes publish mode changes and pinned progress through /state', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-progress-'));
  const saved = {
    home: process.env.DSH_HOME,
    flag: process.env.DSH_PET_TASK_PROGRESS,
    electron: process.env.DSH_PET_ELECTRON_PATH,
  };
  process.env.DSH_HOME = dir;
  process.env.DSH_PET_ELECTRON_PATH = process.execPath;
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const listeners: Array<(session: unknown, event: unknown) => void> = [];
  const server = createServer((req, res) => {
    const route = context.routes.find((r) => req.url?.startsWith(r.path));
    if (route) void route.handler(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  let context = createStandaloneContext({ port: 0, logger });
  try {
    delete process.env.DSH_PET_TASK_PROGRESS;
    apply(context.ctx);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port + '/dsh-pet-7340';
    assert.equal((await fetch(base + '/work-tracking')).status, 404, 'feature is absent by default');
    await context.dispose();
    context = createStandaloneContext({ port: address.port, logger });
    context.ctx.on = (name: string, handler: (session: unknown, event: unknown) => void) => {
      if (name === 'session/event') listeners.push(handler);
      return () => {};
    };
    process.env.DSH_PET_TASK_PROGRESS = '1';
    apply(context.ctx);
    const post = (body: unknown) => fetch(base + '/work-tracking', { method: 'POST', body: JSON.stringify(body) });
    const state = async () => (await (await fetch(base + '/state')).json()).sections.workStatus.data;
    const emit = (id: string, type: string, data: Record<string, unknown> = {}) =>
      listeners.forEach((fn) => fn({ header: { id } }, { type, data }));
    await t.test('starts with the idle menu and accepts only valid selections', async () => {
      assert.equal((await state()).progress.mode, 'idle');
      assert.equal((await post({ mode: 'invalid' })).status, 400);
      assert.equal((await post({ sessionId: 'missing' })).status, 404);
    });
    await t.test('offer responses are scoped to the current task and stale clicks fail', async () => {
      emit('prompt', 'turn/start');
      const offer = (await state()).progress.offer;
      assert.ok(offer);
      assert.equal((await post({ offerId: offer.id, accept: true })).status, 200);
      assert.equal((await state()).progress.pinnedSessionId, 'prompt');
      assert.equal((await post({ offerId: offer.id, accept: true })).status, 409);
      emit('prompt', 'turn/end', { reason: { kind: 'completed' } });
      assert.equal((await state()).progress.mode, 'idle');
      await post({ sessionId: null });
    });
    await t.test('mode changes wake a pending long poll and pinning isolates conversations', async () => {
      emit('a', 'user/message', { message: { content: [{ type: 'text', text: '检查解析器' }] } });
      emit('a', 'turn/start');
      await post({ sessionId: 'a' });
      const before = await (await fetch(base + '/state')).json();
      const pending = fetch(base + '/state?since=' + before.counter + '&timeout=2000');
      assert.equal((await post({ mode: 'task' })).status, 200);
      const changed = await (await pending).json();
      assert.ok(changed.counter > before.counter);
      assert.equal(changed.sections.workStatus.data.progress.mode, 'task');
      emit('a', 'tool/call', { name: 'read', arguments: '{"path":"config.ts"}', callId: 'one' });
      emit('b', 'approval/asked');
      assert.equal((await state()).task, '正在读取 config.ts');
      assert.equal((await state()).progress.sessionId, 'a');
      await post({ sessionId: null });
      assert.equal((await state()).progress.sessionId, 'b');
      await post({ mode: 'idle' });
      assert.equal((await state()).progress.mode, 'idle');
    });
    await t.test('one state response retains both sides of a rapid tool call', async () => {
      emit('rapid', 'turn/start');
      await post({ sessionId: 'rapid' });
      await post({ mode: 'task' });
      emit('rapid', 'tool/call', { name: 'write', arguments: '{"path":"fast.ts"}', callId: 'fast' });
      emit('rapid', 'tool/result', { callId: 'fast' });
      const frames = (await state()).progress.timeline.frames;
      const call = frames.findIndex(
        (f: { state: string; task: string }) => f.state === 'working' && f.task === '正在修改 fast.ts',
      );
      assert.ok(call >= 0);
      assert.equal(frames[call + 1].state, 'thinking');
      assert.ok(frames[call + 1].seq > frames[call].seq);
    });
  } finally {
    await context.dispose();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    if (saved.home === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved.home;
    if (saved.flag === undefined) delete process.env.DSH_PET_TASK_PROGRESS;
    else process.env.DSH_PET_TASK_PROGRESS = saved.flag;
    if (saved.electron === undefined) delete process.env.DSH_PET_ELECTRON_PATH;
    else process.env.DSH_PET_ELECTRON_PATH = saved.electron;
    rmSync(dir, { recursive: true, force: true });
  }
});
