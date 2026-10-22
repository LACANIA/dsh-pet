import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskProgressStore, toolProgressText, ACTIVITY_WINDOW_MS, TaskProgressTimeline } from './task-progress.ts';

test('timeline retains rapid transitions, deduplicates snapshots and isolates a new source', () => {
  let now = 0;
  const store = new TaskProgressStore(() => now);
  const timeline = new TaskProgressTimeline(() => now);
  store.setMode('task');
  feed(store, 'a', 'turn/start');
  const first = timeline.capture(store.snapshot());
  now = 10;
  feed(store, 'a', 'tool/call', { name: 'write', callId: 'one', arguments: '{"path":"first.ts"}' });
  timeline.capture(store.snapshot());
  now = 20;
  feed(store, 'a', 'tool/result', { callId: 'one' });
  const last = timeline.capture(store.snapshot());
  assert.deepEqual(
    last.progress.timeline.frames.map((f) => [f.at, f.state]),
    [
      [0, 'thinking'],
      [10, 'working'],
      [20, 'thinking'],
    ],
  );
  assert.equal(timeline.capture(store.snapshot()).progress.timeline.frames.length, 3);
  feed(store, 'b', 'turn/start');
  store.select('b');
  const other = timeline.capture(store.snapshot());
  assert.notEqual(other.progress.timeline.stream, first.progress.timeline.stream);
  assert.equal(other.progress.timeline.frames.length, 1);
  for (let i = 0; i < 300; i++) {
    now++;
    feed(store, 'b', 'tool/call', { name: 'read', callId: String(i), arguments: JSON.stringify({ path: i + '.ts' }) });
    timeline.capture(store.snapshot());
  }
  assert.equal(timeline.capture(store.snapshot()).progress.timeline.frames.length, 256);
});

function feed(
  store: TaskProgressStore,
  id: string,
  type: string,
  data: Record<string, unknown> = {},
  seq?: number,
): boolean {
  return store.accept({ header: { id } }, { type, data, ...(seq === undefined ? {} : { seq }) });
}
test('starts in idle mode and mode switches retain live progress', () => {
  const store = new TaskProgressStore();
  assert.equal(store.snapshot().progress.mode, 'idle');
  feed(store, 'a', 'turn/start');
  store.setMode('task');
  assert.equal(store.snapshot().state, 'thinking');
  assert.equal(store.snapshot().progress.mode, 'task');
  store.setMode('idle');
  assert.equal(store.snapshot().progress.mode, 'idle');
});
test('operation summaries retain only the file name and a short command action', () => {
  assert.equal(toolProgressText('read', JSON.stringify({ file_path: 'C:\\private\\config.ts' })), '正在读取 config.ts');
  assert.equal(toolProgressText('exec_command', { cmd: 'pnpm test --token secret' }), '正在执行 pnpm test');
  assert.equal(toolProgressText('bash', { command: 'API_KEY=secret curl https://private' }), '正在执行命令');
  assert.equal(toolProgressText('grep', { pattern: 'private' }), '正在搜索代码');
  assert.equal(toolProgressText('read', 'broken'), '正在读取文件');
  assert.equal(toolProgressText('view_image', { path: 'C:/private/page.png' }), '正在查看图片 page.png');
  assert.equal(toolProgressText('read_image', { image_path: 'C:/private/page.png' }), '正在查看图片 page.png');
  assert.equal(toolProgressText('read', { file_path: 'C:/private/page.PNG' }), '正在查看图片 page.PNG');
});

test('a fast image result retains its label, and the newest operation is included among mixed summaries', () => {
  let now = 0;
  const store = new TaskProgressStore(() => now);
  store.setMode('task');
  feed(store, 'a', 'tool/call', { name: 'view_image', callId: 'image', arguments: '{"path":"page.png"}' });
  now = 10;
  feed(store, 'a', 'tool/result', { callId: 'image' });
  assert.equal(store.snapshot().progress.summary, '刚才：查看图片 page.png');
  now = 1500;
  assert.equal(store.snapshot().progress.summary, '刚才：查看图片 page.png');
  feed(store, 'a', 'tool/call', { name: 'read', callId: 'read' });
  feed(store, 'a', 'tool/call', { name: 'grep', callId: 'grep' });
  feed(store, 'a', 'tool/call', { name: 'view_image', callId: 'latest', arguments: '{"path":"new.png"}' });
  assert.match(store.snapshot().progress.summary ?? '', /^最近：查看图片 2 张/);
  now += ACTIVITY_WINDOW_MS;
  feed(store, 'a', 'tool/result');
  assert.equal(store.snapshot().progress.summary, null);
});
test('parallel tool completion retains the unfinished operation', () => {
  const store = new TaskProgressStore();
  feed(store, 'a', 'tool/call', { name: 'read', callId: 'one', arguments: '{"path":"a.ts"}' });
  feed(store, 'a', 'tool/call', { name: 'edit', callId: 'two', arguments: '{"path":"b.ts"}' });
  feed(store, 'a', 'tool/result', { callId: 'two', content: 'secret output' });
  assert.equal(store.snapshot().task, '正在读取 a.ts');
  assert.equal(store.snapshot().state, 'working');
  feed(store, 'a', 'tool/result', { callId: 'one' });
  assert.equal(store.snapshot().state, 'thinking');
  assert.equal(store.snapshot().task, null);
});

test('animation actions follow the current operation, remain through its summary and expire with it', () => {
  let now = 0;
  const store = new TaskProgressStore(() => now);
  store.setMode('task');
  feed(store, 'a', 'tool/call', { name: 'edit', callId: 'one', arguments: '{"path":"first.ts"}' });
  assert.equal(store.snapshot().progress.action, 'typing');
  feed(store, 'a', 'tool/result', { callId: 'one' });
  assert.equal(store.snapshot().state, 'thinking');
  assert.equal(store.snapshot().progress.action, 'typing');
  now = ACTIVITY_WINDOW_MS;
  assert.equal(store.snapshot().progress.action, null);
  feed(store, 'a', 'tool/call', { name: 'read_image', callId: 'image' });
  assert.equal(store.snapshot().progress.action, 'viewing');
  feed(store, 'b', 'tool/call', { name: 'write', callId: 'background' });
  assert.equal(store.snapshot().progress.action, 'viewing');
  feed(store, 'a', 'approval/asked');
  assert.equal(store.snapshot().progress.action, null);
});
test('pinning a session prevents another conversation from replacing it', () => {
  const store = new TaskProgressStore();
  feed(store, 'a', 'turn/start');
  assert.equal(store.select('a'), true);
  feed(store, 'b', 'approval/asked');
  assert.equal(store.snapshot().progress.sessionId, 'a');
  assert.equal(store.snapshot().state, 'thinking');
  store.select(null);
  assert.equal(store.snapshot().progress.sessionId, 'b');
  assert.equal(store.select('missing'), false);
});
test('source label comes from public user text without reasoning parts', () => {
  const store = new TaskProgressStore();
  feed(store, 'a', 'user/message', {
    message: {
      content: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: '检查配置解析' },
      ],
    },
  });
  store.select('a');
  assert.equal(store.snapshot().progress.sessionTitle, '检查配置解析');
  assert.ok(!JSON.stringify(store.snapshot()).includes('private'));
});
test('out of order events and child sessions cannot overwrite the tracked task', () => {
  const store = new TaskProgressStore();
  feed(store, 'a', 'turn/start', {}, 3);
  assert.equal(feed(store, 'a', 'turn/end', { reason: { kind: 'completed' } }, 2), false);
  assert.equal(store.accept({ header: { id: 'b', origin: 'subagent' } }, { type: 'tool/call' }), false);
  assert.equal(store.snapshot().state, 'thinking');
  assert.equal(store.snapshot().progress.sessions.length, 1);
});
test('todo updates replace the generic operation text and clear completed content', () => {
  const store = new TaskProgressStore();
  feed(store, 'a', 'tool/call', { name: 'todo_write', callId: 'todo' });
  feed(store, 'a', 'todo/write', { todos: [{ content: '检查接口', status: 'in_progress' }] });
  assert.equal(store.snapshot().task, '检查接口');
  feed(store, 'a', 'todo/write', { todos: [{ content: '检查接口', status: 'completed' }] });
  assert.notEqual(store.snapshot().task, '检查接口');
});
test('goal continuation is not reported as final success', () => {
  const store = new TaskProgressStore();
  feed(store, 'a', 'turn/start');
  feed(store, 'a', 'user/message', { source: { kind: 'goal' } });
  feed(store, 'a', 'turn/end', { reason: { kind: 'completed' } });
  assert.equal(store.snapshot().state, 'result');
  feed(store, 'a', 'turn/start');
  feed(store, 'a', 'user/message', { source: { kind: 'goal' } });
  feed(store, 'a', 'tool/call', { name: 'update_goal', arguments: '{"action":"complete"}' });
  feed(store, 'a', 'turn/end', { reason: { kind: 'completed' } });
  assert.equal(store.snapshot().state, 'success');
});
test('abort and timed cleanup remove text while retaining a selected session', () => {
  const store = new TaskProgressStore();
  feed(store, 'a', 'turn/start');
  store.select('a');
  feed(store, 'a', 'turn/end', { reason: { kind: 'aborted' } });
  assert.equal(store.snapshot().state, null);
  feed(store, 'a', 'turn/end', { reason: { kind: 'completed' } });
  store.clear('a');
  assert.equal(store.snapshot().task, null);
  assert.equal(store.snapshot().progress.pinnedSessionId, 'a');
});
test('retained session list is bounded and does not evict the selected conversation', () => {
  const store = new TaskProgressStore();
  feed(store, 'first', 'turn/start');
  store.select('first');
  for (let i = 0; i < 40; i++) feed(store, 's' + i, 'turn/start');
  assert.equal(store.snapshot().progress.sessions.length, 32);
  assert.equal(store.snapshot().progress.sessionId, 'first');
});

test('SDK user message and tool result shapes are consumed directly', () => {
  const store = new TaskProgressStore();
  const user = {
    id: 'user-message',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '检查真实消息结构' }],
  };
  feed(store, 'a', 'user/message', user as unknown as Record<string, unknown>);
  feed(store, 'a', 'tool/call', { name: 'read', callId: 'one' });
  feed(store, 'a', 'tool/call', { name: 'grep', callId: 'two' });
  const result = {
    turn: 1,
    step: 1,
    message: {
      id: 'result',
      role: 'tool',
      toolCallId: 'two',
      source: { kind: 'tool', callId: 'two' },
      content: [{ type: 'text', text: 'output' }],
    },
  };
  feed(store, 'a', 'tool/result', result as unknown as Record<string, unknown>);
  assert.equal(store.snapshot().progress.sessionTitle, '检查真实消息结构');
  assert.equal(store.snapshot().state, 'working');
  assert.equal(store.snapshot().task, '正在读取文件');
});
test('rapid operations remain readable after results and expire without a replay backlog', () => {
  let now = 1000;
  const store = new TaskProgressStore(() => now);
  for (let i = 0; i < 3; i++) {
    feed(store, 'a', 'tool/call', { name: 'read', callId: String(i), arguments: JSON.stringify({ path: i + '.ts' }) });
    feed(store, 'a', 'tool/result', { callId: String(i) });
    now += 10;
  }
  assert.equal(store.snapshot().state, 'thinking');
  assert.equal(store.snapshot().progress.summary, '最近：读取 3 个文件');
  now += ACTIVITY_WINDOW_MS;
  assert.equal(store.snapshot().progress.summary, null);
  feed(store, 'a', 'tool/call', { name: 'grep', callId: 'search' });
  assert.equal(store.snapshot().progress.summary, '正在搜索代码');
  feed(store, 'a', 'turn/end', { reason: { kind: 'completed' } });
  assert.equal(store.snapshot().progress.summary, null);
});
test('concurrent task offers are queued once and accepting one pins that session', () => {
  const store = new TaskProgressStore();
  feed(store, 'a', 'turn/start');
  const first = store.snapshot().progress.offer!;
  feed(store, 'a', 'step/start');
  feed(store, 'b', 'turn/start');
  assert.equal(store.snapshot().progress.offer?.id, first.id);
  assert.equal(store.snapshot().progress.offer?.pending, 2);
  assert.equal(store.respondOffer(first.id, true), true);
  assert.equal(store.snapshot().progress.mode, 'task');
  feed(store, 'b', 'approval/asked');
  assert.equal(store.snapshot().progress.sessionId, 'a');
  feed(store, 'a', 'turn/end', { reason: { kind: 'completed' } });
  assert.equal(store.snapshot().progress.mode, 'idle');
  assert.equal(store.snapshot().progress.offer?.sessionId, 'b');
  assert.equal(store.respondOffer(first.id, true), false);
});
test('finished background tasks are removed from the prompt queue', () => {
  const store = new TaskProgressStore();
  feed(store, 'a', 'turn/start');
  feed(store, 'b', 'turn/start');
  feed(store, 'b', 'turn/end', { reason: { kind: 'completed' } });
  const offer = store.snapshot().progress.offer!;
  assert.equal(offer.pending, 1);
  assert.equal(store.respondOffer(offer.id, false), true);
  assert.equal(store.snapshot().progress.mode, 'idle');
  assert.equal(store.snapshot().progress.offer, null);
  feed(store, 'a', 'step/start');
  assert.equal(store.snapshot().progress.offer, null);
});
test('automatic tracking remains attached while another session gets higher priority', () => {
  const store = new TaskProgressStore();
  store.setMode('task');
  feed(store, 'a', 'turn/start');
  feed(store, 'b', 'approval/asked');
  assert.equal(store.snapshot().progress.sessionId, 'a');
  feed(store, 'b', 'turn/end', { reason: { kind: 'completed' } });
  assert.equal(store.snapshot().progress.mode, 'task');
  feed(store, 'a', 'turn/end', { reason: { kind: 'completed' } });
  assert.equal(store.snapshot().progress.mode, 'idle');
});
