import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { balanceBubbleView, balancePercent } from '../shared/balance/index.ts';
import { fetchState, flattenCounters, readBalance, takeChanged } from '../shared/state.ts';

const script = fileURLToPath(new URL('../../scripts/dev/mock-server.mjs', import.meta.url));

async function startMock(t: TestContext, shape = 'money'): Promise<string> {
  const child = spawn(process.execPath, ['--experimental-strip-types', script, '0', shape], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock startup timed out: ' + stderr)), 5000);
    child.stdout.on('data', (data) => {
      stdout += data;
      const match = stdout.match(/\[mock-server\] listening on (http:\/\/127\.0\.0\.1:\d+\/dsh-pet-7340)\//);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('mock exited: ' + stderr));
    });
  });
}

for (const [shape, text] of [
  ['money', '¥11.06'],
  ['windows', '额度'],
  ['points', '800 积分'],
]) {
  test(`dev mock: ${shape} flows through the current state and balance consumers`, async (t) => {
    const base = await startMock(t, shape);
    const initial = await fetchState(base + '/state');
    assert.ok(initial, '/state must return a valid snapshot');
    assert.equal(typeof initial.counter, 'number');
    const balance = readBalance(initial.sections.balance);
    assert.ok(balance?.state.ok);
    assert.equal(balance.state.shape, shape);
    assert.equal(balance.manual, false);
    assert.ok(balanceBubbleView(balance.state).some((row) => row.text.includes(text)));
    assert.equal(typeof balancePercent(balance.state), 'number');

    const baseline = flattenCounters(initial);
    const refreshed = await fetch(base + '/balance', { method: 'POST' });
    assert.deepEqual(await refreshed.json(), { ok: true });
    const next = await fetchState(base + '/state', { since: initial.counter!, timeoutMs: 1000 });
    assert.ok(next);
    assert.ok(next.counter! > initial.counter!);
    const changed = takeChanged(next, baseline);
    assert.deepEqual(
      changed.map((change) => change.path),
      ['sections.balance'],
    );
    assert.equal(readBalance(changed[0].leaf)?.manual, true);
    assert.equal((await fetch(base + '/balance')).status, 405);
    assert.equal((await fetch(base + '/balance/trigger')).status, 404);
  });
}

test('dev mock: unchanged state waits, refresh wakes it, and timeout preserves counters', async (t) => {
  const base = await startMock(t);
  const initial = await fetchState(base + '/state');
  assert.ok(initial && typeof initial.counter === 'number');
  const pending = fetchState(base + '/state', { since: initial.counter, timeoutMs: 1000 });
  assert.equal(await Promise.race([pending.then(() => 'returned'), delay(80, 'waiting')]), 'waiting');
  await fetch(base + '/balance', { method: 'POST' });
  const changed = await pending;
  assert.ok(changed && changed.counter! > initial.counter);
  const same = await fetchState(base + '/state', { since: changed.counter!, timeoutMs: 30 });
  assert.deepEqual(same, changed);
});

test('dev mock: invalid wait queries are rejected and config uses package defaults', async (t) => {
  const base = await startMock(t);
  for (const query of ['since=1', 'timeout=1', 'since=bad&timeout=1', 'since=0&timeout=10001']) {
    assert.equal((await fetch(base + '/state?' + query)).status, 400, query);
  }
  const res = await fetch(base + '/config');
  assert.equal(res.status, 200);
  const config = await res.json();
  assert.ok(Array.isArray(config.main.pets));
  assert.equal(config.main.pets[0].id, 'main');
  assert.equal((await fetch(base + '/state', { method: 'POST' })).status, 405);
  const font = await fetch(base + '/font/' + encodeURIComponent('上首软糖体.ttf'));
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/ttf');
  await font.body?.cancel();
});
