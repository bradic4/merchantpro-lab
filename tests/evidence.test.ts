import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile,readdir,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import sharp from 'sharp';
import {analyzeResources} from '../src/resource-analysis.js';
import {inspectImages,compareImageSnapshots,loadVerifiedSnapshot} from '../src/image-inspector.js';

test('actual Lighthouse 13 insight fixture preserves DOM/node/blocking evidence without guessing LCP URL',async()=>{
  const raw=JSON.parse(await readFile(new URL('./fixtures/lighthouse-13-insights.json',import.meta.url),'utf8'));
  const result=analyzeResources(raw)!;
  assert.equal(result.domElements,2984);
  assert.equal(result.lcpElement?.tagName,'IMG');
  assert.ok(result.lcpElement?.selector);
  assert.equal(result.lcpElement?.url,null);
  assert.equal(result.blockingResources.length,9);
  assert.equal(result.totalBlockingMs,null); // Some request durations are unavailable.
  assert.ok(result.images.every(i=>!i.isLcpElement));
  assert.equal(analyzeResources({audits:{'render-blocking-insight':{details:{items:[]}}}})?.totalBlockingMs,0);
});

test('CLI export preserves duplicate basenames, original dimensions and earlier jobs',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'image-export-'));
  try{
    const input=join(dir,'input'),output=join(dir,'output');await mkdir(input);
    const source=sharp({create:{width:1200,height:600,channels:3,background:'#aabbcc'}});
    await writeFile(join(input,'photo.png'),await source.clone().png().toBuffer());
    await writeFile(join(input,'photo.jpg'),await source.clone().jpeg().toBuffer());
    const run=()=>execFileSync(process.execPath,['--import','tsx','src/cli.ts','optimize-images','--input',input,'--out',output,'--profile','thumb'],{timeout:30000,stdio:'pipe'});
    run();const first=(await readdir(output))[0]!;
    const manifest=JSON.parse(await readFile(join(output,first,'optimization-job.json'),'utf8'));
    assert.equal(new Set(manifest.items.map((x:any)=>x.optimizedPath)).size,2);
    for(const item of manifest.items){assert.deepEqual(item.originalDimensions,{width:1200,height:600});assert.deepEqual(item.optimizedDimensions,{width:320,height:160});await readFile(item.optimizedPath);}
    const before=await readFile(manifest.items[0].optimizedPath);run();
    assert.equal((await readdir(output)).length,2);
    assert.deepEqual(await readFile(manifest.items[0].optimizedPath),before);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Chrome captures currentSrc, DPR, decoded pixels, gallery state and rejects missing/tampered evidence', {timeout:90000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'image-browser-'));
  const small=await sharp({create:{width:320,height:160,channels:3,background:'#336699'}}).png().toBuffer();
  const large=await sharp({create:{width:960,height:480,channels:3,background:'#336699'}}).png().toBuffer();
  const server=createServer((req,res)=>{
    if(req.url==='/small.png'||req.url==='/large.png'){res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(req.url==='/small.png'?small:large);return;}
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><img id="hero" width="320" height="160" src="/small.png" srcset="/small.png 320w, /large.png 960w" sizes="320px"><button id="next" onclick="document.getElementById('hero').removeAttribute('srcset');document.getElementById('hero').src='/small.png'">Next</button>`);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
    const port=(server.address() as any).port;
    const snaps=await inspectImages({url:`http://127.0.0.1:${port}/`,state:'A',directory:join(dir,'a'),dpr:2,gallerySelector:'#next',allowLoopbackFixture:true});
    const initial=snaps[0]!,gallery=snaps[1]!;
    assert.match(initial.images[0]!.currentSrc,/large.png$/);
    assert.equal(initial.images[0]!.renderedWidth,320);
    assert.equal(initial.images[0]!.response?.decodedWidth,960);
    assert.equal(initial.images[0]!.response?.decodedFormat,'png');
    assert.equal(initial.images[0]!.response?.bodyBytes,large.length);
    assert.ok(initial.images[0]!.response!.encodedBytes!>0);
    assert.match(gallery.images[0]!.currentSrc,/small.png$/);
    assert.equal(compareImageSnapshots(initial,gallery,0).comparable,false);
    const missing=structuredClone(initial);missing.images[0]!.response=null;
    assert.equal(compareImageSnapshots(initial,missing,0).observedTransferDifference,null);
    const different=structuredClone(initial);different.profile.dpr=3;
    assert.equal(compareImageSnapshots(initial,different,0).comparable,false);
    assert.equal((await loadVerifiedSnapshot(join(dir,'a','initial.json'))).state,'A');
    await writeFile(join(dir,'a','initial.json'),'{}');
    await assert.rejects(loadVerifiedSnapshot(join(dir,'a','initial.json')),/hash mismatch/);
  }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
