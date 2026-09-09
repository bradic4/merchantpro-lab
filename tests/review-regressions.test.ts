import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optimizeImage, generateResponsiveSet } from '../src/image-pipeline.js';
import { backupFile, rollbackJob, saveJobManifest } from '../src/optimizer-storage.js';
import { startServer } from '../src/server.js';
import { generateRemediationPlan } from '../src/remediation.js';
import { benchmarkRows } from '../src/benchmark-rows.js';

test('rollback preserves edits and ignores export jobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rollback-conflict-'));
  try {
    const originalPath = join(dir,'source');
    await writeFile(originalPath,'original');
    const backup = await backupFile(originalPath,join(dir,'backup'));
    await writeFile(originalPath,'later user edit');
    const item = { originalPath, optimizedPath: originalPath, originalSha256: backup.sha256,
      optimizedSha256: 'does-not-match', backupPath: backup.backupPath, status: 'optimized' };
    const job = join(dir,'job.json');
    await saveJobManifest({schemaVersion:1,items:[item]} as any, job);
    const conflict = await rollbackJob(job);
    assert.equal(conflict.restoredCount,0);
    assert.equal(conflict.errors.length,1);
    assert.equal(await readFile(originalPath,'utf8'),'later user edit');
    item.optimizedPath = join(dir,'export.webp');
    await saveJobManifest({schemaVersion:1,items:[item]} as any, job);
    assert.deepEqual(await rollbackJob(job),{restoredCount:0,errors:[]});
    assert.equal(await readFile(originalPath,'utf8'),'later user edit');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('EXIF rotation respects final width and responsive descriptors are unique', async () => {
  const input = await sharp({create:{width:600,height:1200,channels:3,background:'#ccc'}})
    .jpeg().withMetadata({orientation:6}).toBuffer();
  const result = await optimizeImage(input,{profile:'medium',force:true});
  assert.equal(result.width,800); assert.equal(result.height,400);
  const small = await sharp({create:{width:200,height:100,channels:3,background:'#ccc'}}).png().toBuffer();
  const set = await generateResponsiveSet(small,'small.png');
  assert.equal(set.variants.length,1);
  assert.equal(set.suggestedSrcset,'small-thumb.webp 200w');
  await assert.rejects(optimizeImage(small,{format:'jpeg' as any}));
});

test('local API rejects foreign origins and headerless mutations; filesystem endpoints are closed', async () => {
  const dir = await mkdtemp(join(tmpdir(),'server-isolated-'));
  const h = await startServer({port:0,dataDirectory:dir});
  try {
    const headers = {'Content-Type':'application/json','X-MerchantPro-Request':'1'};
    assert.equal((await fetch(h.url+'/api/rollback',{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:'{}'})).status,403);
    assert.equal((await fetch(h.url+'/api/rollback',{method:'POST',body:'{}'})).status,403);
    assert.equal((await fetch(h.url+'/api/rollback',{method:'POST',headers,body:'{}'})).status,410);
    assert.equal((await fetch(h.url+'/api/remediation?file=../../secret.json')).status,400);
    const res = await fetch(h.url+'/api/benchmarks');
    assert.equal(res.headers.get('access-control-allow-origin'),null);
    assert.deepEqual(await res.json(),{rows:[]});
  } finally { await h.close(); await rm(dir,{recursive:true,force:true}); }
});

test('remediation separates observed requests from unproven effects and preserves zero', () => {
  const plan = generateRemediationPlan({configSettings:{formFactor:'desktop'},audits:{
    'total-blocking-time':{numericValue:0},
    'network-requests':{details:{items:[
      {url:'https://cdn.example/p/l/image.webp',mimeType:'image/webp',transferSize:300000},
      {url:'https://static.elfsight.com/platform/platform.js'},
      {url:'https://mc.yandex.ru/metrika/tag.js'}]}}}});
  assert.equal(plan.score,null);
  assert.equal(plan.issues.some(i=>i.type==='desktop-image-on-mobile'),false);
  assert.equal(plan.issues.some(i=>i.type==='blocking-chatbot'),false);
  assert.ok(plan.issues.every(i=>i.estimatedSavings===undefined));
  assert.match(plan.markdownReport,/0.0 s/);
  assert.doesNotMatch(plan.markdownReport,/60–80|20–25|3–8/);
});

test('benchmark rows separate pages, profiles and runs and retain zero', () => {
  const measurement = (pageId:string,settingsHash:string,value:number) => ({pageId,storeId:'s',status:'succeeded',measurement:{
    device:'mobile',settingsHash,lighthouseVersion:'13',browserVersion:'1',source:'lighthouse',finalUrl:'https://example.com/'+pageId,
    metrics:{performance:value,tbtMs:value}}});
  const state:any = {id:'run',kind:'live',updatedAt:'2026-09-09',manifest:{protocol:{runs:3},stores:[{
    id:'s',name:'Store',platform:'merchantpro',role:'sample',pages:[{id:'home',type:'home'},{id:'product',type:'product'}]}]},
    items:[measurement('home','a',0),measurement('home','a',100),measurement('home','b',200),measurement('product','a',300)]};
  const rows = benchmarkRows(state,'run-folder');
  assert.equal(rows.length,3);
  assert.equal(rows[0]!.score,50);
  assert.equal(rows[0]!.measurementsCount,'2/3');
  assert.equal(rows[0]!.tbt,'0.1 s');
  assert.equal(benchmarkRows({...state,kind:'demo'},'demo').length,0);
  assert.equal(benchmarkRows({...state,id:'new-run'},'new')[0]!.runId,'new-run');
});
