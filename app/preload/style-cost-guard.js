'use strict';

/**
 * Keep the injected stylesheet from making every style recalculation expensive.
 *
 * The bundled userscript injects a large stylesheet whose rules mix selectors that apply to
 * *this* page with selectors that only ever apply to a page the user is not on. `addBlockCSS`
 * is how: it joins every selector it is given into **one** rule, so a rule about the video
 * info panel ends up carrying the live-room-only branches alongside the ones that match:
 *
 *   #video-info-wrap,
 *   [data-e2e="feed-live"] [data-e2e="basicPlayer"] > div:has([aria-label*="直播"]),
 *   [data-e2e="feed-live"] .douyin-player > div:has(a[href]){ display: none !important; }
 *
 * On the recommend feed there is no `[data-e2e="feed-live"]` anywhere, so those branches can
 * never match - but `:has()` is the expensive part of the engine: it cannot use the fast
 * invalidation path, because *any* change inside a candidate subtree can flip whether it
 * matches. Measured on the live feed over a 15 s window, style recalculation was 2144 ms of
 * 5167 ms of task time (41.5%); removing these branches took the same window from 653 ms to
 * 4 ms, while the *number* of recalculations barely moved (2425 -> 2638). The cost is per
 * recalculation, not more recalculation.
 *
 * **Why the branches are removed rather than the rule.** The rule above still has to exist:
 * its first branch is what moves the video info panel. Dropping the whole rule would silently
 * lose a feature. So each comma-separated branch is judged on its own.
 *
 * **Why it is safe.** A branch whose leftmost compound selector matches nothing in the
 * document cannot match, whatever follows it - so removing it cannot change what the page
 * looks like. That is a statement about *this* document, so it is checked against the document
 * rather than assumed, and only branches that pass are touched.
 *
 * The check strips pseudo-classes before it asks, because they only ever *narrow* what a
 * selector matches: `E:p` can match nothing that `E` does not already match, so if `E` matches
 * nothing then `E:p` matches nothing either. That direction is the safe one, and it is what
 * lets the guard see through `[data-e2e="feed-live"]:hover` - a shape this stylesheet does use -
 * without ever concluding that a branch is dead because of a `:has()` it cannot evaluate.
 * Anything left undecidable (`div:has(...)` whose `div` does exist, a selector the engine
 * refuses to parse, a compound that is nothing but a pseudo-class) is kept.
 *
 * **Why it is reversible.** A single-page navigation can make a gate appear later (opening a
 * live room from the feed), and a permanently rewritten stylesheet would quietly disable the
 * live-room branches for the rest of the session. Every rewrite records the original selector
 * text, and a cheap animation-frame check puts it back the moment the gate becomes reachable.
 * The check only runs when something was actually rewritten, so a page with nothing to fix
 * pays nothing.
 *
 * **Why rules are neutralised, not deleted.** `deleteRule` shifts every later rule up, and a
 * stylesheet's order is part of its meaning - restoring into the wrong slot would be a real
 * bug. Writing an unreachable selector into `selectorText` keeps the rule exactly where it
 * was, so restoring is a single assignment.
 */

/** Only rules containing this are candidates. Everything else recalculates cheaply. */
const COSTLY = ':has(';

/**
 * What an entirely unreachable rule is rewritten to.
 *
 * `:not(*)` matches nothing by definition and carries no `:has()`, so the rule costs the
 * engine almost nothing while still occupying its original slot in the stylesheet.
 */
const NEVER_MATCHES = ':not(*)';

/** Wait this long after a stylesheet lands before sweeping it. */
const DEBOUNCE_MS = 300;

/** How often the recovery check runs, in animation frames (~0.5 s at 60 fps). */
const RECHECK_FRAMES = 30;

/** Aggregate repeated log lines for this long before writing them out. */
const LOG_THROTTLE_MS = 10000;

/**
 * Split a selector list on its **top-level** commas.
 *
 * A plain `split(',')` is wrong here in two ways that both occur in this stylesheet:
 * `:has(a, b)` and `:nth-child(2n+1)` carry commas inside parentheses, and an attribute value
 * may contain one too (`[href*="a,b"]`). Both must stay inside their branch.
 *
 * @param {string} text
 * @returns {string[]} trimmed, non-empty branches
 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(' || char === '[') { depth += 1; continue; }
    if (char === ')' || char === ']') { depth = Math.max(0, depth - 1); continue; }
    if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));

  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * The leftmost compound selector of a branch - the part the engine must match first.
 *
 * Everything from the first top-level combinator (` `, `>`, `+`, `~`) onwards is a descendant
 * requirement, and a branch cannot match if its first compound does not. Combinators inside
 * `[...]` or `(...)` are not separators: `[data-e2e="feed-live"]` has none, while
 * `:nth-child(2n+1)` and `[href*="a+b"]` keep theirs.
 *
 * @param {string} segment
 * @returns {string} possibly empty, for degenerate input
 */
function leftmostCompound(segment) {
  const text = String(segment || '');
  let depth = 0;
  let quote = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(' || char === '[') { depth += 1; continue; }
    if (char === ')' || char === ']') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r'
      || char === '>' || char === '+' || char === '~') {
      return text.slice(0, index).trim();
    }
  }

  return text.trim();
}

/**
 * Strip the pseudo-classes and pseudo-elements out of a compound selector.
 *
 * What is left is the part that has to match an element for anything else in the compound to
 * have a chance. Pseudo-classes only narrow a match - `a:hover` matches a subset of `a`,
 * `div:has(x)` a subset of `div` - so "the skeleton matches nothing" implies "the compound
 * matches nothing", while the reverse does not hold. That one-way implication is the whole
 * reason this is safe to act on.
 *
 * Colons inside brackets are left alone, so `[href*="https:"]` keeps its value, and a
 * compound that is nothing but a pseudo-class (`:hover`, `::before`) yields an empty skeleton -
 * which the caller reads as "cannot decide" rather than "matches nothing".
 *
 * @param {string} compound
 * @returns {string} possibly empty
 */
function structuralSkeleton(compound) {
  const text = String(compound || '');
  let out = '';
  let bracketDepth = 0;
  let quote = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      out += char;
      if (char === '\\') { out += text[index + 1] || ''; index += 1; }
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; out += char; continue; }
    if (char === '[') { bracketDepth += 1; out += char; continue; }
    if (char === ']') { bracketDepth = Math.max(0, bracketDepth - 1); out += char; continue; }
    if (bracketDepth > 0) { out += char; continue; }

    if (char === ':') {
      let cursor = index + 1;
      if (text[cursor] === ':') cursor += 1; // ::before
      while (cursor < text.length && /[-\w]/.test(text[cursor])) cursor += 1;
      // Skip the argument list wholesale, so `:has(> div > #wrap)` loses all of it.
      if (text[cursor] === '(') {
        let depth = 1;
        cursor += 1;
        while (cursor < text.length && depth > 0) {
          if (text[cursor] === '(') depth += 1;
          else if (text[cursor] === ')') depth -= 1;
          cursor += 1;
        }
      }
      index = cursor - 1;
      continue;
    }

    out += char;
  }

  return out.trim();
}

/**
 * Can this branch match anything in the document as it is right now?
 *
 * Deliberately conservative: anything that cannot be decided cheaply answers `true`, which
 * means "keep it". A false `true` costs performance; a false `false` changes what the page
 * looks like, and those two are not comparable.
 *
 * @param {string} segment one branch of a selector list
 * @param {Document} doc
 */
function isSegmentReachable(segment, doc) {
  const skeleton = structuralSkeleton(leftmostCompound(segment));
  // Nothing left to query: the branch is all pseudo-class, or there was no selector at all.
  if (!skeleton) return true;
  // `*` matches every element in a document that has any, and asking costs a full traversal.
  if (skeleton === '*') return true;
  try {
    return doc.querySelectorAll(skeleton).length > 0;
  } catch {
    // A selector this engine will not parse is not ours to reason about.
    return true;
  }
}

/**
 * Rewrite every rule branch that cannot match, and remember how to put it back.
 *
 * @param {object} options
 * @param {Document} options.doc
 * @param {(message: string, data?: object) => void} options.log
 * @param {Map<object, {original: string, gates: string[]}>} options.changed rewritten rules,
 *   keyed by the rule object so a second sweep updates the record instead of losing the
 *   original text
 * @returns {number} how many branches were removed
 */
function sweepStyleCost({ doc, log, changed }) {
  let removed = 0;

  for (const sheet of Array.from(doc.styleSheets)) {
    let rules;
    try {
      // Cross-origin sheets throw; they are also not where an injected style lives.
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;

    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index];
      const selectorText = rule && rule.selectorText;
      // Cheap gate first: everything without `:has()` recalculates on the fast path already.
      if (typeof selectorText !== 'string' || selectorText.indexOf(COSTLY) === -1) continue;

      const segments = splitTopLevel(selectorText);
      if (segments.length === 0) continue;

      const keep = [];
      const gates = [];
      for (const segment of segments) {
        if (isSegmentReachable(segment, doc)) keep.push(segment);
        // The skeleton, not the raw compound: the restore check below has to ask the same
        // question this one just answered, and `[data-e2e="feed-live"]:hover` never matches
        // anything, so remembering it verbatim would mean never putting the branch back.
        else gates.push(structuralSkeleton(leftmostCompound(segment)));
      }
      // Nothing to do, which is also the state a previous sweep leaves behind - so this is
      // what makes repeated sweeps idempotent.
      if (gates.length === 0) continue;

      const next = keep.length === 0 ? NEVER_MATCHES : keep.join(', ');
      try {
        rule.selectorText = next;
      } catch {
        continue;
      }
      // A rejected assignment leaves the text untouched; writing is not guaranteed to take.
      if (rule.selectorText === selectorText) continue;

      removed += gates.length;
      const known = changed.get(rule);
      if (known) {
        known.gates = Array.from(new Set([...known.gates, ...gates]));
        continue;
      }
      changed.set(rule, { original: selectorText, gates: Array.from(new Set(gates)) });
      log('已移除当前页面不可能命中的 :has 选择器分支（样式重算代价的主要来源）', {
        removed: gates.join(', ').slice(0, 300),
        kept: keep.length,
      });
    }
  }

  return removed;
}

/**
 * Put back every rule whose gate has since become reachable.
 *
 * @param {object} options
 * @param {Document} options.doc
 * @param {(message: string, data?: object) => void} options.log
 * @param {Map<object, {original: string, gates: string[]}>} options.changed
 * @returns {number} how many rules were restored
 */
function restoreReachable({ doc, log, changed }) {
  let restored = 0;

  for (const [rule, entry] of Array.from(changed)) {
    // The same question the sweep asked, so the answer flips exactly when the branch becomes
    // live again. `true` on a failure, because restoring is the safe direction.
    const reachable = entry.gates.some((gate) => {
      try {
        return doc.querySelectorAll(gate).length > 0;
      } catch {
        return true;
      }
    });
    if (!reachable) continue;

    try {
      rule.selectorText = entry.original;
    } catch {
      changed.delete(rule);
      continue;
    }
    // If the rule was dropped from its stylesheet the write goes nowhere; forget it either
    // way rather than retrying on every frame.
    changed.delete(rule);
    if (rule.selectorText !== entry.original) continue;

    restored += 1;
    log('门控元素已出现，恢复样式规则', { selector: entry.original.slice(0, 300) });
  }

  return restored;
}

/**
 * Install the guard.
 *
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {(message: string, data?: object) => void} [options.log]
 * @param {number} [options.debounceMs]
 * @param {number} [options.recheckFrames]
 * @returns {() => void} detaches
 */
function installStyleCostGuard(options = {}) {
  const doc = options.doc || document;
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : DEBOUNCE_MS;
  const recheckFrames = Number.isFinite(options.recheckFrames) ? options.recheckFrames : RECHECK_FRAMES;
  // console.warn, not console.log: the shell captures warning-level page console output into
  // the log, and this is a change to how the page renders - it should be findable afterwards.
  //
  // Throttled, because one line per rewritten rule is unreadable: a normal session rewrote
  // 400+ rules and every one of them became a log entry. Entries are aggregated per message
  // and flushed at most once per window, with the number of occurrences attached - the first
  // flush still happens quickly, so the log is not silent for long.
  const rawLog = options.log || ((message, data) => console.warn(
    `[抖音] ${message}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`,
  ));
  const pending = new Map();
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    const entries = Array.from(pending.entries());
    pending.clear();
    for (const [message, entry] of entries) rawLog(message, { ...entry.sample, count: entry.count });
  };
  const log = (message, data) => {
    const entry = pending.get(message) || { count: 0, sample: data };
    entry.count += 1;
    if (data !== undefined) entry.sample = data;
    pending.set(message, entry);
    if (flushTimer) return;
    flushTimer = setTimeout(flush, LOG_THROTTLE_MS);
    if (flushTimer.unref) flushTimer.unref();
  };

  /** rule -> how to restore it. Only ever holds rules this guard rewrote. */
  const changed = new Map();
  let timer = null;
  let stopped = false;
  let rechecking = false;

  /**
   * Watch for a gate becoming reachable, on animation frames rather than a timer.
   *
   * A timer is the wrong instrument twice over: `setInterval` in a preload keeps running while
   * the window is occluded (measured: a 2 s interval ticked three times in 30 s and then
   * stopped for good), and this check only means anything while the page is being rendered.
   * Frames are self-limiting and cost nothing when there is nothing to check.
   */
  const startRecheck = () => {
    if (rechecking || stopped) return;
    const view = doc.defaultView;
    if (!view || typeof view.requestAnimationFrame !== 'function') return;
    rechecking = true;

    let frames = 0;
    const tick = () => {
      if (stopped) { rechecking = false; return; }
      frames += 1;
      if (frames >= recheckFrames) {
        frames = 0;
        try {
          restoreReachable({ doc, log, changed });
        } catch (error) {
          log('恢复样式规则失败', { error: String((error && error.message) || error) });
        }
      }
      view.requestAnimationFrame(tick);
    };
    view.requestAnimationFrame(tick);
  };

  const run = () => {
    if (stopped) return;
    try {
      if (sweepStyleCost({ doc, log, changed }) > 0) startRecheck();
    } catch (error) {
      log('检查样式规则代价失败', { error: String((error && error.message) || error) });
    }
  };

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; run(); }, debounceMs);
    if (timer.unref) timer.unref();
  };

  // Same reasoning as the video-visibility guard: watch the two places a stylesheet can land
  // (`DOMUtils.addStyle` uses `<head>`, with a `documentElement` fallback), because watching
  // the whole tree would mean a callback on every mutation of a page that mutates constantly.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'STYLE' || node.tagName === 'LINK') {
          schedule();
          return;
        }
      }
    }
  });

  const observe = () => {
    const roots = [doc.head, doc.documentElement].filter(Boolean);
    for (const root of roots) {
      try {
        observer.observe(root, { childList: true });
      } catch {
        // Nothing to observe yet; the load sweep below still runs.
      }
    }
    run();
  };

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', observe, { once: true });
  } else {
    observe();
  }
  doc.addEventListener('load', schedule, { once: true });

  return () => {
    stopped = true;
    clearTimeout(timer);
    timer = null;
    clearTimeout(flushTimer);
    flush();
    observer.disconnect();
  };
}

module.exports = {
  COSTLY,
  DEBOUNCE_MS,
  NEVER_MATCHES,
  RECHECK_FRAMES,
  installStyleCostGuard,
  isSegmentReachable,
  leftmostCompound,
  restoreReachable,
  splitTopLevel,
  structuralSkeleton,
  sweepStyleCost,
};
