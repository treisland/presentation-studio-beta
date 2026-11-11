// Executed from the trusted deployment repository; never execute downloaded PR code.
import {mkdir,writeFile} from 'node:fs/promises';
import {hash} from './site.mjs';
const repository='treisland/presentation-studio';
const [runId,sha]=process.argv.slice(2);
if(!/^\d+$/.test(runId)||!/^[a-f0-9]{40}$/.test(sha||''))throw Error('Expected CI run ID and full source head SHA.');
const headers={Accept:'application/vnd.github+json',...(process.env.GH_TOKEN?{Authorization:'Bearer '+process.env.GH_TOKEN}:{})};
async function api(path,repo=repository){const r=await fetch('https://api.github.com/repos/'+repo+'/'+path,{headers:repo===repository?{Accept:headers.Accept}:headers,signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('GitHub API returned '+r.status);return r.json();}
const run=await api('actions/runs/'+runId);
if(run.path!=='.github/workflows/validate.yml'||run.event!=='pull_request'||run.status!=='completed'||run.conclusion!=='success'||run.head_sha!==sha||run.head_repository?.full_name!==repository)throw Error('Preview needs successful same-repository PR validation at the supplied head.');
const prs=await api('commits/'+sha+'/pulls?per_page=100');
const pr=prs.find(pr=>pr.head.sha===sha&&pr.head.repo?.full_name===repository&&pr.user.login==='treisland'&&pr.base.ref==='main'&&pr.state==='open');
if(!pr)throw Error('Preview requires an open owner-authored PR at its verified head.');
const reviews=await api('pulls/'+pr.number+'/reviews?per_page=100');const latest=new Map();for(const review of reviews)if(['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(review.state))latest.set(review.user.login,review.state);
if([...latest.values()].includes('CHANGES_REQUESTED'))throw Error('A requested change blocks preview promotion.');
const checks=await api('commits/'+sha+'/check-runs?per_page=100');
for(const name of ['validate (ubuntu-latest)','validate (windows-latest)','container'])if(!checks.check_runs.some(c=>c.name===name&&c.app?.id===15368&&c.status==='completed'&&c.conclusion==='success'))throw Error('Missing required preview check: '+name);
const listing=await api('actions/runs/'+runId+'/artifacts?per_page=100');
const artifacts=listing.artifacts.filter(a=>a.name==='review-site'&&!a.expired);
if(artifacts.length!==1||!/^sha256:[a-f0-9]{64}$/.test(artifacts[0].digest||''))throw Error('Expected one complete digested review-site artifact.');
const asset=artifacts[0];if(asset.size_in_bytes>12000000)throw Error('Preview artifact exceeds limit.');
let downloadURL=asset.archive_download_url,downloadHeaders=headers;
if(process.env.PREVIEW_TRANSFER_COMMIT){
  const transferCommit=process.env.PREVIEW_TRANSFER_COMMIT;
  if(!/^[a-f0-9]{40}$/.test(transferCommit))throw Error('Expected immutable preview transfer commit.');
  // Source Actions artifacts need source access. A maintainer transfers the
  // exact ZIP through a reviewed deployment-repository commit using local gh
  // authentication. CI stays read-only and rechecks the original source digest.
  const betaRepository='treisland/presentation-studio-beta';
  const comparison=await api('compare/'+transferCommit+'...main',betaRepository);
  if(!['ahead','identical'].includes(comparison.status))throw Error('Transfer commit must be reviewed and merged into beta main.');
  downloadURL='https://raw.githubusercontent.com/'+betaRepository+'/'+transferCommit+'/review/review-site.zip';
  downloadHeaders={};
}
const response=await fetch(downloadURL,{headers:downloadHeaders,signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('Preview download returned '+response.status);
const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>12000000)throw Error('Preview exceeds limit.');chunks.push(chunk);}
const bytes=Buffer.concat(chunks);if('sha256:'+hash(bytes)!==asset.digest)throw Error('Preview ZIP digest mismatch.');
await mkdir('test-results',{recursive:true});await writeFile('test-results/review-site.zip',bytes);
console.log('Verified owner PR #'+pr.number+' at '+sha+'; extract only allowlisted static site files.');
