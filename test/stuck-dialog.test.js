'use strict';

// The watch that dismisses Douyin's wedged "是否保存登录信息？" prompt.
//
// Two things about it are worth pinning down, and neither is visible by reading the code:
//
//  * it must not stop working. A watch that silently never fires leaves the user with a dead
//    page and nothing anywhere explaining why - which is exactly what happened when this was a
//    `setInterval`: a preload timer does not survive the window being occluded (measured on a
//    2 s interval, it ticked three times in 30 s and then stopped for good);
//  * it must not cost anything while the dialog is absent, which is every ordinary session.
//
// The frame clock is therefore driven by hand here, so "how often does it look" is an
// assertion rather than a hope.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIVE_INTERVAL_MS,
  IDLE_INTERVAL_MS,
  installStuckDialogWatch,
} = require('../app/recovery/stuck-dialog');

/** A frame clock that runs only when the test says so. */
function frameClock() {
  let next = 1;
  const queue = new Map();
  return {
    requestAnimationFrame(fn) {
      const id = next;
      next += 1;
      queue.set(id, fn);
      return id;
    },
    cancelAnimationFrame(id) { queue.delete(id); },
    /** Run everything currently queued, at `at` milliseconds, and report how many ran. */
    pump(at) {
      const due = [...queue.values()];
      queue.clear();
      for (const fn of due) fn(at);
      return due.length;
    },
    pending: () => queue.size,
  };
}

function watchFixture({ dialog = null } = {}) {
  const clock = frameClock();
  let current = dialog;
  let lookups = 0;
  return {
    clock,
    lookups: () => lookups,
    setDialog: (next) => { current = next; },
    doc: {
      getElementById: () => { lookups += 1; return current; },
      defaultView: {
        requestAnimationFrame: clock.requestAnimationFrame,
        cancelAnimationFrame: clock.cancelAnimationFrame,
      },
    },
  };
}

/**
 * The dialog as it looks when it is wedged.
 *
 * `disabled` is enough to reach the verdict without `window.getComputedStyle`, which is the
 * last signal `isButtonStuck` checks - so this fixture needs no DOM at all.
 */
function stuckDialog() {
  const button = {
    disabled: true,
    getAttribute: () => null,
    classList: { contains: () => false },
    querySelector: () => null,
  };
  return { id: 'trust-logout-dialog', querySelectorAll: () => [button] };
}

// ---------------------------------------------------------------------------

test('the first frame looks immediately, whatever the clock reads', () => {
  // A fresh document reports a `performance.now()` of a few milliseconds, so an implementation
  // that compared against 0 would skip the first look and delay the watch after every
  // navigation - which is when it matters most.
  const fixture = watchFixture();
  installStuckDialogWatch({ doc: fixture.doc, recover: () => ({ recovered: false }) });

  fixture.clock.pump(3);
  assert.equal(fixture.lookups(), 1);
});

test('a stuck dialog is dismissed once it has stayed stuck past the grace period', () => {
  const fixture = watchFixture({ dialog: stuckDialog() });
  const calls = [];
  const recovered = [];
  const detach = installStuckDialogWatch({
    doc: fixture.doc,
    idleMs: 500,
    pollMs: 100,
    graceMs: 400,
    recover: () => { calls.push(1); return { recovered: true, via: 'defaultHandler' }; },
    onRecovered: (info) => recovered.push(info),
  });

  fixture.clock.pump(1000);
  assert.equal(calls.length, 0, 'the grace period has to elapse first');

  fixture.clock.pump(1100);
  assert.equal(calls.length, 0, '100 ms of stuck is not a wedge yet');

  fixture.clock.pump(1500);
  assert.equal(calls.length, 1);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].via, 'defaultHandler');
  assert.equal(recovered[0].stuckMs, 500);

  detach();
});

test('a dialog that un-wedges itself is never touched', () => {
  // The state has to survive the grace period, so a re-render that clears the loading state is
  // not mistaken for a wedge. Douyin's own countdown path closes the dialog by itself.
  const fixture = watchFixture({ dialog: stuckDialog() });
  const calls = [];
  const detach = installStuckDialogWatch({
    doc: fixture.doc,
    pollMs: 100,
    graceMs: 400,
    recover: () => { calls.push(1); return { recovered: true, via: 'removed' }; },
  });

  fixture.clock.pump(1000);
  fixture.clock.pump(1100);
  fixture.setDialog(null);
  fixture.clock.pump(1200);
  fixture.clock.pump(5000);

  assert.equal(calls.length, 0);
  detach();
});

test('it looks far more often while the dialog is on screen', () => {
  // This is the whole point of the change: the idle interval is what an ordinary session pays,
  // and it must be the slow one. The active interval governs how quickly a wedge is caught.
  const steps = [1000, 1100, 1200, 1300, 1400, 1500, 1600];

  const idle = watchFixture();
  installStuckDialogWatch({
    doc: idle.doc, idleMs: IDLE_INTERVAL_MS, pollMs: ACTIVE_INTERVAL_MS, recover: () => ({ recovered: false }),
  });
  for (const at of steps) idle.clock.pump(at);

  const busy = watchFixture({ dialog: stuckDialog() });
  installStuckDialogWatch({
    doc: busy.doc,
    idleMs: IDLE_INTERVAL_MS,
    pollMs: ACTIVE_INTERVAL_MS,
    // Large enough that no recovery happens and the lookups are all we are measuring.
    graceMs: 1e9,
    recover: () => ({ recovered: false }),
  });
  for (const at of steps) busy.clock.pump(at);

  assert.equal(idle.lookups(), 2, 'once at the start, once 500 ms later');
  assert.ok(
    busy.lookups() >= 6,
    `an on-screen dialog should be checked every ~100 ms, not ${busy.lookups()} times in 600 ms`,
  );
});

test('detaching stops the frame loop', () => {
  const fixture = watchFixture({ dialog: stuckDialog() });
  const detach = installStuckDialogWatch({
    doc: fixture.doc, recover: () => ({ recovered: false }),
  });

  fixture.clock.pump(1000);
  assert.equal(fixture.clock.pending(), 1, 'still watching');

  detach();
  assert.equal(fixture.clock.pending(), 0, 'and now it is not');
});

test('without a frame clock it falls back to a timer instead of going silent', (t) => {
  // A watch that never runs is the most expensive failure this file can have, so the frame
  // clock is a preference, not a requirement.
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let lookups = 0;
  const detach = installStuckDialogWatch({
    doc: { getElementById: () => { lookups += 1; return null; }, defaultView: {} },
    idleMs: 500,
    recover: () => ({ recovered: false }),
  });

  assert.equal(lookups, 0, 'nothing has run yet');
  t.mock.timers.tick(500);
  assert.equal(lookups, 1, 'the timer path still looks');

  detach();
  t.mock.timers.tick(5000);
  assert.equal(lookups, 1, 'and stops when detached');
});
