import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Manifest, RunState } from './domain.js';

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const manifestHash = (manifest: Manifest): string => sha256(JSON.stringify(manifest));
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
}
export async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }
export async function withLock<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, '.run.lock');
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error('Folder je zaključan. Ako je prethodni proces prekinut, proverite PID u .run.lock i obrišite samo taj lock pre --resume.');
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await fn();
  } finally { await handle.close(); await unlink(path); }
}
export function newRun(manifest: Manifest, kind: RunState['kind']): RunState {
  const now = new Date().toISOString();
  return { schemaVersion: 1, id: randomUUID(), manifestHash: manifestHash(manifest), manifest,
    createdAt: now, updatedAt: now, status: 'running', kind,
    items: manifest.stores.flatMap(store => store.pages.flatMap(page => Array.from({ length: manifest.protocol.runs }, (_, n) => ({
      id: `${store.id.length}_${store.id}_${page.id.length}_${page.id}_${n + 1}`, storeId: store.id, pageId: page.id, repetition: n + 1, status: 'pending' as const
    })))) };
}
export async function saveRun(directory: string, state: RunState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJson(join(directory, 'state.json'), state);
}
export async function ensureNewDirectory(directory: string): Promise<void> {
  const entries = await readdir(directory);
  if (entries.some(entry => entry !== '.run.lock')) throw new Error('Folder nije prazan. Koristite --resume ili novi --out folder.');
}
