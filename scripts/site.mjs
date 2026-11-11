import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validAssets,validPlan,requiredChecks} from './delivery.mjs';
const repository='treisland/presentation-studio';
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function releaseVersion(tag,channel){
  const match=/^v(\d+\.\d+\.\d+)(?:-(beta|rc)\.(\d+))?$/.exec(tag);
  if(!match||!['stable','beta'].includes(channel)||channel==='stable'&&match[2]||channel==='beta'&&!match[2])throw Error('Release/channel mismatch; stable accepts stable versions, beta accepts beta/RC only.');
  return tag.slice(1);
}
export function buildIdentity(html){
  const text=html.match(/<script id="studio-build-info" type="application\/json">([^<]+)<\/script>/)?.[1];
  if(!text)throw Error('This release predates embedded build identity. A new approved release is required.');
  const info=JSON.parse(text);
  if(typeof info.version!=='string'||! /^[a-f0-9]{40}$/.test(info.commit)||!['stable','beta','rc','development'].includes(info.channel))throw Error('Invalid embedded build identity.');
  return info;
}
export function verifyRelease(release,version){
  if(release.draft||!release.published_at||release.tag_name!=='v'+version||release.prerelease!==version.includes('-')||!validAssets(release.assets,version))throw Error('A published release with exactly four complete SHA256-digested assets is required.');
}
export function authorizedDistribution(plan,channel,target){
  const targets=target==='both'?['pages','docker']:[target];
  if(!plan.distribution?.channels?.includes(channel)||targets.some(t=>!['pages','docker'].includes(t)||!plan.distribution?.targets?.includes(t)))throw Error('Tagged plan does not explicitly authorize the requested distribution targets/channel.');
}
export function verifyPayload(bytes,asset){if(bytes.length!==asset.size||'sha256:'+hash(bytes)!==asset.digest)throw Error('Release asset integrity mismatch: '+asset.name);}
export function noDowngrade(current,next){
  const parse=v=>{const m=/^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(v);if(!m)throw Error('Invalid deployed version.');return [+m[1],+m[2],+m[3],m[4]?{alpha:0,beta:1,rc:2}[m[4]]:3,+(m[5]||0)];};
  const a=parse(current),b=parse(next);for(let i=0;i<a.length;i++){if(b[i]<a[i])throw Error('Channel downgrade refused; rollback requires a reviewed compatibility procedure.');if(b[i]>a[i])return;}
}
async function api(path){const r=await fetch('https://api.github.com/repos/'+repository+'/'+path,{headers:{Accept:'application/vnd.github+json',...(process.env.GH_TOKEN?{Authorization:'Bearer '+process.env.GH_TOKEN}:{})},signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('GitHub API '+r.status+' for '+path);return r.json();}
async function content(path,sha){const file=await api('contents/'+path+'?ref='+sha);return JSON.parse(Buffer.from(file.content,'base64').toString());}
async function bytes(asset){
  const r=await fetch(asset.url,{headers:{Accept:'application/octet-stream',...(process.env.GH_TOKEN?{Authorization:'Bearer '+process.env.GH_TOKEN}:{})},signal:AbortSignal.timeout(60000)});
  if(!r.ok)throw Error('Asset download failed: '+r.status);
  const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>asset.size||size>30000000)throw Error('Asset exceeds declared size.');chunks.push(chunk);}
  const data=Buffer.concat(chunks);verifyPayload(data,asset);return data;
}
export async function publishedPayload(tag,channel,target='pages'){
  const version=releaseVersion(tag,channel),release=await api('releases/tags/'+tag);verifyRelease(release,version);
  let ref=(await api('git/ref/tags/'+tag)).object;if(ref.type==='tag')ref=(await api('git/tags/'+ref.sha)).object;
  if(ref.type!=='commit'||!/^[a-f0-9]{40}$/.test(ref.sha))throw Error('Invalid release tag.');
  const commit=ref.sha,comparison=await api('compare/'+commit+'...main');if(!['ahead','identical'].includes(comparison.status))throw Error('Release commit is not an ancestor of main.');
  const plan=await content('release-plan.json',commit),pkg=await content('package.json',commit);
  if(pkg.version!==version||!validPlan(plan,version))throw Error('Tagged release plan does not authorize this release.');
  authorizedDistribution(plan,channel,target);
  const checks=await api('commits/'+commit+'/check-runs?per_page=100');
  if(!requiredChecks.every(name=>checks.check_runs.some(c=>c.name===name&&c.app?.id===15368&&c.status==='completed'&&c.conclusion==='success')))throw Error('Exact release Windows/Linux validation missing.');
  const runs=await api('actions/workflows/release.yml/runs?head_sha='+commit+'&per_page=100');
  const run=runs.workflow_runs.filter(r=>r.head_sha===commit&&r.head_branch===tag&&r.event==='push').sort((a,b)=>b.id-a.id)[0];
  if(!run||run.status!=='completed'||run.conclusion!=='success')throw Error('Tag release workflow is not successful.');
  const payload={};for(const asset of release.assets)payload[asset.name]=await bytes(asset);
  const html=payload['presentation-studio.html'],blank=payload['presentation-studio-blank.html'];
  for(const data of [html,blank]){const info=buildIdentity(data.toString());if(info.version!==version||info.commit!==commit||info.dirty||info.channel!== (version.includes('-')?version.split('-')[1].split('.')[0]:'stable'))throw Error('Loaded application identity differs from immutable release.');}
  return {html,blank,info:buildIdentity(html.toString()),receipt:{version,commit,tag,releaseId:release.id,releaseRun:run.id,channel,assets:release.assets.map(({name,size,digest})=>({name,size,digest}))}};
}
export async function writeSite(directory,{html,blank,info,receipt}){
  await mkdir(resolve(directory,'docs'),{recursive:true});
  const files={'index.html':html,'blank.html':blank,'version.json':JSON.stringify(info,null,2)+'\n','distribution.json':JSON.stringify({...receipt,payload:{'index.html':hash(html),'blank.html':hash(blank)}},null,2)+'\n',
    'docs/index.html':'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Presentation Studio help</title><main><h1>Presentation Studio</h1><p>Presentations stay in this browser. Export an editable ZIP for backup, moving to another device or switching between stable and beta.</p><p>Docker serves the app; it does not store or share presentations. Container volumes do not back up browser recovery.</p><p>Use Project → About for the loaded version and supported imports. Unsupported future formats leave your current work intact.</p><p><a href="../">Open Studio</a> · <a href="https://github.com/treisland/presentation-studio#readme">Documentation and downloads</a></p></main></html>'};
  for(const [name,data]of Object.entries(files))await writeFile(resolve(directory,name),data);
}
async function main(){
  const [mode,tag,channel,target='pages']=process.argv.slice(2);
  if(mode==='local'){
    const html=await readFile('dist/presentation-studio.html'),blank=await readFile('dist/presentation-studio-blank.html'),info=buildIdentity(html.toString());
    await writeSite('site',{html,blank,info,receipt:{version:info.version,commit:info.commit,sourceHead:process.env.PR_HEAD_SHA||info.commit,channel:'review',review:true}});
  }else if(mode==='release'){
    const payload=await publishedPayload(tag,channel,target);
    const url=process.env.CURRENT_SITE_URL;
    if(url){if(!['https://pres-studio.com/','https://beta.pres-studio.com/'].includes(url))throw Error('Unexpected deployment origin.');const r=await fetch(new URL('distribution.json',url),{signal:AbortSignal.timeout(15000)});if(r.ok){const old=await r.json();noDowngrade(old.version,payload.info.version);if(old.version===payload.info.version&&old.commit!==payload.info.commit)throw Error('Conflicting same-version deployment.');}else if(r.status!==404)throw Error('Cannot verify current channel version.');}
    await writeSite('site',payload);
  }else throw Error('Usage: node scripts/site.mjs local | release vVERSION stable|beta');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
