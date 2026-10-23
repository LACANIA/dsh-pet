import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeChatMemory, readChatMemory } from './chat-memory.ts';

const user = { role: 'user', content: 'hello', ts: 1 };
const assistant = { role: 'assistant', content: 'hi', ts: 2 };

test('chat memory preserves valid histories, empty buckets and additional fields', () => {
  const input = { main: { first: { messages: [user, assistant], note: 'keep' }, second: { messages: [] } }, extra: {} };
  const result = normalizeChatMemory(input);
  assert.equal(result.damaged, false);
  assert.deepEqual(result.memory, input);
});

test('chat memory rejects non-object roots instead of exposing array methods on invalid values', () => {
  for (const input of [null, [], 'text', 42, true]) {
    assert.deepEqual(normalizeChatMemory(input), { memory: {}, damaged: true });
  }
  assert.deepEqual(normalizeChatMemory({}), { memory: {}, damaged: false });
});

test('chat memory recovers other pets and entries when one bucket has the wrong shape', () => {
  const input = {
    badEntry: [],
    main: { first: { messages: {} }, second: { messages: [user] }, broken: null },
    other: { third: { messages: [assistant] } },
  };
  const result = normalizeChatMemory(input);
  assert.equal(result.damaged, true);
  assert.deepEqual(result.memory, {
    main: { second: { messages: [user] } },
    other: { third: { messages: [assistant] } },
  });
});

test('chat memory filters malformed messages while retaining valid messages in their original order', () => {
  const invalid = [
    null,
    [],
    {},
    { ...user, role: 'system' },
    { ...user, content: 123 },
    { ...user, ts: '1' },
    { ...user, ts: NaN },
    { ...user, ts: Infinity },
  ];
  const result = normalizeChatMemory({ main: { first: { messages: [user, ...invalid, assistant] } } });
  assert.equal(result.damaged, true);
  assert.deepEqual(result.memory.main.first.messages, [user, assistant]);
});

test('chat memory recovery does not mutate the source objects or arrays', () => {
  const input = { main: { first: { messages: [user, null, assistant] } } };
  const original = structuredClone(input);
  const result = normalizeChatMemory(input);
  result.memory.main.first.messages.push({ role: 'user', content: 'new', ts: 3 });
  assert.deepEqual(input, original);
});

test('chat memory keeps literal dictionary keys without changing object prototypes', () => {
  const input = JSON.parse('{"__proto__":{"constructor":{"messages":[{"role":"user","content":"hi","ts":0}]}}}');
  const result = normalizeChatMemory(input);
  assert.equal(result.damaged, false);
  assert.deepEqual(result.memory, input);
  assert.equal(Object.getPrototypeOf(result.memory), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.memory.__proto__), Object.prototype);
});

test('chat memory missing files return empty history without creating files', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await readChatMemory(join(dir, 'memory.json')), {});
  assert.deepEqual(readdirSync(dir), []);
});

test('chat memory valid files remain unchanged and do not create backups', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.json');
  const input = { main: { first: { messages: [user, assistant] } } };
  const raw = JSON.stringify(input, null, 2);
  writeFileSync(path, raw);
  assert.deepEqual(await readChatMemory(path), input);
  assert.equal(readFileSync(path, 'utf8'), raw);
  assert.deepEqual(readdirSync(dir), ['memory.json']);
});

test('chat memory structurally damaged files are backed up byte-for-byte and valid histories survive', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.json');
  const raw = JSON.stringify({ main: { first: { messages: {} }, second: { messages: [user, null, assistant] } } });
  writeFileSync(path, raw);
  assert.deepEqual(await readChatMemory(path), { main: { second: { messages: [user, assistant] } } });
  const backups = readdirSync(dir).filter((p) => p.startsWith('memory.json.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), raw);
  assert.equal(readFileSync(path, 'utf8'), raw);
});

test('chat memory malformed JSON retains the backup-and-empty-history behavior', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.json');
  writeFileSync(path, '{malformed');
  assert.deepEqual(await readChatMemory(path), {});
  const backups = readdirSync(dir).filter((p) => p.startsWith('memory.json.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), '{malformed');
});
