import puppeteer from 'puppeteer-core';
import { launch } from 'chrome-launcher';
import sharp from 'sharp';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicUrl } from './manifest.js';
import { sha256, writeJson } from './storage.js';

export interface InspectOptions {
  url: string; state: 'A'|'B'|'C'|'restored'; directory: string;
  width?: number; height?: number; dpr?: number; gallerySelector?: string;
  /** Only for controlled loopback fixtures; not exposed by the CLI. */
  allowLoopbackFixture?: boolean;
}
export interface InspectedImage {
  index:number; currentSrc:string; srcset:string; sizes:string; complete:boolean;
  naturalWidth:number; naturalHeight:number; renderedWidth:number; renderedHeight:number;
  loading:string; visible:boolean;
  response: null | {status:number; mimeType:string; encodedBytes:number|null; fromCache:boolean;
    headers:Record<string,string>; bodySha256:string|null; bodyBytes:number|null;
    decodedFormat:string|null; decodedWidth:number|null; decodedHeight:number|null; error:string|null};
}
export interface ImageSnapshot {
  schemaVersion:1; state:InspectOptions['state']; requestedUrl:string; finalUrl:string;
  capturedAt:string; browser:string; userAgent:string;
  profile:{width:number;height:number;dpr:number;mobile:boolean;cache:'disabled';serviceWorker:'bypassed';settleMs:number};
  phase:'initial'|'gallery'; action:string|null; images:InspectedImage[];
  screenshot:{file:string;sha256:string}; warnings:string[];
}
export async function inspectImages(options:InspectOptions):Promise<ImageSnapshot[]> {
  const parsed=new URL(options.url);
  const fixture=options.allowLoopbackFixture && parsed.protocol==='http:' && parsed.hostname==='127.0.0.1';
  if (!fixture) publicUrl(options.url);
  if (!['A','B','C','restored'].includes(options.state)) throw new Error('State must be A, B, C or restored.');
  const width=options.width??412, height=options.height??823, dpr=options.dpr??1.75;
  if (![width,height].every(v=>Number.isInteger(v)&&v>=100&&v<=4000) || !Number.isFinite(dpr)||dpr<1||dpr>4) throw new Error('Invalid viewport or DPR.');
  await mkdir(options.directory,{recursive:false}); // Never replace an earlier experiment capture.
  const userDataDir=await mkdtemp(join(tmpdir(),'merchantpro-inspect-'));
  const chrome=await launch({userDataDir,chromeFlags:['--headless=new','--disable-gpu','--no-first-run']});
  let browser;
  const timer=setTimeout(()=>{try { chrome.kill(); } catch { /* cleanup is retried in finally */ }},90000); timer.unref();
  try {
    browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${chrome.port}`});
    const page=await browser.newPage();
    await page.setViewport({width,height,deviceScaleFactor:dpr,isMobile:width<768,hasTouch:width<768});
    await page.setCacheEnabled(false); await page.setBypassServiceWorker(true);
    const cdp=await page.createCDPSession(); await cdp.send('Network.enable');
    const responses=new Map<string,any>(); const finished=new Map<string,number>(); const cached=new Set<string>();
    cdp.on('Network.requestServedFromCache',e=>cached.add(e.requestId));
    cdp.on('Network.responseReceived',e=>{if(e.type==='Image')responses.set(e.requestId,e.response);});
    cdp.on('Network.loadingFinished',e=>{finished.set(e.requestId,e.encodedDataLength);});
    const nav=await page.goto(options.url,{waitUntil:'load',timeout:45000});
    if (!nav || nav.status()>=400) throw new Error(`Navigation failed: ${nav?.status()}`);
    const snapshots:ImageSnapshot[]=[];
    const capture=async(phase:'initial'|'gallery')=>{
      await new Promise(r=>setTimeout(r,1000));
      const selected=await page.evaluate(()=>Array.from(document.images).map((img,index)=>{
        const rect=img.getBoundingClientRect();
        return {index,currentSrc:img.currentSrc,srcset:img.srcset,sizes:img.sizes,complete:img.complete,
          naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,renderedWidth:rect.width,renderedHeight:rect.height,
          loading:img.loading,visible:rect.width>0&&rect.height>0&&rect.bottom>0&&rect.right>0&&rect.top<innerHeight&&rect.left<innerWidth};
      }));
      const images:InspectedImage[]=[];
      const decoded=new Map<string,InspectedImage['response']>();
      for(const img of selected){
        let response:InspectedImage['response']=null;
        const matches=[...responses.entries()].filter(([,r])=>r.url===img.currentSrc);
        const match=matches.at(-1);
        if(decoded.has(img.currentSrc)) response=decoded.get(img.currentSrc)!;
        else if(match){
          const [id,r]=match;
          const headers:Record<string,string>={};
          for(const [key,value] of Object.entries(r.headers)) if(['content-type','content-length','cache-control','age','etag','last-modified','vary','content-encoding'].includes(key.toLowerCase())) headers[key.toLowerCase()]=String(value);
          response={status:r.status,mimeType:r.mimeType,encodedBytes:finished.get(id)??null,
            fromCache:!!(cached.has(id)||r.fromDiskCache||r.fromServiceWorker||r.fromPrefetchCache),headers,
            bodySha256:null,bodyBytes:null,decodedFormat:null,decodedWidth:null,decodedHeight:null,error:null};
          try {
            if(!finished.has(id)) throw new Error('Image request is unfinished.');
            if(finished.get(id)!>10*1024*1024) throw new Error('Response exceeds 10 MB decoding limit.');
            const body=await cdp.send('Network.getResponseBody',{requestId:id});
            const bytes=Buffer.from(body.body,body.base64Encoded?'base64':'utf8');
            if(bytes.length>10*1024*1024) throw new Error('Decoded response exceeds 10 MB limit.');
            response.bodyBytes=bytes.length;response.bodySha256=sha256(bytes);
            const meta=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();
            const rotated=[5,6,7,8].includes(meta.orientation??1);
            response.decodedFormat=meta.format??null;
            response.decodedWidth=(rotated?meta.height:meta.width)??null;
            response.decodedHeight=(rotated?meta.width:meta.height)??null;
          } catch(e){response.error=e instanceof Error?e.message:String(e);}
          decoded.set(img.currentSrc,response);
        }
        images.push({...img,response});
      }
      const screenshotFile=`${phase}.png`; const screenshot=await page.screenshot({type:'png'});
      await writeFile(join(options.directory,screenshotFile),screenshot,{flag:'wx'});
      const snapshot:ImageSnapshot={schemaVersion:1,state:options.state,requestedUrl:options.url,finalUrl:page.url(),
        capturedAt:new Date().toISOString(),browser:await browser!.version(),userAgent:await page.evaluate(()=>navigator.userAgent),
        profile:{width,height,dpr,mobile:width<768,cache:'disabled',serviceWorker:'bypassed',settleMs:1000},phase,
        action:phase==='gallery'?options.gallerySelector??null:null,images,
        screenshot:{file:screenshotFile,sha256:sha256(Buffer.from(screenshot))},warnings:[
          'Observational image snapshot, not a Lighthouse performance run. CDN cache is not controlled.',
          'Only img elements in the main document are inspected; CSS backgrounds and iframe images are outside scope.',
          'A fixed post-load observation window may leave lazy or dynamic images unavailable.'
        ]};
      await writeJson(join(options.directory,`${phase}.json`),snapshot);
      snapshots.push(snapshot);
    };
    await capture('initial');
    if(options.gallerySelector){await page.click(options.gallerySelector);await capture('gallery');}
    await writeJson(join(options.directory,'manifest.json'),{schemaVersion:1,state:options.state,
      snapshots:snapshots.map(s=>({file:`${s.phase}.json`,sha256:sha256(JSON.stringify(s,null,2)+'\n')}))});
    return snapshots;
  } finally {
    clearTimeout(timer); await browser?.disconnect();
    try { await chrome.kill(); } finally { await rm(userDataDir,{recursive:true,force:true,maxRetries:6,retryDelay:500}).catch(e=>console.warn('Privremeni Chrome profil nije uklonjen:',e.code)); }
  }
}

export function compareImageSnapshots(a:ImageSnapshot,b:ImageSnapshot,index:number){
  const reasons:string[]=[];
  if(a.finalUrl!==b.finalUrl||a.requestedUrl!==b.requestedUrl)reasons.push('Different page URLs.');
  if(a.browser!==b.browser||a.userAgent!==b.userAgent||JSON.stringify(a.profile)!==JSON.stringify(b.profile))reasons.push('Different browser/profile.');
  if(a.phase!==b.phase||a.action!==b.action)reasons.push('Different interaction state.');
  const x=a.images.find(i=>i.index===index),y=b.images.find(i=>i.index===index);
  if(!x||!y||!x.complete||!y.complete||!x.visible||!y.visible)reasons.push('Missing or incomplete visible image.');
  if(x&&y&&(x.renderedWidth!==y.renderedWidth||x.renderedHeight!==y.renderedHeight))reasons.push('Different displayed dimensions.');
  for(const img of [x,y])if(!img?.response||img.response.status!==200||img.response.encodedBytes===null||img.response.error||!img.response.bodySha256||!img.response.decodedFormat||img.response.fromCache)reasons.push('Missing, failed or cached response evidence.');
  return {comparable:reasons.length===0,reasons,
    observedTransferDifference:reasons.length?null:x!.response!.encodedBytes!-y!.response!.encodedBytes!,
    conclusion:'Observation only: DOM index identity, visual quality, CDN state and repeated A/B/C/restoration checks must be reviewed. No speed or optimization success claim.'};
}

export async function loadVerifiedSnapshot(file:string):Promise<ImageSnapshot> {
  const {dirname,basename}=await import('node:path');
  const directory=dirname(file);
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  const entry=manifest.snapshots?.find((s:any)=>s.file===basename(file));
  const raw=await readFile(file);
  if(!entry||entry.sha256!==sha256(raw))throw new Error('Snapshot hash mismatch or missing manifest.');
  const snapshot=JSON.parse(raw.toString('utf8')) as ImageSnapshot;
  if(snapshot.schemaVersion!==1||!['initial','gallery'].includes(snapshot.phase)||!Array.isArray(snapshot.images))throw new Error('Invalid snapshot.');
  if(snapshot.screenshot.file!==`${snapshot.phase}.png`)throw new Error('Invalid screenshot path.');
  if(sha256(await readFile(join(directory,snapshot.screenshot.file)))!==snapshot.screenshot.sha256)throw new Error('Screenshot hash mismatch.');
  return snapshot;
}
