import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  backupFile,
  calcSha256,
  loadJobManifest,
  rollbackJob,
  saveJobManifest,
  type OptimizationJob,
} from '../src/optimizer-storage.js';

test('backupFile creates copy and computes correct SHA-256', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opt-storage-test-'));
  try {
    const srcFile = join(dir, 'original.txt');
    const content = Buffer.from('Original image dummy bytes 123456');
    await writeFile(srcFile, content);

    const backupDir = join(dir, 'backups');
    const backup = await backupFile(srcFile, backupDir);

    assert.equal(backup.sha256, calcSha256(content));
    assert.equal(backup.bytes, content.length);

    const backupContent = await readFile(backup.backupPath);
    assert.equal(calcSha256(backupContent), backup.sha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveJobManifest and loadJobManifest roundtrip properly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opt-manifest-test-'));
  try {
    const manifestPath = join(dir, 'job.json');
    const job: OptimizationJob = {
      schemaVersion: 1,
      id: 'job-123',
      createdAt: '2026-09-09T10:00:00Z',
      updatedAt: '2026-09-09T10:00:00Z',
      sourceDirectory: '/src',
      backupDirectory: '/backup',
      totalOriginalBytes: 1000,
      totalOptimizedBytes: 300,
      totalSavedBytes: 700,
      items: [
        {
          id: 'item-1',
          originalPath: '/src/a.png',
          originalSha256: 'aaa',
          originalBytes: 1000,
          backupPath: '/backup/a.png',
          optimizedPath: '/out/a.webp',
          savedBytes: 700,
          savedPercent: 70,
          status: 'optimized',
        },
      ],
    };

    await saveJobManifest(job, manifestPath);
    const loaded = await loadJobManifest(manifestPath);

    assert.equal(loaded.id, 'job-123');
    assert.equal(loaded.totalSavedBytes, 700);
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.items[0]?.status, 'optimized');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rollbackJob restores original file when backup is valid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opt-rollback-test-'));
  try {
    const srcFile = join(dir, 'target.jpg');
    const originalBytes = Buffer.from('Original content before optimization');
    await writeFile(srcFile, originalBytes);

    const backupDir = join(dir, 'backups');
    const backup = await backupFile(srcFile, backupDir);

    // Simulate file modification (optimization changed it)
    await writeFile(srcFile, Buffer.from('Modified optimized content'));

    const manifestPath = join(dir, 'job.json');
    const job: OptimizationJob = {
      schemaVersion: 1,
      id: 'job-rollback',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceDirectory: dir,
      backupDirectory: backupDir,
      totalOriginalBytes: backup.bytes,
      totalOptimizedBytes: 25,
      totalSavedBytes: backup.bytes - 25,
      items: [
        {
          id: 'item-1',
          originalPath: srcFile,
          originalSha256: backup.sha256,
          originalBytes: backup.bytes,
          backupPath: backup.backupPath,
          optimizedPath: srcFile,
          optimizedSha256: calcSha256(Buffer.from('Modified optimized content')),
          savedBytes: 10,
          savedPercent: 20,
          status: 'optimized',
        },
      ],
    };
    await saveJobManifest(job, manifestPath);

    const rollbackResult = await rollbackJob(manifestPath);
    assert.equal(rollbackResult.restoredCount, 1);
    assert.equal(rollbackResult.errors.length, 0);

    const restoredBytes = await readFile(srcFile);
    assert.equal(calcSha256(restoredBytes), backup.sha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
