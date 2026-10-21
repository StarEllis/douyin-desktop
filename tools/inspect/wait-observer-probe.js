'use strict';

/**
 * Measure what the vendor's `waitNode` family costs while it waits.
 *
 * The suspicion: `ElementWait.wait()` in `vendor/domutils.umd.js` installs a **document-wide**
 * observer with `{ subtree: true, childList: true, attributes: true }` and only disconnects it when
 * the awaited node appears or when a timeout expires. `attributes: true` with no `attributeFilter`
 * means every `class` / `style` / `data-*` write anywhere in the document wakes the callback, and
 * the callback re-runs `document.querySelector(selector)`. The bundle calls into this family from
 * 23 places, 7 of them without a timeout at all.
 *
 * That reasoning is plausible and therefore worth a measurement rather than an argument - this
 * project has already been wrong once about "the machine cannot use the GPU" from an unmeasured
 * inference (see AGENTS.md).
 *
 * Two things turned out to need separating, and the first version of this probe conflated them:
 *
 *   - the **observer machinery** cost, which depends on the config (`attributes` makes every
 *     attribute write produce a record, for every attached observer);
 *   - the **callback** cost, which is one `querySelectorAll` per delivery and depends entirely on
 *     the selector. One of the bundle's wait selectors contains `:has()`, and `:has()` is the
 *     expensive thing in this project's history.
 *
 * So the phases are a 2x2 - {cheap selector, `:has()` selector} x {childList, childList+attributes}
 * - preceded by a direct per-selector price table. Without that split, a single `:has()` selector in
 * the pool makes all configurations look equally expensive and the measurement says nothing.
 *
 * Everything runs inside **one** renderer session (numbers from two launches are not comparable).
 * Each phase is a pair of adjacent runs in a freshly reloaded page - one with no observers, one
 * with them - driving an identical mutation load. The reload is not decoration: `wait()` leaves its
 * observer attached for the full timeout (20 s in this bundle), so runs in a shared page would
 * measure an accumulating pile rather than the number under test.
 *
 * Usage (the env prefix matters - `ELECTRON_RUN_AS_NODE` is set in agent shells and would make
 * Electron behave as plain Node):
 *
 *   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
 *     node_modules/electron/dist/electron.exe tools/inspect/wait-observer-probe.js
 *
 * Options: --observers=N (concurrent waits, default 4), --load-ms=N (mutation load per run,
 * default 2000), --reps=N (pairs per phase, default 2), --visible.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const APP_ROOT = path.join(__dirname, '..', '..');
const BUNDLE_PATH = path.join(APP_ROOT, 'assets', 'douyin-optimization.user.js');
const DOMUTILS_PATH = path.join(APP_ROOT, 'vendor', 'domutils.umd.js');

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  if (!found) return fallback;
  const parsed = Number(found.slice(prefix.length));
  return Number.isFinite(parsed) ? parsed : fallback;
}

const OBSERVERS = argument('observers', 4);
const LOAD_MS = argument('load-ms', 2000);
// Four, so the alternating order gets two pairs each way.
const REPS = argument('reps', 4);
const VISIBLE = process.argv.includes('--visible');

const WAIT_CALL = /\bwait(?:Any)?Node(?:List)?\s*\(/g;

/**
 * Read a whole argument list, honouring nesting and all three quote styles.
 *
 * Counting parens rather than matching a regex is what makes this survive the multi-line, nested
 * calls the bundle actually contains (`waitNode(() => { ... })`). The result is split on top-level
 * commas by `splitArguments`, because the timeout lives in a different position depending on how
 * many arguments the call passes.
 */
function readArgument(source, at) {
  let depth = 1;
  let quote = null;
  let buffer = '';
  for (let i = at; i < source.length && depth > 0; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') { buffer += char + source[i + 1]; i += 1; continue; }
      if (char === quote) quote = null;
      buffer += char;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; buffer += char; continue; }
    if (char === '(') depth += 1;
    else if (char === ')') { depth -= 1; if (depth === 0) break; }
    buffer += char;
  }
  return buffer.trim();
}

/** Split an argument list on top-level commas, honouring nesting and all three quote styles. */
function splitArguments(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let buffer = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === '\\') { buffer += char + text[i + 1]; i += 1; continue; }
      if (char === quote) quote = null;
      buffer += char;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; buffer += char; continue; }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(buffer.trim()); buffer = ''; continue; }
    buffer += char;
  }
  if (buffer.trim()) parts.push(buffer.trim());
  return parts;
}

/** Top-level `const NAME = <number>` declarations, so `WAIT_TIME` can be resolved to 20000. */
function numericConstants(source) {
  const map = new Map();
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*[;,]/g,
  )) {
    map.set(match[1], Number(match[2]));
  }
  return map;
}

/**
 * Every `waitNode*` call: which line, how long its observer lives, and the literal first argument
 * when there is one.
 *
 * The lifetime rule comes from the vendor: `wait()` only arms its disconnect timer when the
 * resolved timeout is positive. So a call is bounded when it passes a numeric third argument, or
 * a numeric second one - and permanent when it passes nothing, or passes a Node as the second
 * argument (`waitNode(selector, parent)` leaves `timeout` at 0).
 *
 * Recognising `WAIT_TIME` matters: a detector that only accepts numeric literals reports every
 * named constant as permanent, which is how the first version of this probe got the answer wrong.
 */
function scanWaitCalls(source) {
  const constants = numericConstants(source);
  const resolve = (text) => {
    if (!text) return null;
    if (/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return Number(text);
    if (constants.has(text)) return constants.get(text);
    return null;
  };

  const sites = [];
  WAIT_CALL.lastIndex = 0;
  let match;
  while ((match = WAIT_CALL.exec(source)) !== null) {
    const at = match.index + match[0].length;
    const parts = splitArguments(readArgument(source, at));
    const first = parts[0] || '';
    const literal = /^(['"`])((?:\\.|(?!\1)[\s\S])*?)\1$/.exec(first);
    sites.push({
      line: source.slice(0, match.index).split('\n').length,
      name: match[0].replace(/\s*\($/, ''),
      selector: literal ? literal[2] : null,
      // `null` means the observer never disconnects on its own.
      timeout: parts.length >= 3 ? resolve(parts[2]) : parts.length === 2 ? resolve(parts[1]) : null,
    });
  }
  return sites;
}

/** The recommend feed, plus comment rows for the mutation load to churn. */
function buildPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>wait-observer probe</title>
<style>
  body { margin: 0; font: 14px/1.4 system-ui, sans-serif; }
  .comment { display: block; padding: 4px; }
  .stress { outline: 1px solid currentColor; }
</style>
</head>
<body>
<div id="app">
  <div id="douyin-header"><div data-e2e="douyin-navigation"><div class="nav"><a class="tab-recommend">推荐</a></div></div></div>
  <div id="sliderVideo" data-e2e="feed-active-video">
    <div class="slider-video">
      <div class="basePlayerContainer">
        <div class="imgBackground"><img alt=""></div>
        <div class="douyin-player"><video id="the-video"></video></div>
      </div>
    </div>
    <div id="video-info-wrap"><h1>标题</h1></div>
  </div>
  <div id="comments"></div>
</div>
<script src="domutils.umd.js"></script>
<script>
  (function buildComments() {
    var list = document.getElementById('comments');
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < 800; i += 1) {
      var row = document.createElement('div');
      row.className = 'comment';
      row.innerHTML = '<span class="avatar"></span><div class="body"><p class="text">评论 ' + i + '</p></div>';
      fragment.appendChild(row);
    }
    list.appendChild(fragment);
  })();
</script>
</body>
</html>`;
}

/**
 * One framework commit's worth of DOM writes: class and style churn on rows, attribute writes on
 * the player, and a node insertion. The feed does all of this constantly as it scrolls.
 *
 * Mutation callbacks are delivered per microtask checkpoint, so ten thousand writes inside one
 * synchronous block would wake the observers once. Real commits land in separate tasks, which is
 * why the load is driven from `setTimeout(0)` against a deadline.
 */
function loadDriver(loadMs) {
  return `new Promise((resolve) => {
    const rows = document.querySelectorAll('#comments .comment');
    const player = document.querySelector('#sliderVideo');
    const host = document.getElementById('app');
    const deadline = performance.now() + ${loadMs};
    let commits = 0;
    function commit() {
      const base = (commits * 7) % rows.length;
      for (let i = 0; i < 20; i += 1) rows[(base + i) % rows.length].classList.toggle('stress');
      for (let i = 0; i < 10; i += 1) {
        rows[(base + i) % rows.length].style.transform = 'translateY(' + (i * 0.5) + 'px)';
      }
      if (player) {
        player.setAttribute('data-commit', String(commits));
        player.setAttribute('data-e2e', commits % 2 ? 'feed-active-video' : 'feed-active-video ');
        player.setAttribute('data-e2e', 'feed-active-video');
      }
      const scratch = document.createElement('span');
      host.appendChild(scratch);
      scratch.remove();
      commits += 1;
      if (performance.now() < deadline) setTimeout(commit, 0);
      else resolve(commits);
    }
    commit();
  })`;
}

/** Raw observers carrying `wait()`'s callback work: re-query the document for one selector. */
function rawObserverScript(config, count, selector) {
  return `(() => {
    for (let i = 0; i < ${count}; i += 1) {
      const observer = new MutationObserver(() => {
        try { document.querySelectorAll(${JSON.stringify(selector)}); } catch (error) { /* unsupported */ }
      });
      observer.observe(document, ${JSON.stringify(config)});
    }
    return ${count};
  })()`;
}

/** Price each selector on its own: this is what one observer callback costs, per delivery. */
function priceScript(selectors, iterations) {
  return `(() => {
    const out = [];
    for (const selector of ${JSON.stringify(selectors)}) {
      for (let i = 0; i < 20; i += 1) { try { document.querySelectorAll(selector); } catch (error) { /* unsupported */ } }
      const start = performance.now();
      for (let i = 0; i < ${iterations}; i += 1) {
        try { document.querySelectorAll(selector); } catch (error) { /* unsupported */ }
      }
      out.push({ selector, perQuery: (performance.now() - start) / ${iterations} });
    }
    return out.sort((a, b) => b.perQuery - a.perQuery);
  })()`;
}

async function main() {
  const bundle = fs.readFileSync(BUNDLE_PATH, 'utf8');
  const sites = scanWaitCalls(bundle);

  const literal = [...new Set(sites.map((site) => site.selector).filter(Boolean))];
  // `:contains(...)` is the vendor's own extension and `document.querySelectorAll` rejects it, so
  // the priced selectors are the plain ones only.
  const plain = literal.filter((selector) => !selector.includes(':contains'));
  const hasSelector = plain.find((selector) => selector.includes(':has('));
  const cheap = plain.filter((selector) => !selector.includes(':has('));

  const pageDir = path.join(os.tmpdir(), `wait-observer-probe-${process.pid}`);
  fs.mkdirSync(pageDir, { recursive: true });
  const pagePath = path.join(pageDir, 'index.html');
  fs.writeFileSync(pagePath, buildPage(), 'utf8');
  fs.copyFileSync(DOMUTILS_PATH, path.join(pageDir, 'domutils.umd.js'));

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: VISIBLE,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  const contents = window.webContents;
  await contents.loadFile(pagePath);

  const vendorLoaded = await contents.executeJavaScript(
    'typeof (window.DOMUtils && window.DOMUtils.waitNode)',
  );
  if (vendorLoaded !== 'function') {
    throw new Error(`页面没有加载 vendor 的 waitNode（得到 ${vendorLoaded}）`);
  }

  contents.debugger.attach('1.3');
  await contents.debugger.sendCommand('Performance.enable');

  // `executeJavaScript` reports only "an error was thrown"; the label is what makes a failure
  // say which step it came from.
  const runScript = async (script, label) => {
    try {
      return await contents.executeJavaScript(script);
    } catch (error) {
      throw new Error(`执行失败于「${label}」：${error && error.message}`);
    }
  };

  const readMetrics = async () => {
    const { metrics } = await contents.debugger.sendCommand('Performance.getMetrics');
    return Object.fromEntries(metrics.map((entry) => [entry.name, entry.value]));
  };

  const prices = await runScript(priceScript(plain, 200), '给选择器定价');
  const priceOf = new Map(prices.map((entry) => [entry.selector, entry.perQuery]));

  /**
   * Price the selectors again on a much larger document.
   *
   * This is the difference between "1.2 ms" and "1.2 ms, and worse on a real page". The `:has()`
   * selector is scoped to `[id^="douyin-header"]`, which is a handful of elements - if its price
   * still grows with the number of unrelated comment rows, the engine is not searching that
   * subtree, it is searching the document, and the real page (which has far more nodes) costs
   * proportionally more.
   */
  const grownRows = await runScript(`(() => {
    const list = document.getElementById('comments');
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 6400; i += 1) {
      const row = document.createElement('div');
      row.className = 'comment';
      row.innerHTML = '<span class="avatar"></span><div class="body"><p class="text">评论 ' + i + '</p></div>';
      fragment.appendChild(row);
    }
    list.appendChild(fragment);
    return document.querySelectorAll('#comments .comment').length;
  })()`, '扩容 DOM');
  const grownPrices = await runScript(priceScript(plain, 200), '扩容后定价');
  const grownPriceOf = new Map(grownPrices.map((entry) => [entry.selector, entry.perQuery]));

  const runOnce = async () => {
    const before = await readMetrics();
    const commits = await runScript(loadDriver(LOAD_MS), '驱动 mutation 负载');
    const after = await readMetrics();
    return {
      task: after.TaskDuration - before.TaskDuration,
      script: after.ScriptDuration - before.ScriptDuration,
      commits,
    };
  };

  /**
   * A pair of adjacent runs in a freshly reloaded page: no observers, then the treatment.
   *
   * Two things keep the comparison honest, and both were missing from the first version:
   *
   *   - both sides do the same number of round-trips, so the baseline gets a no-op script call
   *     where the treatment gets its install - otherwise "the run that came after an extra
   *     round-trip" and "the run with observers" are the same side of every pair;
   *   - the order alternates, so a "first run after a reload" bias lands on each side equally
   *     rather than entirely on one. The first version reported a +437 ms delta for the phase with
   *     **no observers at all**, which is what a one-sided bias looks like.
   *
   * The reload is what keeps `wait()`'s 20 s observers from stacking up across repetitions.
   */
  const runPair = async (treatment, label) => {
    const pairs = [];
    for (let rep = 0; rep < REPS; rep += 1) {
      let baseline;
      let treated;
      if (rep % 2 === 1) {
        await contents.reload();
        if (treatment) await runScript(treatment, label); else await runScript('void 0', '空操作');
        treated = await runOnce();
        await contents.reload();
        await runScript('void 0', '空操作');
        baseline = await runOnce();
      } else {
        await contents.reload();
        await runScript('void 0', '空操作');
        baseline = await runOnce();
        await contents.reload();
        if (treatment) await runScript(treatment, label); else await runScript('void 0', '空操作');
        treated = await runOnce();
      }
      pairs.push({ baseline, treated });
    }
    const deltas = pairs.map((pair) => pair.treated.task - pair.baseline.task).sort((a, b) => a - b);
    return {
      pairs,
      commits: pairs[pairs.length - 1].baseline.commits,
      taskDelta: deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
      // A reload normally reuses the renderer, so the counters keep climbing. If they ever do
      // not, the delta is meaningless - say so rather than reporting a made-up number.
      suspicious: pairs.some((pair) => pair.treated.task < pair.baseline.task * 0.5),
    };
  };

  const phases = [];
  phases.push(['基线（不装观察器）', await runPair(null, '基线')]);
  for (const [selector, selectorLabel] of [
    [cheap[0], `廉价选择器 ${cheap[0]}`],
    [hasSelector, `:has() 选择器 ${hasSelector}`],
  ]) {
    if (!selector) continue;
    for (const [config, configLabel] of [
      [{ subtree: true, childList: true }, 'childList'],
      [{ subtree: true, childList: true, attributes: true }, 'childList+attributes'],
    ]) {
      phases.push([
        `${selectorLabel} × ${configLabel}`,
        await runPair(rawObserverScript(config, OBSERVERS, selector), configLabel),
      ]);
    }
  }

  // The real code path, for the record: the vendor's own wait, with the bundle's own timeout.
  phases.push([
    `真实 waitNode(sel, 2e4) × ${OBSERVERS}`,
    await runPair(`(() => {
      if (!window.DOMUtils || typeof window.DOMUtils.waitNode !== 'function') {
        throw new Error('页面里没有 DOMUtils.waitNode');
      }
      const selectors = ${JSON.stringify([cheap[0], hasSelector].filter(Boolean))};
      for (let i = 0; i < ${OBSERVERS}; i += 1) {
        window.DOMUtils.waitNode(selectors[i % selectors.length], 2e4).catch(() => {});
      }
      return ${OBSERVERS};
    })()`, '真实 waitNode'),
  ]);

  const format = (value) => `${(value * 1000).toFixed(1)} ms`;
  const perObserver = (value) => (1000 * value * 1000) / (LOAD_MS * OBSERVERS);
  const permanent = sites.filter((site) => site.timeout === null);
  const bounded = sites.filter((site) => site.timeout !== null);
  const withHas = sites.filter((site) => site.selector && site.selector.includes(':has('));

  console.log('');
  console.log('=== waitNode 观察器代价探针（同一渲染器会话内配对 A/B）===');
  console.log(`负载：每轮 ${LOAD_MS} ms、约 ${phases[0][1].commits} 个 commit；每阶段 ${REPS} 对，取差值中位数`);
  console.log(`观察器：${OBSERVERS} 个并发等待，每对 = 重载 → 无观察器跑一轮 → 重载 → 装观察器跑一轮`);
  console.log('');
  console.log('选择器单价（本页单次 querySelectorAll，200 次平均）—— 这是每次回调的代价：');
  console.log('  800 行评论 → 7200 行评论，看单价是否随文档变大而变贵：');
  for (const entry of prices) {
    const grown = grownPriceOf.get(entry.selector);
    const ratio = grown && entry.perQuery > 0 ? `  (${(grown / entry.perQuery).toFixed(1)}x)` : '';
    console.log(`  ${(entry.perQuery * 1000).toFixed(1).padStart(8)} µs → `
      + `${grown === undefined ? '?' : (grown * 1000).toFixed(1).padStart(8)} µs${ratio}   ${entry.selector}`);
  }
  console.log('');
  console.log('各阶段的额外任务时间（差值，负载本身占掉大部分 Task）：');
  for (const [label, phase] of phases) {
    console.log(`  ${label}：Task +${format(phase.taskDelta)}  → 每个观察器 ${perObserver(phase.taskDelta).toFixed(2)} ms/s`
      + (phase.suspicious ? '  ⚠ 有配对出现负值，计数可能被重载重置' : ''));
    const spread = phase.pairs
      .map((pair) => ((pair.treated.task - pair.baseline.task) * 1000).toFixed(0))
      .join(' / ');
    console.log(`      各对差值：${spread} ms`);
  }
  console.log('  自检：把 --observers 减半，非零差值应大致减半；不成立说明有别的东西在动。');
  console.log('');
  console.log('bundle 里的 waitNode* 调用点：');
  console.log(`  合计 ${sites.length} 处：有超时 ${bounded.length} 处，永久 ${permanent.length} 处`);
  console.log(`  出现过的超时值：${[...new Set(bounded.map((site) => site.timeout))].sort((a, b) => a - b).join(' / ')} ms`);
  console.log('');
  console.log(`  第一个参数含 :has( 的 ${withHas.length} 处 —— 每次回调都要重新匹配一次：`);
  for (const site of withHas) {
    const price = priceOf.get(site.selector);
    console.log(`    第 ${site.line} 行  ${site.name}  ${site.selector}`);
    console.log(`      寿命 ${site.timeout === null ? '永久' : `${site.timeout} ms`}`
      + `，单价 ${price === undefined ? '未定价' : `${(price * 1000).toFixed(1)} µs`}`);
  }
  console.log('');
  console.log(`  永久观察器 ${permanent.length} 处（不会自己断开，直到节点出现或页面离开）：`);
  for (const site of permanent) {
    const price = priceOf.get(site.selector);
    console.log(`    第 ${site.line} 行  ${site.name}  ${site.selector || '(函数/非字面量)'}`
      + (price === undefined ? '' : `  [单价 ${(price * 1000).toFixed(1)} µs]`));
  }
  console.log('');
  console.log('说明：本页是推荐页形状的近似，不是真实页面的快照。上面两列的对比是判断');
  console.log('“单价是否随文档规模增长”的依据；真实页面元素更多，若该列在涨，实际单价只会更高。');

  fs.rmSync(pageDir, { recursive: true, force: true });
  app.quit();
}

app.commandLine.appendSwitch('lang', 'zh-CN');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

app.whenReady().then(main).catch((error) => {
  console.error('探针失败', error);
  app.exit(1);
});
