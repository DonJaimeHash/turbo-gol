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

const CSS = read('src/ui/styles/screens/garage.css');

test('a phone held sideways: the row picked stays in view, the action names its car', () => {
  const render = body(GARAGE, '  function render(): void {');
  // Once per pick, after the detail took its new height; the list alone scrolls (revealDelta).
  assert.match(render, /if \(shown && pickedRow !== undefined && pickedRow\.el !== revealed\) \{\s*revealed = pickedRow\.el;\s*reveal\(pickedRow\.el\);\s*\}/);
  assert.ok(render.indexOf('reveal(pickedRow.el)') > render.indexOf('drawCars(v)'), 'after the detail is drawn');
  const reveal = body(GARAGE, '  const reveal = (row: HTMLElement): void => {');
  assert.match(reveal, /list\.scrollTop \+= d/);
  assert.doesNotMatch(reveal, /scrollIntoView/, 'the page never moves');
  // The action: its car's name and its label, the name shown only on the rail (its head is hidden there).
  assert.match(GARAGE, /h\('button\.mn-btn\.mn-gar-act', \{[^}]*\}, detActFor, detActText\)/);
  assert.match(GARAGE, /detActFor\.textContent = carName\(s\.id\);/);
  assert.match(GARAGE, /detActFor\.textContent = themeName\(stadium\);/);
  assert.match(CSS, /\.mn-gar-act-for \{\s*display: none;\s*\}/);
  assert.match(CSS, /html\[data-shell='rail'\] \.mn-gar-act-for \{\s*display: block;/);
  assert.match(CSS, /html\[data-shell='rail'\] \.mn-gar-det-head,\s*html\[data-layout='portrait'\] \.mn-gar-det-head \{\s*display: none;/, 'the head the name stands in for');
});

test('GANA PUNTOS with a controller: the sheet offers no button that cannot open (QR and CERRAR, as on a TV)', () => {
  // Menu knows the click running is a controller's A (data-input says so only after this frame).
  assert.match(body(MENU, '  get padPress(): boolean {'), /return this\.padAccept;/);
  assert.match(MENU, /this\.padAccept = true;\s*try \{\s*this\.nav\.accept\(\);\s*\} finally \{\s*this\.padAccept = false;\s*\}/);
  assert.match(GARAGE, /const noPopup = \(\): boolean => tv\(\) \|\| menu\.padPress \|\| html\.dataset\.input === 'pad' \|\| html\.dataset\.input === 'remote';/);
  const guide = body(GARAGE, '  const openGuide = (): void => {');
  assert.match(guide, /actions: noPopup\(\)\s*\? \[\{ label: t\('outcome\.close'\), primary: true, onClick: \(\) => true \}\]/, 'a pad or a TV: CERRAR alone');
  assert.match(guide, /if \(menu\.padPress\) return false;\s*window\.open\(url, '_blank', 'noopener'\);/, 'a mouse, a key or a finger: the README in a new tab, noopener');
  const earn = body(GARAGE, '  const earnClick = (e: MouseEvent): void => {');
  assert.match(earn, /if \(!noPopup\(\)\) return;\s*e\.preventDefault\(\);\s*openGuide\(\);/, "the card's link opens itself for a mouse or a key");
  assert.match(GARAGE, /h\(\s*'a\.mn-gar-earn',\s*\{ href: guideUrl\(\), target: '_blank', rel: 'noopener'/);
});

test("a TV's CH± from a scrolled list: the other tab's rows start at the top, their pick in view", () => {
  const render = body(GARAGE, '  function render(): void {');
  // Both tabs' rows share one scroller (setChildren swaps them): its scroll is reset with the swap...
  assert.match(render, /if \(list\.firstElementChild !== want\[0\]\.el\) \{\s*setChildren\(list, \.\.\.want\.map\(\(r\) => r\.el\)\);[\s\S]*?list\.scrollTop = 0;\s*revealed = null;\s*\}/);
  // ...then the row picked (refocused without a scroll) is brought into view below it.
  const swap = render.indexOf('list.scrollTop = 0');
  assert.ok(swap < render.indexOf('pickedRow?.el.focus({ preventScroll: true })') && swap < render.indexOf('reveal(pickedRow.el)'));
});
