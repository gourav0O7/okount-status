// Checks every service in services.json once and updates data/.
//
//   data/status.json     what the status page and the app's outage banner read
//   data/history.json    per service, per day: checks made and checks that were up
//   data/incidents.json  outages, newest first
//
// An outage opens a GitHub issue in this repo (so the owner gets an email) and
// the issue is closed when the service is back. Without GITHUB_TOKEN (a local
// run) it only writes the files.
//
// One round per call. The every-5-minutes loop lives in
// .github/workflows/checks.yml ("Keep checking"); status.yml rebuilds the page.
//
// Node 20+, no dependencies.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';


const TIMEOUT_MS = 10000;
const SLOW_MS = 3000;
/** Two failed checks in a row before calling it an outage: one dropped request is not news. */
const FAILS_FOR_OUTAGE = 2;
const KEEP_DAYS = 90;

async function once() {
  const cfg = JSON.parse(readFileSync('services.json', 'utf8'));
  const read = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
  const prev = read('data/status.json', { services: [] });
  const history = read('data/history.json', {});
  const incidents = read('data/incidents.json', []);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);

  async function check(s) {
    if (s.planned || !s.url) return { state: 'planned', code: null, ms: null, note: s.planned || 'Not set up yet' };
    const t0 = Date.now();
    try {
      const res = await fetch(s.url, {
        method: s.method || 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'okount-status (+https://github.com/gourav0O7/okount-status)', origin: 'https://okount-status.github.io' },
      });
      const ms = Date.now() - t0;
      // 404 on a server task means it is not deployed; 5xx means it is broken.
      const up = res.status < 500 && res.status !== 404;
      return { state: up ? (ms > SLOW_MS ? 'slow' : 'up') : 'down', code: res.status, ms, note: up ? null : `Answered ${res.status}` };
    } catch (e) {
      return { state: 'down', code: null, ms: Date.now() - t0, note: e?.name === 'TimeoutError' ? `No answer in ${TIMEOUT_MS / 1000}s` : 'Could not connect' };
    }
  }

  const gh = async (path, method = 'GET', body) => {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    if (!token || !repo) return null;
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.ok ? res.json() : null;
  };

  const results = await Promise.all(cfg.services.map(async (s) => ({ s, r: await check(s) })));
  const services = [];

  for (const { s, r } of results) {
    const before = prev.services.find((p) => p.id === s.id);
    const fails = r.state === 'down' ? (before?.fails ?? 0) + 1 : 0;
    // Shown as down only once it has failed twice; a first failure shows as "checking".
    const shown = r.state === 'down' && fails < FAILS_FOR_OUTAGE ? (before?.shown === 'down' ? 'down' : 'up') : r.state;

    if (r.state !== 'planned') {
      const h = (history[s.id] ??= {});
      const d = (h[day] ??= { checks: 0, up: 0, ms: 0 });
      d.checks++;
      if (r.state !== 'down') { d.up++; d.ms += r.ms ?? 0; }
      for (const k of Object.keys(h).sort().slice(0, -KEEP_DAYS)) delete h[k];
    }

    let open = incidents.find((i) => i.service === s.id && !i.resolvedAt);
    if (shown === 'down' && !open) {
      open = { id: `${s.id}-${now.getTime()}`, service: s.id, name: s.name, startedAt: now.toISOString(), resolvedAt: null, cause: r.note, issue: null };
      incidents.unshift(open);
      const issue = await gh('/issues', 'POST', {
        title: `${s.name} is down`,
        body: `${s.name} stopped answering at ${now.toUTCString()}.\n\n- URL: ${s.url}\n- What happened: ${r.note}\n\nThis issue closes by itself when it is back.`,
        labels: ['outage'],
      });
      if (issue) open.issue = issue.number;
    } else if (shown !== 'down' && open && r.state !== 'planned') {
      open.resolvedAt = now.toISOString();
      if (open.issue) {
        await gh(`/issues/${open.issue}/comments`, 'POST', { body: `Back up at ${now.toUTCString()}.` });
        await gh(`/issues/${open.issue}`, 'PATCH', { state: 'closed' });
      }
    }

    services.push({ id: s.id, name: s.name, group: s.group, state: r.state, shown, fails, code: r.code, ms: r.ms, note: r.note });
  }

  const live = services.filter((s) => s.shown !== 'planned');
  const overall = live.some((s) => s.shown === 'down') ? (live.every((s) => s.shown === 'down') ? 'major' : 'partial')
    : live.some((s) => s.shown === 'slow') ? 'degraded' : 'operational';

  writeFileSync('data/status.json', JSON.stringify({ checkedAt: now.toISOString(), overall, title: cfg.title, note: cfg.note, services }, null, 2) + '\n');
  writeFileSync('data/history.json', JSON.stringify(history) + '\n');
  writeFileSync('data/incidents.json', JSON.stringify(incidents.slice(0, 200), null, 2) + '\n');
  console.log(overall, services.map((s) => `${s.id}:${s.shown}${s.code ? `(${s.code}, ${s.ms}ms)` : ''}`).join(' '));
}

await once();
