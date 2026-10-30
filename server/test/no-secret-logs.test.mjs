// The log test of the sign-in design (§1.5, guard 2; sign-in PR 4): the client keys are global
// (one salt for everyone), so a log line holding one, or a request body that carries one, would
// serve a dictionary for every account. No console call in server/src takes a request body or a
// password field, the sign-in files log nothing of a body they read (a provider's answer
// included), and no mail template interpolates a password field. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/** Every console.<level>(...) call of a source text with its arguments (strings and template literals skipped whole). */
function consoleCalls(src) {
  const out = [];
  const re = /console\.(?:log|warn|error|info|debug)\(/g;
  for (let m; (m = re.exec(src)); ) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        const q = ch;
        let tmpl = 0;
        for (i++; i < src.length; i++) {
          if (src[i] === '\\') i++;
          else if (q === '`' && src[i] === '$' && src[i + 1] === '{') (tmpl++, i++);
          else if (q === '`' && tmpl > 0 && src[i] === '}') tmpl--;
          else if (src[i] === q && tmpl === 0) break;
        }
      } else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

/** A request body, or a field that holds a client key (or the record made from one), by its name. */
const FIELD = /\b(?:password|passwordV2|legacy|current|oldPassword|oldPasswordV2|newPassword|clientKey|rekey|proof|pw|readJson|body|request)\b|\bb\.[A-Za-z]/;
/** The files that handle sign-ins and mail: they log nothing of any body they read (a request's, a provider's). */
const SIGN_IN = new Set(['accountRoutes.ts', 'AccountsDO.ts', 'accountStore.ts', 'auth.ts', 'tvCodes.ts', 'mail.ts', 'mailTemplates.ts']);

test('the log test: no console call in server/src takes a request body or a password field, and the sign-in files log nothing of a body they read', () => {
  const dir = new URL('../src/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 20);
  const bad = [];
  let n = 0;
  for (const f of files) {
    for (const call of consoleCalls(readFileSync(new URL(f, dir), 'utf8'))) {
      n++;
      const args = call.replace(/^console\.\w+\(/, '');
      // Code only: the words of a message ("password check: ...") are text, not a field; what a template interpolates is code.
      const code = args.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');
      const interpolated = [...args.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(' ');
      if (FIELD.test(code) || FIELD.test(interpolated)) bad.push(`${f}: ${call}`);
      else if (SIGN_IN.has(f) && /\.(?:text|json|arrayBuffer|formData)\(/.test(args)) bad.push(`${f} (a body it read): ${call}`);
    }
  }
  assert.ok(n > 30, `the scan found the calls (${n})`);
  assert.deepEqual(bad, []);
  const tmpl = readFileSync(new URL('mailTemplates.ts', dir), 'utf8');
  for (const [, expr] of tmpl.matchAll(/\$\{([^}]*)\}/g)) assert.equal(/\b(?:password|passwordV2|legacy|oldPassword|newPassword|clientKey)\b/.test(expr), false, expr);
});

test('the log test catches what it is for (its own scan, on samples)', () => {
  const flagged = (src, file = 'accountRoutes.ts') =>
    consoleCalls(src).some((call) => {
      const args = call.replace(/^console\.\w+\(/, '');
      const code = args.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');
      const interpolated = [...args.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(' ');
      return FIELD.test(code) || FIELD.test(interpolated) || (SIGN_IN.has(file) && /\.(?:text|json|arrayBuffer|formData)\(/.test(args));
    });
  assert.equal(flagged('console.log(b.password)'), true);
  assert.equal(flagged('console.warn(`login ${b.username} ${JSON.stringify(body)}`)'), true);
  assert.equal(flagged('console.warn(`oauth ${provider}: token ${tr.status} ${(await tr.text()).slice(0, 200)}`)'), true, "a provider's answer");
  assert.equal(flagged('console.error("bad", passwordV2)'), true);
  assert.equal(flagged("console.error('password check: no pepper here')"), false, 'a word of a message is not a field');
  assert.equal(flagged('console.warn(`oauth ${provider}: token ${tr.status}`)'), false);
});
