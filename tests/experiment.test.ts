import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { experimentItems, runExperiment, usablePairs, validateExperiment, verifyTarget, type ExperimentConfig } from '../src/experiment.js';
import { syntheticLhr } from '../src/demo.js';

const config: ExperimentConfig = { schemaVersion: 1, id: 'test', storeId: 'test', pageId: 'home', url: 'https://shop.example/', targetPrefix: 'https://cdn.example/chatbot/', hypothesis: 'Test', protocol: { device: 'mobile', runs: 5, location: 'test', consent: 'no-interaction', browserCache: 'cold', cdnCache: 'unknown', notes: '' } };
function network(blocked: boolean) {
  return [{ method: 'Network.requestWillBeSent', params: { requestId: '1', request: { url: `${config.targetPrefix}widget.js` } } }, blocked
    ? { method: 'Network.loadingFailed', params: { requestId: '1', blockedReason: 'inspector' } }
    : { method: 'Network.responseReceived', params: { requestId: '1', response: { status: 200 } } }];
}
test('five interleaved AB/BA pairs and narrow external target validation', () => {
  assert.equal(experimentItems().map(i => i.variant === 'baseline' ? 'A' : 'B').join(''), 'ABBAABBAAB');
  validateExperiment(config);
  for (const targetPrefix of ['https://cdn.example/', 'https://shop.example/chat/', 'http://cdn.example/chat/', 'https://cdn.example/*']) assert.throws(() => validateExperiment({ ...config, targetPrefix }));
});
test('missing resource is not proof of blocked resource; inspector block is required', () => {
  assert.deepEqual(verifyTarget({}, [], config.targetPrefix), { attempted: 0, loaded: 0, blocked: 0, executed: 0 });
  assert.equal(verifyTarget({}, network(true), config.targetPrefix).blocked, 1);
  const failed = network(true); (failed[1].params as any).blockedReason = 'other';
  assert.equal(verifyTarget({}, failed, config.targetPrefix).blocked, 0);
});
test('experiment preserves evidence, resumes completed runs, rejects mixed profiles and tampering', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merchantpro-experiment-test-'));
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(directory.includes('merchantpro-experiment-test-')); await rm(directory, { recursive: true, force: true }); });
  let calls = 0;
  const capture: Parameters<typeof runExperiment>[0]['capture'] = async (url, protocol, chrome, options) => {
    const blocked = !!options?.blockedUrlPatterns.length;
    const raw = syntheticLhr(url, ++calls) as any;
    raw.configSettings.blockedUrlPatterns = options?.blockedUrlPatterns;
    raw.runWarnings = [];
    raw.audits['bootup-time'] = { details: { items: blocked ? [] : [{ url: `${config.targetPrefix}widget.js`, scripting: 1000 }] } };
    return { raw, trace: {}, network: network(blocked) };
  };
  const state = await runExperiment({ config, directory, capture });
  assert.equal(calls, 10); assert.equal(usablePairs(state).length, 5);
  await runExperiment({ config, directory, capture, resume: true }); assert.equal(calls, 10);
  const changed = structuredClone(state); changed.items[1].comparisonHash = 'wrong';
  assert.equal(usablePairs(changed).length, 4);
  changed.items[3].evidence!.loaded = 0;
  assert.equal(usablePairs(changed).length, 3);
  assert.match(await readFile(join(directory, 'report.md'), 'utf8'), /5\/5/);
  await writeFile(join(directory, 'raw', `${state.items[0].id}.json`), '{}');
  await assert.rejects(runExperiment({ config, directory, capture, resume: true }), /Integritet/);
});
