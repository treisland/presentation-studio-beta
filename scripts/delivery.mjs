import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const requiredChecks = ['validate (ubuntu-latest)', 'validate (windows-latest)'];
export function eligiblePR(pr) {
  const labels = pr.labels.map(label => label.name);
  return !pr.isDraft && !labels.includes('hold') && pr.reviewDecision !== 'CHANGES_REQUESTED' &&
    (pr.author.login === 'treisland' || labels.includes('auto-merge')) && !pr.autoMergeRequest;
}
export function protectedDelivery(settings, protection) {
  return !!(settings.allow_auto_merge && protection?.enforce_admins?.enabled && protection.required_status_checks?.strict &&
    protection.required_pull_request_reviews && protection.required_conversation_resolution?.enabled &&
    !protection.allow_force_pushes?.enabled && !protection.allow_deletions?.enabled &&
    requiredChecks.every(name => protection.required_status_checks.checks.some(check => check.context === name && check.app_id === 15368)));
}
export function validated(checks) {
  return requiredChecks.every(name => checks.some(check => check.name === name && check.status === 'COMPLETED' && check.conclusion === 'SUCCESS')) &&
    checks.every(check => check.status === 'COMPLETED' && ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion));
}
export function validPlan(plan, version) {
  if (!plan.publish) return false;
  if (plan.version !== version || !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?$/.test(version)) throw new Error('Invalid or mismatched release version');
  if (plan.notes !== `docs/releases/${version}.md`) throw new Error('Release notes must match version');
  if (!version.includes('-alpha') && (!plan.manualGatesPassed || !Array.isArray(plan.evidence) || plan.evidence.length < 1)) throw new Error('Beta/RC/stable require manual gate evidence');
  return true;
}
export function validAssets(assets, version) {
  const names = ['presentation-studio.html', 'presentation-studio-blank.html', `presentation-studio-v${version}.zip`, 'studio-demo-editable.zip'];
  return assets.length === names.length && names.every(name => assets.some(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0 && /^sha256:[a-f0-9]{64}$/.test(asset.digest || '')));
}

const repository = 'treisland/presentation-studio';
function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input: input && JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
export function createGitHubAPI(run = gh) {
  return (path, method = 'GET', body) => {
    const endpoint = `repos/${repository}` + (path ? `/${path}` : '');
    return JSON.parse(run(['api', endpoint, '--method', method, ...(body ? ['--input', '-'] : [])], body) || 'null');
  };
}
export function deliver(apply = false, { api = createGitHubAPI(), run = gh } = {}) {
  function optional(path) {
    try { return api(path); } catch (error) {
      if (String(error.stderr).includes('(HTTP 404)')) return null;
      throw error;
    }
  }
  function content(path, ref) {
    return Buffer.from(api(`contents/${path}?ref=${encodeURIComponent(ref)}`).content, 'base64').toString('utf8');
  }
  function list(path, key) {
    const values = [];
    for (let page = 1; ; page++) {
      const result = api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const items = key ? result[key] : result;
      values.push(...items);
      if (items.length < 100) return values;
    }
  }
  const changes = [];
  if (apply) {
    const settings = api('');
    const protection = optional('branches/main/protection');
    if (!protectedDelivery(settings, protection))
      throw new Error('Automatic delivery blocked: approved repository auto-merge and main protection configuration must be enabled first');
  }
  const prs = JSON.parse(run(['pr', 'list', '--repo', repository, '--base', 'main', '--state', 'open', '--limit', '100', '--json', 'number,isDraft,author,labels,headRefOid,isCrossRepository,reviewDecision,autoMergeRequest,mergeStateStatus']));
  for (const pr of prs) {
    if (!eligiblePR(pr)) continue;
    changes.push(`Queue PR #${pr.number} at ${pr.headRefOid}`);
    if (apply) run(['pr', 'merge', String(pr.number), '--repo', repository, '--auto', '--merge', '--match-head-commit', pr.headRefOid]);
  }
  const main = api('commits/main').sha;
  const version = JSON.parse(content('package.json', main)).version;
  const planFile = optional(`contents/release-plan.json?ref=${main}`);
  if (!planFile) return changes;
  const plan = JSON.parse(Buffer.from(planFile.content, 'base64').toString('utf8'));
  if (!validPlan(plan, version)) return changes;
  const tag = `v${version}`;
  const matches = list('releases').filter(release => release.tag_name === tag);
  if (matches.length > 1) throw new Error(`Multiple releases found for ${tag}; review before publication`);
  const release = matches.length ? api(`releases/${matches[0].id}`) : null;
  if (release && !release.draft) return changes;
  const ref = optional(`git/ref/tags/${tag}`);
  const tagged = ref ? (ref.object.type === 'tag' ? api(`git/tags/${ref.object.sha}`).object.sha : ref.object.sha) : main;
  if (ref) {
    if (tagged !== main && !['ahead', 'identical'].includes(api(`compare/${tagged}...${main}`).status)) throw new Error('Release tag is not an ancestor of main');
    const taggedPlan = JSON.parse(content('release-plan.json', tagged));
    const taggedVersion = JSON.parse(content('package.json', tagged)).version;
    if (!validPlan(taggedPlan, taggedVersion) || JSON.stringify(taggedPlan) !== JSON.stringify(plan)) throw new Error('Tagged release plan differs from current authorization');
  }
  const checkRuns = list(`commits/${tagged}/check-runs`, 'check_runs').map(check => ({ name: check.name, status: check.status.toUpperCase(), conclusion: (check.conclusion || '').toUpperCase() }));
  if (checkRuns.some(check => check.status === 'COMPLETED' && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion))) throw new Error(`Release commit ${tagged} validation failed; release remains blocked`);
  if (!validated(checkRuns)) return changes;
  const statuses = api(`commits/${tagged}/status`);
  if (statuses.total_count && statuses.state !== 'success') return changes;
  if (api('issues?state=open&labels=release-blocker&per_page=100').length) return changes;
  const notes = content(plan.notes, tagged);
  if (!notes.trim()) throw new Error('Empty release notes');
  if (!ref) {
    if (release) throw new Error('Draft exists without its release tag; review before tagging');
    changes.push(`Tag ${tag} on validated main ${main}`);
    if (apply) api('git/refs', 'POST', { ref: `refs/tags/${tag}`, sha: main });
    return changes;
  }
  const runs = list(`actions/workflows/release.yml/runs?head_sha=${tagged}`, 'workflow_runs').filter(run => run.head_sha === tagged && run.head_branch === tag && run.event === 'push').sort((left, right) => right.id - left.id);
  if (!runs.length || runs[0].status !== 'completed') return changes;
  if (runs[0].conclusion !== 'success') throw new Error('Release workflow failed; draft remains unpublished');
  if (!release) throw new Error('Release workflow succeeded but no matching draft release was found');
  if (!validAssets(release.assets, version)) throw new Error(`Draft release ${release.id} artifacts are incomplete or missing digests`);
  changes.push(`Publish ${tag} from ${tagged} with four verified assets`);
  if (apply) api(`releases/${release.id}`, 'PATCH', { name: `Presentation Studio ${tag}`, body: notes, draft: false, prerelease: version.includes('-'), make_latest: version.includes('-') ? 'false' : 'true' });
  return changes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const changes = deliver(process.argv.includes('--apply'));
    if (changes.length) console.log(changes.join('\n'));
  } catch (error) {
    console.error(error.message, error.stderr ? String(error.stderr) : '');
    process.exitCode = 1;
  }
}
