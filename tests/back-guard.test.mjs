// System Back (src/ui/backGuard.ts, node --test tests/back-guard.test.mjs): a close watcher (Android's
// Back where the browser has CloseWatcher) and one sentinel history entry (the browser's back, Alt + ←,
// a mouse's back button) turn each Back into one step inside the game (never out of the site), re-armed
// after every step so the history never grows; the GoBack / BrowserBack keys are one step even when the
// browser also walks the history for them; released while "Leave Turbogol?" is up, so the next Back leaves.
// A fake window: a session history (entries of this page or of the page before), async traversals like a
// browser's (flush), timers run by hand; `skips` models Chromium / WebKit's history manipulation
// intervention (a Back from the browser's UI skips the entry under a pushState made without a user
// activation, until the next activation), `watchers` a CloseWatcher (a close request closes the newest
// one; an Escape keydown nobody cancelled is one too, inside its dispatch, as in Chromium).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { BackGuard, BACK_KEY_MS, isBackKey } = await import('../src/ui/backGuard.ts');

/** Keydowns that are no user activation (the HTML spec: Esc; the guard treats a lone modifier the same). */
const NO_ACTIVATION = new Set(['Escape', 'Shift', 'Control', 'Alt', 'Meta']);

class FakeWindow {
  /** `before`: a page before the game in this tab (Back from the game's first entry goes there). */
  constructor({ before = true, state = null, skips = false, watchers = false } = {}) {
    this.listeners = new Map();
    this.entries = before ? [{ doc: 'before', state: null }] : [];
    this.entries.push({ doc: 'game', state, url: 'https://turbo-gol.com/#diag', skip: false });
    this.index = this.entries.length - 1;
    this.left = false;
    this.closed = false;
    this.pending = [];
    this.timers = new Map();
    this.nextTimer = 1;
    this.pushes = [];
    this.scriptBacks = 0;
    this.skips = skips;
    this.activating = false;
    const win = this;
    this.history = {
      get state() {
        return win.entries[win.index].state;
      },
      get length() {
        return win.entries.length;
      },
      pushState(data, unused, url) {
        win.pushes.push({ data, unused, url, activation: win.activating });
        // The intervention: the entry left behind by a push without an activation is skipped by the UI's Back.
        if (win.skips && !win.activating) win.entries[win.index].skip = true;
        win.entries.splice(win.index + 1);
        // No URL: the entry keeps the current one (the hash flags stay).
        win.entries.push({ doc: 'game', state: structuredClone(data), url: url ?? win.entries[win.index].url, skip: false });
        win.index++;
      },
      back() {
        win.scriptBacks++;
        win.pending.push({ d: -1, ui: false });
      },
    };
    this.watchers = [];
    if (watchers) {
      this.CloseWatcher = class {
        constructor() {
          this.listeners = [];
          this.alive = true;
          win.watchers.push(this);
        }
        addEventListener(type, fn) {
          if (type === 'close') this.listeners.push(fn);
        }
        destroy() {
          this.alive = false;
        }
      };
    }
  }
  close() {
    this.closed = true;
  }
  // Listeners run synchronously and their exceptions reach the caller (a test can assert them).
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  listening(type) {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }
  dispatchEvent(e, activation = false) {
    if (activation) {
      // A user activation clears the intervention's marks; a push inside the event has one.
      for (const en of this.entries) en.skip = false;
      this.activating = true;
    }
    try {
      for (const fn of [...(this.listeners.get(e.type) ?? [])]) fn(e);
    } finally {
      this.activating = false;
    }
    return !e.defaultPrevented;
  }
  setTimeout(fn, ms) {
    const id = this.nextTimer++;
    this.timers.set(id, { fn, ms });
    return id;
  }
  clearTimeout(id) {
    this.timers.delete(id);
  }
  /** Run every due timer, and the ones those set, until none is left. */
  runTimers() {
    for (let i = 0; i < 20 && this.timers.size > 0; i++) {
      const all = [...this.timers.values()];
      this.timers.clear();
      for (const t of all) t.fn();
    }
  }
  /** The live close watcher a close request would close (the newest one alive), or null. */
  get watcher() {
    for (let i = this.watchers.length - 1; i >= 0; i--) if (this.watchers[i].alive) return this.watchers[i];
    return null;
  }
  /** A close request: the newest live watcher closes (close event, then gone); false when there is none. */
  closeRequest() {
    const w = this.watcher;
    if (w === null) return false;
    w.alive = false;
    for (const fn of w.listeners) fn();
    return true;
  }
  /** Android's Back (gesture, button): a close request where a watcher is up, else the UI's Back. */
  systemBack() {
    if (!this.closeRequest()) this.userBack();
    this.runTimers();
  }
  /** The browser's Back (toolbar, gesture, a lone mouse back button): a traversal, async like a browser's. */
  userBack() {
    this.pending.push({ d: -1, ui: true });
    this.flush();
  }
  userForward() {
    this.pending.push({ d: 1, ui: true });
    this.flush();
  }
  /** Run the queued traversals: within the page a popstate, to the page before the page is gone. */
  flush() {
    while (this.pending.length > 0 && !this.left) {
      const { d, ui } = this.pending.shift();
      let to = this.index + d;
      if (ui && this.skips && d < 0) while (to > 0 && this.entries[to].skip) to--;
      if (to < 0 || to >= this.entries.length) continue; // out of range: nothing (browsers too)
      if (this.entries[to].doc !== 'game') {
        this.dispatchEvent(new Event('beforeunload'));
        this.dispatchEvent(new Event('pagehide'));
        this.left = true;
        this.index = to;
        return;
      }
      this.index = to;
      const e = new Event('popstate');
      e.state = this.entries[to].state;
      this.dispatchEvent(e);
    }
  }
  pointer(type, pointerType) {
    const e = new Event(type);
    e.pointerType = pointerType;
    this.dispatchEvent(e, (pointerType === 'mouse') === (type === 'pointerdown'));
  }
  /** A keydown; an Escape nobody cancelled is a close request inside it (Chromium). */
  key(key, code = '', { repeat = false } = {}) {
    const e = new Event('keydown', { cancelable: true });
    e.key = key;
    e.code = code;
    e.repeat = repeat;
    this.dispatchEvent(e, !NO_ACTIVATION.has(key) && !isBackKey(e));
    if (key === 'Escape' && !e.defaultPrevented) this.closeRequest();
    return e;
  }
  get url() {
    return this.entries[this.index].url;
  }
}

function setup(opts) {
  const win = new FakeWindow(opts);
  const steps = [];
  let onStep = () => undefined;
  const guard = new BackGuard(win, () => {
    steps.push(win.index);
    onStep();
  });
  guard.start();
  return { win, guard, steps, setOnStep: (fn) => (onStep = fn) };
}

test('the sentinel waits for a user activation (Chrome skips one pushed without), then sits on top with the same URL', () => {
  const { win, guard } = setup();
  assert.equal(win.entries.length, 2, 'nothing pushed at start');
  assert.equal(guard.active, false);
  win.pointer('pointerdown', 'touch'); // a finger going down carries no activation
  assert.equal(win.entries.length, 2);
  win.pointer('pointerup', 'mouse');
  assert.equal(win.entries.length, 2);
  win.pointer('pointerup', 'touch');
  assert.equal(win.entries.length, 3);
  assert.equal(guard.active, true);
  assert.equal(win.pushes[0].url, undefined, 'pushState without a URL');
  assert.equal(win.url, 'https://turbo-gol.com/#diag', 'the hash flags stay');
  win.pointer('pointerdown', 'mouse');
  win.key('a', 'KeyA');
  guard.arm();
  assert.equal(win.entries.length, 3, 'one sentinel, however many activations');
  // A controller press (no activation) arms a guard nothing armed yet.
  const pad = setup();
  pad.guard.arm();
  assert.equal(pad.win.entries.length, 3);
  assert.equal(pad.guard.active, true);
});

test('each Back is one step inside the game and the sentinel comes back: the history never grows', () => {
  const { win, steps } = setup();
  win.key('Enter', 'Enter');
  for (let i = 1; i <= 5; i++) {
    win.userBack();
    assert.equal(steps.length, i);
    assert.equal(win.left, false, 'still on the page');
    assert.equal(win.entries.length, 3);
    assert.equal(win.index, 2, 'on a sentinel again');
    assert.equal(win.url, 'https://turbo-gol.com/#diag');
  }
});

test('a reload on the sentinel arms without pushing; a Back onto an older sentinel is a step, a Forward onto one is not', () => {
  const win = new FakeWindow({ state: { turbogolBack: 4 } });
  const steps = [];
  const guard = new BackGuard(win, () => steps.push(1));
  guard.start();
  assert.equal(guard.active, true);
  win.key('Enter', 'Enter');
  assert.equal(win.entries.length, 2, 'the entry already is one');
  // A duplicate from an older page load sits under a newer sentinel.
  win.history.pushState({ turbogolBack: 9 }, '');
  const g2 = new BackGuard(win, () => steps.push(2));
  guard.dispose();
  g2.start();
  win.userBack(); // 9 -> 4: back onto an older sentinel
  assert.deepEqual(steps, [2]);
  assert.equal(win.entries.length, 3, 'nothing pushed: already on a sentinel');
  win.userForward(); // 4 -> 9
  assert.deepEqual(steps, [2], 'forward is no step');
  g2.dispose();
});

test('home screen: release makes the next Back leave the page; resume (the dialog closed) arms it again', () => {
  const { win, guard, steps, setOnStep } = setup();
  win.key('Enter', 'Enter');
  setOnStep(() => guard.release()); // the Game's confirmLeave on the home screen
  win.userBack();
  assert.equal(steps.length, 1);
  assert.equal(win.index, 1, 'released: no sentinel on top');
  assert.equal(guard.active, false);
  win.key('ArrowDown', 'ArrowDown'); // moving the focus in the dialog does not re-arm
  win.pointer('pointerdown', 'mouse');
  assert.equal(win.index, 1);
  // The dialog closes (KEEP PLAYING, Esc / B): Back stays in the game again.
  setOnStep(() => undefined);
  guard.resume();
  assert.equal(guard.active, true);
  assert.equal(win.entries.length, 3);
  win.userBack();
  assert.equal(steps.length, 2);
  assert.equal(win.left, false);
  // Released again: this time the player presses Back once more and leaves.
  setOnStep(() => guard.release());
  win.userBack();
  assert.equal(steps.length, 3);
  win.userBack();
  assert.equal(win.left, true, 'the second Back leaves for the page before');
  assert.equal(steps.length, 3, 'no step for it');
});

test('LEAVE goes to the page before; canLeave says whether there is one', () => {
  const a = setup();
  a.win.key('Enter', 'Enter');
  a.setOnStep(() => a.guard.release());
  a.win.userBack();
  assert.equal(a.guard.canLeave, true);
  a.guard.leave();
  a.win.flush();
  assert.equal(a.win.left, true);

  const b = setup({ before: false });
  b.win.key('Enter', 'Enter');
  b.setOnStep(() => b.guard.release());
  b.win.userBack();
  assert.equal(b.guard.canLeave, false, 'the game is the first page of the tab: no LEAVE button');
});

test('back keys (GoBack / BrowserBack / XF86Back): one step after BACK_KEY_MS, or at the popstate when the browser walks the history too', () => {
  assert.ok(isBackKey({ key: 'GoBack' }));
  assert.ok(isBackKey({ key: 'BrowserBack' }));
  assert.ok(isBackKey({ key: 'XF86Back' }));
  assert.ok(isBackKey({ key: 'Unidentified', code: 'BrowserBack' }));
  assert.ok(!isBackKey({ key: 'Escape', code: 'Escape' }));
  assert.ok(!isBackKey({ key: 'Backspace', code: 'Backspace' }));
  assert.ok(BACK_KEY_MS >= 200 && BACK_KEY_MS <= 500, 'short enough to feel immediate');

  const { win, steps } = setup();
  win.key('Enter', 'Enter');
  // A key the browser does not act on: the guard steps by itself.
  const e = win.key('GoBack');
  assert.equal(e.defaultPrevented, true);
  assert.equal(steps.length, 0, 'waits for a possible popstate');
  win.runTimers();
  assert.equal(steps.length, 1);
  assert.equal(win.entries.length, 3, 'still armed, nothing pushed');
  // A key the browser also walks the history for: one step, not two.
  win.key('BrowserBack', 'BrowserBack');
  win.userBack();
  win.runTimers();
  assert.equal(steps.length, 2);
  assert.equal(win.index, 2, 're-armed');
  // Held keys repeat: one step per press.
  const r = new Event('keydown', { cancelable: true });
  r.key = 'GoBack';
  r.repeat = true;
  win.dispatchEvent(r);
  win.runTimers();
  assert.equal(steps.length, 2);
});

test('a back key on the home screen takes its sentinel off itself: the next Back leaves', () => {
  const { win, guard, steps, setOnStep } = setup();
  win.key('Enter', 'Enter');
  setOnStep(() => guard.release());
  win.key('GoBack');
  win.runTimers();
  assert.equal(steps.length, 1);
  win.flush(); // the guard's own history.back(): no step for it
  assert.equal(steps.length, 1);
  assert.equal(win.index, 1);
  // Released ("Press Back again to leave"): the key is not cancelled, so a browser that walks the
  // history for it leaves at once; a key-only remote leaves after BACK_KEY_MS.
  const e = win.key('GoBack');
  assert.equal(e.defaultPrevented, false, 'the browser keeps its own Back');
  assert.equal(steps.length, 1);
  win.runTimers();
  win.flush();
  assert.equal(steps.length, 1, 'no step: the page goes');
  assert.equal(win.left, true, 'a key that walked no history leaves after BACK_KEY_MS');
});

test('released: a back key the browser walks the history for leaves once (its unload cancels the timer)', () => {
  const { win, guard, setOnStep } = setup();
  win.key('Enter', 'Enter');
  setOnStep(() => guard.release());
  win.userBack(); // the leave dialog
  const backs = win.scriptBacks;
  win.key('BrowserBack', 'BrowserBack');
  assert.equal(win.listening('beforeunload'), true, 'watching for the page going meanwhile');
  win.userBack(); // the browser's own Back for the key: beforeunload, pagehide, gone
  assert.equal(win.left, true);
  assert.equal(win.timers.size, 0, 'the timer is gone with the page');
  assert.equal(win.scriptBacks, backs, 'no second Back of ours');
  assert.equal(win.listening('beforeunload'), false);
});

test('released, the game the first page of the tab (a TV launcher, a PWA): a key-only remote BACK closes the window where a script may', () => {
  const { win, guard, setOnStep } = setup({ before: false });
  win.key('Enter', 'Enter');
  setOnStep(() => guard.release());
  win.key('XF86Back');
  win.runTimers();
  win.flush();
  assert.equal(guard.canLeave, false);
  win.key('XF86Back');
  win.runTimers();
  assert.equal(win.closed, true);
});

test('Esc and a lone modifier are no user activation: no sentinel for them', () => {
  const { win } = setup();
  win.key('Escape', 'Escape');
  win.key('Shift', 'ShiftLeft');
  win.runTimers();
  assert.equal(win.entries.length, 2);
  win.key('x', 'KeyX');
  assert.equal(win.entries.length, 3);
  assert.equal(win.pushes[0].activation, true);
});

test("CloseWatcher: Android's Back with no user activation at all is a step every time, the history untouched", () => {
  const { win, guard, steps } = setup({ watchers: true, skips: true });
  assert.equal(guard.active, true, 'a watcher from the start, before any click');
  for (let i = 1; i <= 6; i++) {
    win.systemBack();
    assert.equal(steps.length, i);
    assert.equal(win.left, false);
    assert.notEqual(win.watcher, null, 'a new watcher after each close');
  }
  assert.equal(win.pushes.length, 0, 'no history entry needed');
  assert.equal(win.watchers.filter((w) => w.alive).length, 1, 'one at a time');
});

test('CloseWatcher: a controller-only player in a match and two screens deep in the menus never leaves; on home the dialog, then Back leaves', () => {
  // The pad press arms a sentinel without an activation (the intervention marks the game's entry).
  const pad = setup({ watchers: true, skips: true });
  pad.guard.arm();
  for (let i = 0; i < 3; i++) pad.win.systemBack();
  assert.equal(pad.steps.length, 3);
  assert.equal(pad.win.left, false);
  // Menus: two screens back, then home asks (release), then the next Back leaves.
  const m = setup({ watchers: true, skips: true });
  m.win.pointer('pointerup', 'touch');
  m.setOnStep(() => {
    if (m.steps.length === 3) m.guard.release();
  });
  m.win.systemBack();
  m.win.systemBack();
  m.win.systemBack();
  assert.equal(m.steps.length, 3);
  assert.equal(m.win.watcher, null, 'released: no watcher');
  m.win.flush(); // the guard's own history.back() off the sentinel
  assert.equal(m.win.left, false);
  m.win.systemBack();
  assert.equal(m.win.left, true, 'Back again leaves');
  assert.equal(m.steps.length, 3);
});

test("CloseWatcher: the dialog closed (resume) watches again; Esc's own close request is no second step", () => {
  const { win, guard, steps, setOnStep } = setup({ watchers: true });
  setOnStep(() => guard.release());
  win.systemBack();
  setOnStep(() => undefined);
  guard.resume();
  assert.notEqual(win.watcher, null);
  win.systemBack();
  assert.equal(steps.length, 2);
  // An Esc nobody cancelled closes the watcher inside its keydown: the Game's Esc already acted.
  win.key('Escape', 'Escape');
  win.runTimers();
  assert.equal(steps.length, 2, 'no step for Esc');
  assert.notEqual(win.watcher, null, 'watching again');
  win.systemBack();
  assert.equal(steps.length, 3, 'the next Back is a step again');
  // A close request together with a back keydown (a browser that sends both) is one step.
  win.key('GoBack');
  win.closeRequest();
  win.runTimers();
  assert.equal(steps.length, 4);
});

test('no CloseWatcher, Chromium / WebKit (the intervention): a second history Back with no click or key between leaves; one between keeps it in', () => {
  // What Game.updateLeaveGuard's beforeunload is for in a match.
  const a = setup({ skips: true });
  a.win.pointer('pointerdown', 'mouse');
  assert.equal(a.win.pushes[0].activation, true);
  a.win.userBack();
  assert.equal(a.steps.length, 1);
  assert.equal(a.win.left, false);
  a.win.userBack();
  assert.equal(a.win.left, true, 'the re-armed sentinel had no activation: skipped');
  const b = setup({ skips: true });
  b.win.pointer('pointerdown', 'mouse');
  b.win.userBack();
  b.win.key('x', 'KeyX'); // any key or tap clears the mark
  b.win.userBack();
  assert.equal(b.steps.length, 2);
  assert.equal(b.win.left, false);
  // Firefox (no such skip): the sentinel pushed again inside the popstate holds at once.
  const c = setup();
  c.win.pointer('pointerdown', 'mouse');
  c.win.userBack();
  c.win.userBack();
  assert.equal(c.steps.length, 2);
  assert.equal(c.win.left, false);
});

test('a step that throws still re-arms; dispose removes every listener', () => {
  const win = new FakeWindow();
  let n = 0;
  const guard = new BackGuard(win, () => {
    n++;
    throw new Error('boom');
  });
  guard.start();
  win.key('Enter', 'Enter');
  assert.throws(() => win.userBack(), /boom/);
  assert.equal(n, 1);
  assert.equal(win.index, 2, 're-armed anyway');
  guard.dispose();
  for (const set of win.listeners.values()) assert.equal(set.size, 0);
  win.userBack();
  assert.equal(n, 1, 'no listener after dispose');
  // With a close watcher: a throwing step still watches again; dispose takes the watcher down.
  const w = new FakeWindow({ watchers: true });
  const g = new BackGuard(w, () => {
    throw new Error('boom');
  });
  g.start();
  assert.throws(() => w.closeRequest(), /boom/);
  w.runTimers();
  assert.notEqual(w.watcher, null);
  g.dispose();
  assert.equal(w.watcher, null);
  assert.equal(w.timers.size, 0);
});
