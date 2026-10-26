// System Back (src/ui/backGuard.ts, node --test tests/back-guard.test.mjs): one sentinel history
// entry turns Android's back gesture / button, a TV remote's BACK, the browser's back, Alt + ← and a
// mouse's back button into one step inside the game (never out of the site), re-armed after every
// step so the history never grows; the GoBack / BrowserBack keys are one step even when the browser
// also walks the history for them; released while "Leave Turbogol?" is up, so the next Back leaves.
// A fake window: a session history (entries of this page or of the page before), async traversals
// like a browser's (flush), timers run by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { BackGuard, BACK_KEY_MS, isBackKey } = await import('../src/ui/backGuard.ts');

class FakeWindow {
  /** `before`: a page before the game in this tab (Back from the game's first entry goes there). */
  constructor({ before = true, state = null } = {}) {
    this.listeners = new Map();
    this.entries = before ? [{ doc: 'before', state: null }] : [];
    this.entries.push({ doc: 'game', state, url: 'https://turbo-gol.com/#diag' });
    this.index = this.entries.length - 1;
    this.left = false;
    this.pending = [];
    this.timers = new Map();
    this.nextTimer = 1;
    this.pushes = [];
    const win = this;
    this.history = {
      get state() {
        return win.entries[win.index].state;
      },
      get length() {
        return win.entries.length;
      },
      pushState(data, unused, url) {
        win.pushes.push({ data, unused, url });
        win.entries.splice(win.index + 1);
        // No URL: the entry keeps the current one (the hash flags stay).
        win.entries.push({ doc: 'game', state: structuredClone(data), url: url ?? win.entries[win.index].url });
        win.index++;
      },
      back() {
        win.pending.push(-1);
      },
    };
  }
  // Listeners run synchronously and their exceptions reach the caller (a test can assert them).
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(e) {
    for (const fn of [...(this.listeners.get(e.type) ?? [])]) fn(e);
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
  runTimers() {
    const all = [...this.timers.values()];
    this.timers.clear();
    for (const t of all) t.fn();
  }
  /** The system Back (gesture, button, browser UI): a traversal, async like a browser's. */
  userBack() {
    this.history.back();
    this.flush();
  }
  userForward() {
    this.pending.push(1);
    this.flush();
  }
  /** Run the queued traversals: within the page a popstate, to the page before the page is gone. */
  flush() {
    while (this.pending.length > 0 && !this.left) {
      const d = this.pending.shift();
      const to = this.index + d;
      if (to < 0 || to >= this.entries.length) continue; // out of range: nothing (browsers too)
      if (this.entries[to].doc !== 'game') {
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
    this.dispatchEvent(e);
  }
  key(key, code = '') {
    const e = new Event('keydown', { cancelable: true });
    e.key = key;
    e.code = code;
    this.dispatchEvent(e);
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
  win.key('GoBack');
  win.runTimers();
  assert.equal(steps.length, 1, 'released: a back key does nothing (the dialog is up)');
  win.userBack();
  assert.equal(win.left, true);
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
});
