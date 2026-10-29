// GitHub Actions workflows, the active ones (.github/workflows) and the templates meant to be
// copied there (nodes/github/workflows): a workflow that untrusted text can start (an issue, a
// comment, a fork's pull request) gets no secret and no write access beyond issues, every
// workflow states its permissions, and an action from outside GitHub is pinned by commit SHA.
// The audit's repo-7: the community-bot template, turned on as written, would have handed an
// issue's hidden prompt ANTHROPIC_API_KEY and a write-scoped token. Reads files only.
//   node --test tests/workflows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['.github/workflows', 'nodes/github/workflows'];
const files = DIRS.flatMap((d) =>
  existsSync(join(ROOT, d))
    ? readdirSync(join(ROOT, d))
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => `${d}/${f}`)
    : [],
);
const text = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
/** Lines without their comments. */
const code = (f) =>
  text(f)
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n');

/** The events of the top-level `on:` (a scalar, a [list] or a mapping). */
function triggers(src) {
  const m = /^on:[ \t]*(.*)$/m.exec(src);
  if (!m) return [];
  const inline = m[1].trim();
  if (inline) return inline.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const body = src.slice(m.index + m[0].length).split('\n');
  const out = [];
  for (const l of body.slice(1)) {
    if (/^\S/.test(l)) break;
    const k = /^ {2}([a-z_]+):/.exec(l);
    if (k) out.push(k[1]);
  }
  return out;
}

// Events whose payload an outsider writes, or that run with the base repo's secrets for a fork.
const UNTRUSTED = new Set(['issues', 'issue_comment', 'pull_request_target', 'pull_request_review', 'pull_request_review_comment', 'discussion', 'discussion_comment', 'workflow_run', 'fork', 'watch']);
const WRITE_OK = new Set(['issues']);

test('the workflows and templates are all found', () => {
  assert.ok(files.includes('.github/workflows/ci.yml'));
  assert.ok(files.includes('.github/workflows/node-release.yml'));
});

test('a workflow that untrusted text can start gets no secret and no write access beyond issues', () => {
  const bad = [];
  for (const f of files) {
    const src = code(f);
    const on = triggers(src).filter((t) => UNTRUSTED.has(t));
    if (on.length === 0) continue;
    for (const s of src.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) if (s[1] !== 'GITHUB_TOKEN') bad.push(`${f} (${on}): secrets.${s[1]}`);
    for (const p of src.matchAll(/^\s+([a-z-]+):\s*write\b/gm)) if (!WRITE_OK.has(p[1])) bad.push(`${f} (${on}): ${p[1]}: write`);
    if (/permissions:\s*write-all/.test(src)) bad.push(`${f} (${on}): write-all`);
  }
  assert.deepEqual(bad, []);
});

test('every workflow states its permissions', () => {
  const missing = files.filter((f) => !/^\s*permissions:/m.test(code(f)));
  assert.deepEqual(missing, []);
});

test('an action from outside GitHub is pinned by commit SHA', () => {
  const loose = [];
  for (const f of files)
    for (const m of code(f).matchAll(/uses:\s*([^\s@]+)@(\S+)/g)) {
      const [, action, ref] = m;
      if (action.startsWith('./') || /^(actions|github)\//.test(action)) continue;
      if (!/^[0-9a-f]{40}$/.test(ref)) loose.push(`${f}: ${action}@${ref}`);
    }
  assert.deepEqual(loose, []);
});
