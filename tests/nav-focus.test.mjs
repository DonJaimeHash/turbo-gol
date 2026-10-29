// The shared focus code's moves (src/ui/nav.ts FocusNav) on a small fake DOM: a list's lines, a row
// that is a line, a zone's floor, a target's own way (onNavTo), a side claim that takes nothing and
// a scrolled list's hidden rows.
// The geometry is measured from the screens it stands for (Ajustes on a TV, CLASIFICACIÓN on a PC).
//   node --test tests/nav-focus.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
});

const NAV = await import('../src/ui/nav.ts');

const R = (left, top, width = 100, height = 40) => ({ left, top, width, height, right: left + width, bottom: top + height });

/** An element as FocusNav reads it: attributes, children, a box (its children's by default), the focus, a scroll. */
class FakeEl {
  constructor(attrs = {}, rect = null, children = []) {
    this.attrs = { ...attrs };
    this.rect = rect;
    this.children = [];
    this.parent = null;
    /** overflow-y: auto with this much to scroll (a scroller), else null. */
    this.scroll = null;
    this.classes = new Set();
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c) };
    this.isContentEditable = false;
    for (const c of children) this.append(c);
  }
  append(c) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  hasAttribute(n) {
    return n in this.attrs;
  }
  getAttribute(n) {
    return n in this.attrs ? String(this.attrs[n]) : null;
  }
  /** `[attr]` selectors, comma-separated: all FocusNav asks. */
  matches(sel) {
    return sel.split(',').some((s) => {
      const m = /^\[([\w-]+)\]$/.exec(s.trim());
      return m !== null && this.hasAttribute(m[1]);
    });
  }
  closest(sel) {
    for (let e = this; e; e = e.parent) if (e.matches(sel)) return e;
    return null;
  }
  *walk() {
    for (const c of this.children) {
      yield c;
      yield* c.walk();
    }
  }
  querySelectorAll(sel) {
    return [...this.walk()].filter((e) => e.matches(sel));
  }
  contains(x) {
    for (let e = x; e; e = e.parent) if (e === this) return true;
    return false;
  }
  getBoundingClientRect() {
    return this.rect ?? NAV.unionBox(this.children.map((c) => c.getBoundingClientRect()));
  }
  get offsetWidth() {
    return this.getBoundingClientRect().width;
  }
  get parentElement() {
    return this.parent;
  }
  get clientHeight() {
    return this.getBoundingClientRect().height;
  }
  get clientWidth() {
    return this.getBoundingClientRect().width;
  }
  get scrollHeight() {
    return this.scroll ?? this.clientHeight;
  }
  get scrollWidth() {
    return this.clientWidth;
  }
  get isConnected() {
    return true;
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  scrollIntoView() {}
}

function fakeDom() {
  globalThis.HTMLElement = FakeEl;
  globalThis.HTMLInputElement = class {};
  globalThis.HTMLTextAreaElement = class {};
  globalThis.document = { activeElement: null };
  globalThis.window = { setTimeout: () => 0, clearTimeout: () => undefined };
  globalThis.getComputedStyle = (e) => ({ transform: 'none', translate: 'none', overflowX: 'visible', overflowY: e.scroll !== null ? 'auto' : 'visible' });
}
const el = (attrs, rect, ...children) => new FakeEl(attrs, rect, children);
const NAVI = { 'data-nav': '' };
const LINE = { 'data-nav-line': '' };
const bounced = (e) => [...e.classes].some((c) => c.startsWith('mn-bounce-'));
const focused = () => globalThis.document.activeElement;

test('rowLeaveBox: a short row or a row that is a line is left whole; a stacked row from its member', () => {
  const card = R(300, 100, 270, 160);
  const wrapped = R(300, 100, 560, 340); // three cards, two and one (a TV's GRÁFICOS)
  assert.deepEqual(NAV.rowLeaveBox(R(0, 0, 400, 40), R(0, 0, 100, 40), false), R(0, 0, 400, 40), 'one line');
  assert.equal(NAV.rowLeaveBox(wrapped, card, false), card, 'stacked: its member');
  assert.equal(NAV.rowLeaveBox(wrapped, card, true), wrapped, 'a line however it wraps');
});

/**
 * Ajustes at a TV's width: the rail (a side zone) beside the page (the main zone, `floor`), the
 * footer under it. The page's lines: a slider (the aerial sensitivity), Movimiento reducido (a seg
 * row), the frame limit (a seg row), Súper bajo (a switch that takes A only) under it, a button.
 */
function ajustes(floor) {
  fakeDom();
  const tab0 = el({ ...NAVI, 'data-nav-entry': '' }, R(20, 100, 200, 56));
  const tab1 = el(NAVI, R(20, 160, 200, 56));
  const rail = el({}, R(0, 80, 240, 400), tab0, tab1);
  const slider = el(NAVI, R(560, 106, 240, 44));
  const motion = [0, 1, 2].map((i) => el(NAVI, R(760 + i * 70, 176, 60, 44)));
  const cap = [0, 1].map((i) => el(NAVI, R(880 + i * 70, 240, 60, 44)));
  const superlow = el(NAVI, R(850, 306, 142, 48));
  NAV.onNavSide(superlow, () => false, () => false);
  const btn = el(NAVI, R(320, 380, 160, 44));
  const page = el(
    {},
    R(300, 80, 700, 400),
    el(LINE, R(300, 100, 700, 56), slider),
    el(LINE, R(300, 170, 700, 56), el({ 'data-nav-row': '' }, null, ...motion)),
    el(LINE, R(300, 234, 700, 56), el({ 'data-nav-row': '' }, null, ...cap)),
    el(LINE, R(300, 300, 700, 60), superlow),
    el(LINE, R(300, 374, 700, 56), btn),
  );
  const source = el(NAVI, R(800, 500, 150, 40));
  const footer = el({}, R(0, 490, 1000, 60), source);
  const f = new NAV.FocusNav(() => [
    { name: 'set-rail', el: rail, side: true },
    { name: 'stage', el: page, main: true, floor },
    { name: 'bottom', el: footer },
  ]);
  return { f, tab0, slider, motion, cap, superlow, btn, source };
}

test('a line: ◀ past a seg on it goes to the side rail, never to a control of another line', () => {
  const { f, tab0, motion, slider } = ajustes(true);
  f.focus(motion[1]);
  assert.equal(f.move('left'), true);
  assert.equal(focused(), motion[0], 'the seg first');
  assert.equal(f.move('left'), true);
  assert.equal(focused(), tab0, "then the rail (its entry), not the aerial slider on the line above");
  assert.notEqual(focused(), slider);
});

test('a line: ▶ past its last control bounces; a switch that takes A only bounces both ways', () => {
  const { f, superlow, btn, cap } = ajustes(true);
  f.focus(btn);
  assert.equal(f.move('right'), false, 'nothing on its line that way');
  assert.equal(focused(), btn);
  assert.ok(bounced(btn));
  f.focus(superlow);
  assert.equal(f.move('right'), false, 'Súper bajo: not the frame limit above it');
  assert.equal(focused(), superlow);
  assert.ok(bounced(superlow));
  assert.equal(f.move('left'), false);
  assert.equal(focused(), superlow);
  assert.notEqual(focused(), cap[1]);
});

test("a floor: ▼ past the page's last line stays on it; without one it goes on to the footer", () => {
  const a = ajustes(true);
  a.f.focus(a.btn);
  assert.equal(a.f.move('down'), false);
  assert.equal(focused(), a.btn, 'Ajustes: the bounce');
  const b = ajustes(false);
  b.f.focus(b.btn);
  assert.equal(b.f.move('down'), true);
  assert.equal(focused(), b.source, 'another screen: the footer');
});

test("a row that is a line (GRÁFICOS' cards, wrapped two and one): ▼ ▲ leave it whole, ◀ ▶ walk it", () => {
  fakeDom();
  const c = [R(300, 100, 270, 160), R(590, 100, 270, 160), R(300, 280, 270, 160)].map((r) => el(NAVI, r));
  const scale = el(NAVI, R(560, 470, 240, 44));
  const page = el({}, R(300, 80, 700, 480), el({ 'data-nav-row': '', ...LINE }, R(300, 100, 560, 340), ...c), el(LINE, R(300, 464, 700, 56), scale));
  const f = new NAV.FocusNav(() => [{ name: 'stage', el: page, main: true }]);
  f.focus(c[0]);
  f.move('down');
  assert.equal(focused(), scale, 'Rendimiento ▼: the line below the cards, not Ultra under it');
  f.focus(scale);
  f.move('up');
  assert.ok(c.includes(focused()), 'Escala ▲: into the cards, not past them');
  f.focus(c[0]);
  f.move('right');
  assert.equal(focused(), c[1]);
  f.move('right');
  assert.equal(focused(), c[2], 'the wrapped one is next in the row');
  assert.equal(f.move('right'), false, 'the end');
});

test("onNavTo: the pinned row's ▲ goes to the list's last row, wherever the list is scrolled", () => {
  fakeDom();
  // The list scrolled to its top: its first rows right above the pinned row, the last one far up out of sight.
  const rows = [R(100, 440, 1150, 56), R(100, 500, 1150, 56), R(100, -2000, 1150, 56)].map((r) => el({ ...NAVI, ...LINE }, r));
  const pinned = el({ ...NAVI, ...LINE }, R(100, 600, 1150, 56));
  const page = el({}, R(0, 0, 1366, 768), el({}, null, ...rows), pinned);
  const f = new NAV.FocusNav(() => [{ name: 'stage', el: page, main: true }]);
  f.focus(pinned);
  f.move('up');
  assert.equal(focused(), rows[1], 'the spatial pick alone: the nearest row');
  NAV.onNavTo(pinned, 'up', () => rows[2]);
  f.focus(pinned);
  f.move('up');
  assert.equal(focused(), rows[2], "its own way: the list's last row");
  f.move('down');
  assert.equal(focused(), pinned, 'and ▼ back the same way');
});

test('CLASIFICACIÓN: ◀ on a 1v1 row (a line, no playlist before it) bounces instead of jumping to the tab', () => {
  fakeDom();
  const tab = el(NAVI, R(107, 165, 291, 72));
  const row = el({ ...NAVI, ...LINE }, R(107, 473, 1152, 56));
  let stepped = 0;
  NAV.onNavSide(row, null, () => void stepped++);
  const page = el({}, R(0, 0, 1366, 768), tab, row);
  const f = new NAV.FocusNav(() => [{ name: 'stage', el: page, main: true }]);
  f.focus(row);
  assert.equal(f.move('left'), false);
  assert.equal(focused(), row, 'its place in the list stays');
  assert.ok(bounced(row));
  assert.equal(f.move('right'), true);
  assert.equal(stepped, 1, '▶ still steps the playlist');
});

test('a scrolled list: ▼ from the pinned row under it goes to the footer, not up into its hidden rows', () => {
  fakeDom();
  // CLASIFICACIÓN on a PC, the list scrolled to its top: rows 0-4 in sight, the rest clipped below its fold
  // (geometrically under the pinned row and the footer).
  const rows = Array.from({ length: 12 }, (_, i) => el({ ...NAVI, ...LINE }, R(107, 301 + 60 * i, 1152, 56)));
  const list = el({}, R(107, 300, 1152, 322), ...rows);
  list.scroll = 6000;
  const pinned = el({ ...NAVI, ...LINE }, R(107, 634, 1152, 56));
  const tab = el(NAVI, R(410, 173, 291, 72));
  const stage = el({}, R(0, 60, 1366, 650), tab, list, pinned);
  const source = el(NAVI, R(1094, 728, 151, 40));
  const footer = el({}, R(0, 718, 1366, 50), source);
  const f = new NAV.FocusNav(() => [
    { name: 'stage', el: stage, main: true },
    { name: 'bottom', el: footer },
  ]);
  f.focus(pinned);
  assert.equal(f.move('down'), true);
  assert.equal(focused(), source, 'the footer, not row 6');
  f.focus(rows[4]);
  f.move('down');
  assert.equal(focused(), rows[5], 'inside the list: on into the row below its fold');
  f.focus(tab);
  f.move('down');
  assert.equal(focused(), rows[0], 'from above: its first row in sight');
  assert.equal(NAV.clippedOut(R(107, 661, 1152, 56), R(107, 300, 1152, 322)), true);
  assert.equal(NAV.clippedOut(R(107, 601, 1152, 56), R(107, 300, 1152, 322)), false, 'cut by the fold, still in sight');
});
