import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  toWorkStatus,
  workStatusText,
  workAnimationState,
  workAnimationKey,
  workAnimationSlot,
  WorkStatusPlayback,
  TASK_DISPLAY_DELAY_MS,
  type TaskProgress,
} from './work-status.ts';
import { taskModeMenu, taskTrackingMenu } from './menu.ts';
import type { Animations } from './types';

function playbackFixture() {
  let now = 0,
    nextId = 0;
  const jobs = new Map<number, { at: number; run: () => void }>();
  const shown: Array<{ at: number; state: string | null; task: string | null }> = [];
  const texts: Array<string | null> = [];
  const playback = new WorkStatusPlayback(
    (s) => {
      shown.push({ at: now, state: s.state, task: s.task });
      texts.push(workStatusText(s));
    },
    () => now,
    ((run: () => void, ms: number) => {
      const id = ++nextId;
      jobs.set(id, { at: now + ms, run });
      return id;
    }) as unknown as typeof setTimeout,
    ((id: number) => jobs.delete(id)) as unknown as typeof clearTimeout,
  );
  const advance = (until: number) => {
    while (jobs.size) {
      const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (next[1].at > until) break;
      now = next[1].at;
      jobs.delete(next[0]);
      next[1].run();
    }
    now = until;
  };
  const frame = (seq: number, at: number, state: 'thinking' | 'working', task: string | null = null) => ({
    seq,
    at,
    state,
    task,
    progress,
  });
  const push = (frames: ReturnType<typeof frame>[], stream = 'one') =>
    playback.push({ ...frames[frames.length - 1], progress: { ...progress, timeline: { stream, frames } } });
  return { playback, shown, texts, advance, frame, push };
}

test('the timeline is shifted 300ms and thinking shorter than the window is omitted', () => {
  const f = playbackFixture();
  const first = f.frame(1, 0, 'thinking');
  f.push([first]);
  f.advance(20);
  const work = f.frame(2, 10, 'working', 'first.ts');
  const thinking = f.frame(3, 20, 'thinking');
  f.push([first, work, thinking]);
  f.push([first, work, thinking]);
  f.advance(TASK_DISPLAY_DELAY_MS - 1);
  assert.deepEqual(f.shown, []);
  f.advance(320);
  assert.deepEqual(f.shown, [
    { at: 310, state: 'working', task: 'first.ts' },
    { at: 320, state: 'thinking', task: null },
  ]);
  f.playback.dispose();
});

test('all metadata frames within a brief thinking interval are skipped while file updates retain their timing', () => {
  const f = playbackFixture();
  const frames = [f.frame(1, 0, 'working', 'first.ts')];
  f.push(frames);
  f.advance(100);
  frames.push(f.frame(2, 100, 'thinking'));
  f.push(frames);
  f.advance(200);
  frames.push(f.frame(3, 200, 'thinking', 'metadata'));
  f.push(frames);
  f.advance(350);
  frames.push(f.frame(4, 350, 'working', 'second.ts'));
  f.push(frames);
  f.advance(650);
  assert.deepEqual(f.shown, [
    { at: 300, state: 'working', task: 'first.ts' },
    { at: 650, state: 'working', task: 'second.ts' },
  ]);
});

test('thinking lasting 299ms is omitted, while 300ms and 301ms are displayed', () => {
  for (const duration of [299, 300, 301]) {
    const f = playbackFixture();
    const frames = [f.frame(1, 0, 'thinking')];
    f.push(frames);
    f.advance(duration - 1);
    frames.push(f.frame(2, duration, 'working', 'next.ts'));
    f.push(frames);
    f.advance(duration + TASK_DISPLAY_DELAY_MS);
    assert.equal(
      f.shown.some((s) => s.state === 'thinking'),
      duration >= TASK_DISPLAY_DELAY_MS,
    );
    assert.deepEqual(f.shown[f.shown.length - 1], { at: duration + 300, state: 'working', task: 'next.ts' });
  }
});

test('a new thinking interval cannot cause an earlier short interval to reappear', () => {
  const f = playbackFixture();
  const frames = [f.frame(1, 0, 'working', 'first.ts')];
  f.push(frames);
  f.advance(250);
  frames.push(f.frame(2, 100, 'thinking'), f.frame(3, 200, 'working', 'second.ts'), f.frame(4, 250, 'thinking'));
  f.push(frames);
  f.advance(550);
  assert.deepEqual(f.shown, [
    { at: 300, state: 'working', task: 'first.ts' },
    { at: 500, state: 'working', task: 'second.ts' },
    { at: 550, state: 'thinking', task: null },
  ]);
});

test('a fast image tool remains readable during thinking until the host expires its recent summary', () => {
  const f = playbackFixture();
  const work = {
    ...f.frame(1, 0, 'working', '正在查看图片 x.png'),
    progress: { ...progress, summary: '正在查看图片 x.png' },
  };
  const thinking = { ...f.frame(2, 10, 'thinking'), progress: { ...progress, summary: '刚才：查看图片 x.png' } };
  f.push([work]);
  f.advance(10);
  f.push([work, thinking]);
  f.advance(310);
  assert.equal(f.texts[f.texts.length - 1], '检查项目\n刚才：查看图片 x.png');
  f.advance(2000);
  assert.ok(f.texts.every((text) => text !== '💡'));
  f.advance(3000);
  const expired = { ...f.frame(3, 3000, 'thinking'), progress: { ...progress, summary: null } };
  f.push([work, thinking, expired]);
  f.advance(3300);
  assert.equal(f.texts[f.texts.length - 1], '💡');
  f.playback.dispose();
});

test('switching conversations cancels queued old frames and disposing cancels future updates', () => {
  const f = playbackFixture();
  f.push([f.frame(1, 0, 'working', 'old.ts')]);
  f.advance(10);
  f.push([f.frame(2, 10, 'thinking')], 'two');
  f.advance(310);
  assert.deepEqual(f.shown, [{ at: 310, state: 'thinking', task: null }]);
  f.push([f.frame(3, 320, 'working', 'future.ts')], 'two');
  f.playback.dispose();
  f.advance(1000);
  assert.equal(f.shown.length, 1);
});

test('old hosts display immediately and a new window starts from the latest retained state', () => {
  const f = playbackFixture();
  f.playback.push({ state: 'working', task: 'legacy.ts' });
  assert.equal(f.shown[0].at, 0);
  f.push([f.frame(1, -500, 'thinking'), f.frame(2, 0, 'working', 'latest.ts')]);
  f.advance(300);
  assert.deepEqual(f.shown[1], { at: 300, state: 'working', task: 'latest.ts' });
  assert.equal(workAnimationState({ state: 'working', task: null }), 'working');
  const malformed = toWorkStatus({
    state: 'working',
    progress: { ...progress, timeline: { stream: 'bad', frames: [null, { seq: 1, at: Infinity }] } },
  });
  assert.deepEqual(malformed?.progress?.timeline?.frames, []);
});
const progress: TaskProgress = {
  mode: 'task',
  sessionId: 'a',
  sessionTitle: '检查项目',
  pinnedSessionId: 'a',
  sessions: [{ id: 'a', title: '检查项目', state: 'working' }],
};
test('thinking is a compact bulb; operation text includes the source conversation', () => {
  assert.equal(workStatusText({ state: 'thinking', task: null, progress }), '💡');
  assert.equal(
    workStatusText({ state: 'working', task: '正在读取 config.ts', progress }),
    '检查项目\n正在读取 config.ts',
  );
  assert.equal(workStatusText({ state: null, task: null, progress }), null);
});
test('idle mode retains the existing configured phrases', () => {
  assert.equal(
    workStatusText({ state: 'thinking', task: null, progress: { ...progress, mode: 'idle' } }, '让我想想'),
    '让我想想',
  );
  assert.deepEqual(toWorkStatus({ state: 'working', task: '原文' }), { state: 'working', task: '原文' });
});
test('invalid progress metadata cannot break the menu', () => {
  const parsed = toWorkStatus({
    state: 'working',
    progress: { mode: 'x', sessions: [null, 3, {}, { id: 'a', title: '会话', state: 'invalid' }] },
  });
  assert.equal(parsed?.progress?.mode, 'idle');
  assert.deepEqual(parsed?.progress?.sessions, [{ id: 'a', title: '会话', state: null }]);
});
test('mode choices are opt-in and tracked sessions are offered only in task mode', () => {
  assert.equal(taskModeMenu(), null);
  assert.equal(taskTrackingMenu({ ...progress, mode: 'idle' }), null);
  assert.equal(taskModeMenu(progress)?.children.length, 2);
  assert.equal(taskTrackingMenu(progress)?.children.length, 2);
});

test('recent operations are projected during thinking instead of immediately disappearing', () => {
  assert.equal(
    workStatusText({ state: 'thinking', task: null, progress: { ...progress, summary: '最近：读取 3 个文件' } }),
    '检查项目\n最近：读取 3 个文件',
  );
});

test('typing and image viewing select existing assets, including while their recent summaries remain visible', () => {
  const animations: Animations = {
    idle: [],
    turn: ['东张西望'],
    drag: [],
    clicks: [],
    moves: { default: {}, actions: [] },
    categories: [{ id: 'actions', weight: 1, actions: ['写代码'] }],
    events: { workStatus: ['think', 'work', 'result', 'wait', 'success', 'error'] },
  };
  const typing = {
    state: 'working' as const,
    task: '正在修改 first.ts',
    progress: { ...progress, action: 'typing' as const },
  };
  assert.equal(workAnimationSlot(typing, animations), '写代码');
  const retained = {
    ...typing,
    state: 'thinking' as const,
    task: null,
    progress: { ...typing.progress, summary: '刚才：修改 first.ts' },
  };
  assert.equal(workAnimationState(retained), 'working');
  assert.equal(workAnimationSlot(retained, animations), '写代码');
  assert.equal(workAnimationKey(retained), workAnimationKey(typing));
  const viewing = { ...typing, progress: { ...progress, action: 'viewing' as const } };
  assert.equal(workAnimationSlot(viewing, animations), '东张西望');
  assert.notEqual(workAnimationKey(viewing), workAnimationKey(typing));
  assert.equal(workAnimationKey({ ...typing, task: '正在修改 second.ts' }), workAnimationKey(typing));
  const expired = { ...retained, progress: { ...retained.progress, summary: null } };
  assert.equal(workAnimationState(expired), 'thinking');
  assert.equal(workAnimationSlot(expired, animations), 'think');
  const custom = { ...animations, categories: [], turn: [] };
  assert.equal(workAnimationSlot(typing, custom), 'work');
  assert.equal(workAnimationSlot(viewing, custom), 'work');
  assert.equal(workAnimationSlot({ ...retained, state: 'waiting' }, animations), 'wait');
  assert.equal(workAnimationSlot({ ...typing, progress: { ...typing.progress, mode: 'idle' } }, animations), 'work');
  const parsed = toWorkStatus(typing);
  assert.equal(parsed?.progress?.action, 'typing');
  assert.equal(
    workAnimationSlot(
      { state: 'thinking', task: null, progress: { ...progress, summary: '刚才：修改 old.ts' } },
      animations,
    ),
    '写代码',
  );
});
