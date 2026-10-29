// GARAJE's fixes after #55 went live (src/ui/screens/garage.ts, src/ui/Menu.ts): how the screen is
// wired, read from its source as tests/stadium-picker.test.mjs does (the screen builds DOM at once).
//   node --test tests/garage-live.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const MENU = read('src/ui/Menu.ts');
const GARAGE = read('src/ui/screens/garage.ts');

/** The body of the method or arrow `name` opens in `src` (from its head to the brace that closes it). */
function body(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, 'found: ' + head);
  const open = src.indexOf('{', at + head.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error('unclosed: ' + head);
}

test("Menu tells a screen's show whether it is a new visit: the open that forgot its focus memory, nothing else", () => {
  const open = body(MENU, '  open(id: string, reset = false, tab?: string, detour = false): void {');
  assert.match(open, /if \(this\.top\(\)\?\.id !== id\) \{\s*this\.memory\.forget\('last:' \+ id\);\s*this\.memory\.forget\('stage:' \+ id\);\s*this\.anewId = id;\s*\}/, 'the same condition as the memory it forgets');
  const mount = body(MENU, '  private mount(focus: SwitchFocus = \'auto\'): void {');
  assert.match(mount, /const anew = this\.anewId === top\.id;\s*this\.anewId = null;/, 'read once, at the mount that follows');
  assert.match(mount, /top\.show\?\.\(anew\);/);
  assert.match(MENU, /if \(this\.visibleNow\) \{\s*this\.top\(\)\?\.show\?\.\(false\);/, "the config's re-show is no new visit");
  assert.doesNotMatch(MENU, /\.show\?\.\(\);/, 'every show says which it is');
  for (const m of ['private popTo(i: number): void {', '  back(): boolean {', "  private selectSection(id: SectionId, how: 'focus' | 'click' | 'command'): void {"]) {
    assert.doesNotMatch(body(MENU, m), /anewId/, `${m.trim()} brings a screen back, never anew`);
  }
});

test("Menu.backTo: a screen under the top comes back as its crumb would (popTo), else it opens", () => {
  const backTo = body(MENU, '  backTo(id: string): void {');
  assert.match(backTo, /const i = this\.stack\.findIndex\(\(s\) => s\.id === id\);\s*if \(i >= 0 && i < this\.stack\.length - 1\) this\.popTo\(i\);\s*else this\.open\(id\);/);
});

test('GARAJE: a new visit starts on the car driven; Back, a crumb or the sign-in come back to the car and the tab left', () => {
  const show = body(GARAGE, '    show: (anew) => {');
  assert.match(show, /if \(anew\) \{\s*tab = 'cars';\s*selected = null;\s*stadium = host\.theme;\s*\}/, 'only a new visit resets the pick');
  assert.equal((show.match(/selected = null/g) ?? []).length, 1);
  assert.match(show, /schedulePreview\(true\);/, 'a return shows the car picked in the showroom again');
  assert.doesNotMatch(body(GARAGE, '    hide: () => {'), /tab = /, 'hide keeps the tab for a return');
  // The sign-in on PERFIL (its detour on GARAJE) returns as Back does: the memory of CANJEAR kept.
  assert.match(GARAGE, /if \(menu\.top\(\)\?\.id === 'profile'\) menu\.backTo\('garage'\);/);
  assert.doesNotMatch(GARAGE, /menu\.open\('garage'\)/);
  // With nothing remembered (SIGN IN went with the sign-in), the first focus is the row picked.
  assert.match(GARAGE, /el\.toggleAttribute\('data-autofocus', c\.selected\)/);
  assert.match(GARAGE, /row\.el\.toggleAttribute\('data-autofocus', id === stadium\)/);
});
