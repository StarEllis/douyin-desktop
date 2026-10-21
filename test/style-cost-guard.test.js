'use strict';

// The shell-side guard that stops the bundled userscript's stylesheet from making every
// style recalculation expensive.
//
// The stakes here are asymmetric, which is why this is tested rather than eyeballed:
//
//  * too timid and the whole point is lost - the injected rules keep carrying branches for a
//    page the user is not on, and `:has()` makes every recalculation pay for them;
//  * too eager and the guard removes a branch that *can* match, which silently changes how the
//    page looks - a video info panel that stops moving, a control bar that never appears.
//
// So the selectors used below are the real ones from the bundle. If upstream changes their
// shape, the tests that read the bundle fail rather than quietly covering nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  COSTLY,
  NEVER_MATCHES,
  installStyleCostGuard,
  isSegmentReachable,
  leftmostCompound,
  restoreReachable,
  splitTopLevel,
  structuralSkeleton,
  sweepStyleCost,
} = require('../app/preload/style-cost-guard');

const BUNDLE = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'douyin-optimization.user.js'),
  'utf8',
);

/** The gate that makes the live-room branches unreachable on the recommend feed. */
const LIVE_GATE = '[data-e2e="feed-live"]';

// ---------------------------------------------------------------------------
// Splitting a selector list
// ---------------------------------------------------------------------------

test('a selector list splits on its top-level commas', () => {
  assert.deepEqual(splitTopLevel('a, b, c'), ['a', 'b', 'c']);
  assert.deepEqual(splitTopLevel('#video-info-wrap,\n.positionBox'), ['#video-info-wrap', '.positionBox']);
});

test('commas inside :has() or an attribute value stay inside their branch', () => {
  // Both shapes occur in this stylesheet, and a plain split(',') would tear them apart -
  // producing branches that are not valid selectors, which then get judged as unreachable.
  assert.deepEqual(
    splitTopLevel('div:has(a, b), .other'),
    ['div:has(a, b)', '.other'],
  );
  assert.deepEqual(
    splitTopLevel('[href*="a,b"], .other'),
    ['[href*="a,b"]', '.other'],
  );
  // The real thing: a pseudo-class whose argument list is a selector list.
  assert.deepEqual(
    splitTopLevel('[data-e2e="feed-live"] div:has(+a[data-e2e="live-slider"]):has(img), .keep'),
    ['[data-e2e="feed-live"] div:has(+a[data-e2e="live-slider"]):has(img)', '.keep'],
  );
});

test('degenerate input produces no branches instead of throwing', () => {
  assert.deepEqual(splitTopLevel(''), []);
  assert.deepEqual(splitTopLevel('   '), []);
  assert.deepEqual(splitTopLevel(',,,'), []);
});

// ---------------------------------------------------------------------------
// Finding the part the engine must match first
// ---------------------------------------------------------------------------

test('the leftmost compound stops at the first top-level combinator', () => {
  assert.equal(leftmostCompound('[data-e2e="feed-live"] .douyin-player > div:has(a[href])'), LIVE_GATE);
  assert.equal(leftmostCompound('#sliderVideo[data-e2e="feed-active-video"] div:has(> div)'), '#sliderVideo[data-e2e="feed-active-video"]');
  assert.equal(leftmostCompound('div:has(> #video-info-wrap)'), 'div:has(> #video-info-wrap)');
  assert.equal(leftmostCompound('.positionBox'), '.positionBox');
});

test('combinators inside brackets or parentheses are not separators', () => {
  // `[href*="a+b"]` and `:nth-child(2n+1)` both contain a combinator character that means
  // nothing at the top level; splitting on it would invent a gate that does not exist.
  assert.equal(leftmostCompound('[href*="a+b"]'), '[href*="a+b"]');
  assert.equal(leftmostCompound('li:nth-child(2n+1)'), 'li:nth-child(2n+1)');
  assert.equal(leftmostCompound('[data-e2e="feed-live"]>div'), LIVE_GATE);
});

// ---------------------------------------------------------------------------
// Deciding reachability
// ---------------------------------------------------------------------------

test('the skeleton is what has to match: pseudo-classes are stripped', () => {
  // Pseudo-classes only ever narrow a match, so the part that must exist is what is left once
  // they are removed - and that is the part worth querying.
  assert.equal(structuralSkeleton(`${LIVE_GATE}:hover`), LIVE_GATE);
  assert.equal(structuralSkeleton('div:has(> x)'), 'div');
  assert.equal(structuralSkeleton('a:hover::before'), 'a');
  assert.equal(structuralSkeleton('li:nth-child(2n+1)'), 'li');
  // A colon inside an attribute value is part of the value, not a pseudo-class.
  assert.equal(structuralSkeleton('[href*="https:"]'), '[href*="https:"]');
  // Nothing but a pseudo-class leaves no skeleton, which the caller reads as "undecidable".
  assert.equal(structuralSkeleton(':hover'), '');
  assert.equal(structuralSkeleton('::before'), '');
});

test('a branch is dropped only when the thing that has to match is missing', () => {
  const withGate = { querySelectorAll: (selector) => (selector === LIVE_GATE ? [{}] : []) };
  const withoutGate = { querySelectorAll: () => [] };
  const branch = `${LIVE_GATE}:hover .douyin-player > div:has(a[href])`;

  assert.equal(isSegmentReachable(branch, withGate), true);
  // `[data-e2e="feed-live"]:hover` matches nothing in a document that has no live feed - not
  // because of the `:hover`, but because the element it hangs off is not there.
  assert.equal(isSegmentReachable(branch, withoutGate), false);
});

test('an undecidable branch is kept even when its skeleton does not match', () => {
  // `div:has(...)` alone: `div` is everywhere, so the branch may well match - and stripping
  // `:has()` would say "reachable" for the wrong reason. Keeping it is the honest answer.
  const doc = { querySelectorAll: (selector) => (selector === 'div' ? [{}] : []) };
  assert.equal(isSegmentReachable('div:has(> #video-info-wrap)', doc), true);
  assert.equal(isSegmentReachable(':hover', doc), true);
  // `*` matches every element, and asking costs a full traversal - so it is not asked.
  assert.equal(isSegmentReachable('*:hover', doc), true);
});

test('a selector the engine refuses to parse is kept, not guessed at', () => {
  const doc = { querySelectorAll: () => { throw new Error('SyntaxError'); } };
  assert.equal(isSegmentReachable('[data-e2e="feed-live"] > div', doc), true);
});

// ---------------------------------------------------------------------------
// The sweep, against the real rule shape
// ---------------------------------------------------------------------------

/**
 * A stand-in for a CSSStyleSheet.
 *
 * `selectorText` is a writable property on the real object and that is exactly what the guard
 * relies on, so the stand-in has to be writable too - otherwise the test would pass against a
 * design that cannot work.
 */
function fakeSheet(rules) {
  const list = rules.map((r) => ({ selectorText: r.selectorText }));
  return {
    get cssRules() { return list; },
    deleteRule(index) { list.splice(index, 1); },
    selectors: () => list.map((r) => r.selectorText),
  };
}

/**
 * A stand-in for the document.
 *
 * `present` lists the selectors that match something right now; everything else matches nothing.
 */
function fakeDoc({ sheets, present = [] }) {
  return {
    styleSheets: sheets,
    querySelectorAll: (selector) => (present.includes(selector) ? [{}] : []),
  };
}

/**
 * The real rule from the bundle (`blockBottomVideoToolBar`), which is the whole reason this
 * guard is per-branch: it moves the video info panel *and* carries two live-room-only
 * branches. Dropping the rule would lose the first; keeping it whole pays for the other two
 * on every recalculation.
 */
const MIXED_RULE = [
  '#sliderVideo[data-e2e="feed-active-video"] div:has( > div > #video-info-wrap)',
  'div:has(> #video-info-wrap)',
  '.positionBox',
  `${LIVE_GATE} .douyin-player > div:has([aria-label*="直播中"])`,
  `${LIVE_GATE} .douyin-player > div:has(svg path[d="M13.556 17.778z"])`,
].join(', ');

test('a rule with unreachable branches keeps the rest and drops only those', () => {
  const sheet = fakeSheet([{ selectorText: MIXED_RULE }]);
  const doc = fakeDoc({
    sheets: [sheet],
    // Note the second entry: `div:has(> #video-info-wrap)` is queried as `div`, because the
    // `:has()` narrows the match and cannot widen it.
    present: ['#sliderVideo[data-e2e="feed-active-video"]', 'div', '.positionBox'],
  });
  const changed = new Map();
  const logged = [];

  const removed = sweepStyleCost({ doc, log: (message, data) => logged.push({ message, data }), changed });

  assert.equal(removed, 2, 'the two live-room branches');
  const [kept] = sheet.selectors();
  assert.ok(kept.includes('.positionBox'), 'the branches that do match are still there');
  assert.ok(kept.includes('div:has(> #video-info-wrap)'), 'including the undecidable one');
  assert.ok(!kept.includes(LIVE_GATE), 'and the unreachable ones are gone');
  assert.equal(logged.length, 1);
  assert.equal(changed.size, 1, 'the original text is remembered, so it can be put back');
  assert.equal(changed.values().next().value.original, MIXED_RULE);
});

test('a rule whose every branch is unreachable is neutralised, not deleted', () => {
  // `blockHighlight` is exactly this: both branches are live-room only. Deleting the rule
  // would shift every later rule up, and a stylesheet's order is part of its meaning.
  const sheet = fakeSheet([{ selectorText: `${LIVE_GATE} div:has(+a):has(img), ${LIVE_GATE} .highlightPlayer` }]);
  const doc = fakeDoc({ sheets: [sheet] });

  const removed = sweepStyleCost({ doc, log: () => {}, changed: new Map() });

  assert.equal(removed, 2);
  assert.deepEqual(sheet.selectors(), [NEVER_MATCHES], 'still in its slot, matching nothing');
});

test('a rule that matches something is left completely alone', () => {
  const sheet = fakeSheet([{ selectorText: `${LIVE_GATE} .douyin-player > div:has(a[href])` }]);
  const doc = fakeDoc({ sheets: [sheet], present: [LIVE_GATE] });
  const changed = new Map();

  assert.equal(sweepStyleCost({ doc, log: () => {}, changed }), 0);
  assert.deepEqual(sheet.selectors(), [`${LIVE_GATE} .douyin-player > div:has(a[href])`]);
  assert.equal(changed.size, 0);
});

test('a rule without :has() is never touched, however unreachable it looks', () => {
  // The guard exists for `:has()` - everything else recalculates on the fast path, so there is
  // nothing to win and a lot to lose by rewriting the site's ordinary rules.
  const sheet = fakeSheet([{ selectorText: '#sliderVideo[data-e2e="feed-active-video"] div, .positionBox' }]);
  const doc = fakeDoc({ sheets: [sheet] });

  assert.equal(sweepStyleCost({ doc, log: () => {}, changed: new Map() }), 0);
  assert.deepEqual(sheet.selectors(), ['#sliderVideo[data-e2e="feed-active-video"] div, .positionBox']);
});

test('sweeping twice does not lose the original text', () => {
  // The script re-injects its styles on every URL change, so the sweep runs repeatedly. A
  // second sweep must update the record, not overwrite the original with the rewritten text -
  // otherwise the restore below would put back a selector that is still missing its branches.
  const sheet = fakeSheet([{ selectorText: MIXED_RULE }]);
  const doc = fakeDoc({ sheets: [sheet], present: ['.positionBox'] });
  const changed = new Map();

  sweepStyleCost({ doc, log: () => {}, changed });
  const afterFirst = sheet.selectors()[0];
  sweepStyleCost({ doc, log: () => {}, changed });

  assert.equal(changed.size, 1, 'one record for one rule');
  assert.equal(changed.values().next().value.original, MIXED_RULE);
  assert.equal(sheet.selectors()[0], afterFirst, 'and the second sweep changes nothing');
});

test('a stylesheet that refuses to be read is skipped, not fatal', () => {
  const hostile = {
    get cssRules() { throw new Error('SecurityError'); },
    deleteRule() { throw new Error('should not be reached'); },
  };
  const ok = fakeSheet([{ selectorText: `${LIVE_GATE} .douyin-player > div:has(a[href])` }]);
  const doc = fakeDoc({ sheets: [hostile, ok] });

  assert.equal(sweepStyleCost({ doc, log: () => {}, changed: new Map() }), 1);
  assert.deepEqual(ok.selectors(), [NEVER_MATCHES]);
});

// ---------------------------------------------------------------------------
// Putting it back
// ---------------------------------------------------------------------------

test('the branches come back the moment the gate appears', () => {
  // A single-page navigation into a live room makes `[data-e2e="feed-live"]` appear without a
  // new document, so a rewrite that was never undone would disable the live-room styling for
  // the rest of the session.
  const sheet = fakeSheet([{ selectorText: MIXED_RULE }]);
  const present = ['#sliderVideo[data-e2e="feed-active-video"]', 'div', '.positionBox'];
  const doc = { styleSheets: [sheet], querySelectorAll: (selector) => (present.includes(selector) ? [{}] : []) };
  const changed = new Map();

  sweepStyleCost({ doc, log: () => {}, changed });
  assert.ok(!sheet.selectors()[0].includes(LIVE_GATE));

  present.push(LIVE_GATE);
  const restored = restoreReachable({ doc, log: () => {}, changed });

  assert.equal(restored, 1);
  assert.deepEqual(sheet.selectors(), [MIXED_RULE], 'byte for byte the original');
  assert.equal(changed.size, 0, 'and nothing left to check');
});

test('nothing is restored while the gate is still missing', () => {
  const sheet = fakeSheet([{ selectorText: `${LIVE_GATE} .douyin-player > div:has(a[href])` }]);
  const doc = fakeDoc({ sheets: [sheet] });
  const changed = new Map();

  sweepStyleCost({ doc, log: () => {}, changed });
  assert.equal(restoreReachable({ doc, log: () => {}, changed }), 0);
  assert.deepEqual(sheet.selectors(), [NEVER_MATCHES]);
});

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/** A document that can host the guard's observer and frame loop. */
function installableDoc({ sheets = [], present = [] } = {}) {
  const listeners = new Map();
  let frames = 0;
  return {
    doc: {
      readyState: 'complete',
      head: { nodeType: 1 },
      documentElement: { nodeType: 1 },
      styleSheets: sheets,
      querySelectorAll: (selector) => (present.includes(selector) ? [{}] : []),
      addEventListener: (type, handler) => listeners.set(type, handler),
      defaultView: { requestAnimationFrame: () => { frames += 1; } },
    },
    frames: () => frames,
  };
}

test('installing it sweeps immediately and returns a detach that stops the observer', () => {
  const sheet = fakeSheet([{ selectorText: `${LIVE_GATE} .douyin-player > div:has(a[href])` }]);
  const { doc } = installableDoc({ sheets: [sheet] });

  let observed = 0;
  let disconnected = 0;
  const original = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    observe() { observed += 1; }

    disconnect() { disconnected += 1; }
  };

  try {
    const detach = installStyleCostGuard({ doc, log: () => {}, recheckFrames: 1 });
    assert.equal(observed, 2, 'head and documentElement');
    assert.deepEqual(sheet.selectors(), [NEVER_MATCHES], 'the first sweep is synchronous');
    detach();
    assert.equal(disconnected, 1);
  } finally {
    globalThis.MutationObserver = original;
  }
});

test('the frame check only runs when something was actually rewritten', () => {
  // The check is what makes the rewrite reversible, and it is not free. A page with nothing to
  // fix - which is the common case for a rule set that matches - must not pay for it.
  const original = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    observe() {}

    disconnect() {}
  };

  try {
    const untouched = installableDoc({ sheets: [fakeSheet([{ selectorText: `${LIVE_GATE} .a:has(img)` }])], present: [LIVE_GATE] });
    installStyleCostGuard({ doc: untouched.doc, log: () => {} });
    assert.equal(untouched.frames(), 0, 'nothing rewritten, no frame loop');

    const rewritten = installableDoc({ sheets: [fakeSheet([{ selectorText: `${LIVE_GATE} .a:has(img)` }])] });
    installStyleCostGuard({ doc: rewritten.doc, log: () => {} });
    assert.ok(rewritten.frames() > 0, 'a rewrite is watched so it can be undone');
  } finally {
    globalThis.MutationObserver = original;
  }
});

test('detaching stops the frame loop', () => {
  const original = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    observe() {}

    disconnect() {}
  };

  try {
    const sheet = fakeSheet([{ selectorText: `${LIVE_GATE} .a:has(img)` }]);
    const { doc, frames } = installableDoc({ sheets: [sheet] });
    const detach = installStyleCostGuard({ doc, log: () => {} });
    const before = frames();
    detach();
    assert.equal(frames(), before, 'no further frames are requested');
  } finally {
    globalThis.MutationObserver = original;
  }
});

// ---------------------------------------------------------------------------
// Against the real bundle
// ---------------------------------------------------------------------------

test('the bundle still contains gated branches, so the tests above are not vacuous', () => {
  // If upstream ever stops emitting `[data-e2e="feed-live"]`-gated selectors, this guard has
  // nothing to do and every assertion above becomes theatre. Fail loudly instead.
  const gated = [...BUNDLE.matchAll(new RegExp(`\\[data-e2e="feed-live"\\]`, 'g'))];
  assert.ok(gated.length > 10, `expected the bundle to still gate selectors on the live feed, found ${gated.length}`);
});

test('every gated branch in the bundle is judged unreachable when the gate is absent', () => {
  // The real work: pull the live-room branches straight out of the bundle and check the
  // predicate against them, rather than against strings invented for the test.
  const branches = BUNDLE.split('\n')
    .map((line) => {
      const at = line.indexOf(LIVE_GATE);
      if (at === -1) return null;
      return line.slice(at).trim().replace(/[,;'"`]+$/, '').trim();
    })
    .filter((branch) => branch && branch.indexOf(COSTLY) !== -1);

  assert.ok(branches.length > 5, `expected several gated :has() branches, found ${branches.length}`);

  const withoutGate = { querySelectorAll: () => [] };
  for (const branch of branches) {
    assert.equal(
      isSegmentReachable(branch, withoutGate),
      false,
      `the guard would keep paying for:\n${branch}`,
    );
  }
});
