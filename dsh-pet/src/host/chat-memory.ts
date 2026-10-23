import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChatMemoryMessage } from './chat';

export type ChatMemory = Record<string, Record<string, { messages: ChatMemoryMessage[] }>>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function message(value: unknown): value is ChatMemoryMessage {
  return (
    record(value) &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    typeof value.ts === 'number' &&
    Number.isFinite(value.ts)
  );
}

/** Recover valid buckets and messages without mutating the parsed file or mixing pet histories. */
export function normalizeChatMemory(input: unknown): { memory: ChatMemory; damaged: boolean } {
  if (!record(input)) return { memory: {}, damaged: true };
  let damaged = false;
  const entries: Array<[string, ChatMemory[string]]> = [];
  for (const [entry, bucket] of Object.entries(input)) {
    if (!record(bucket)) {
      damaged = true;
      continue;
    }
    const pets: Array<[string, { messages: ChatMemoryMessage[] }]> = [];
    for (const [petId, pet] of Object.entries(bucket)) {
      if (!record(pet) || !Array.isArray(pet.messages)) {
        damaged = true;
        continue;
      }
      const messages = pet.messages.filter(message);
      if (messages.length !== pet.messages.length) damaged = true;
      pets.push([petId, { ...pet, messages }]);
    }
    entries.push([entry, Object.fromEntries(pets)]);
  }
  return { memory: Object.fromEntries(entries), damaged };
}

/** Keep the original file as a backup and return recoverable history to GET and POST alike. */
export async function readChatMemory(path: string): Promise<ChatMemory> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  let recovered: ChatMemory = {};
  try {
    const result = normalizeChatMemory(JSON.parse(raw));
    if (!result.damaged) return result.memory;
    recovered = result.memory;
    throw new Error('invalid chat memory structure');
  } catch (e) {
    console.error(
      `dsh-pet: 记忆文件异常，备份原文并恢复有效对话：${path}（${e instanceof Error ? e.message : String(e)}）`,
    );
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.bak-${Date.now()}`, raw, 'utf8');
    } catch {
      // Keep the previous best-effort backup behavior; never rewrite the original while reading.
    }
    return recovered;
  }
}
