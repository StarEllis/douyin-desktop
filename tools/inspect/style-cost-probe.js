'use strict';

/**
 * Measure what the style-cost guard actually saves.
 *
 * The claim being tested: the bundled stylesheet's `:has()` branches that cannot match on this
 * page are what makes every style recalculation expensive, and removing them is what makes the
 * feed smooth. That claim is worth a measurement rather than an argument, because the two ways
 * to be wrong are both cheap to fall into - "it feels faster" after an unrelated change, and a
 * guard that silently matches nothing.
 *
 * What it does, all inside **one** renderer session (numbers from two launches are not
 * comparable - see AGENTS.md):
 *
 *   1. build a page whose DOM has the shape of the recommend feed and whose stylesheet is the
 *      real CSS pulled out of `assets/douyin-optimization.user.js`;
 *   2. force N style recalculations and read Chromium's own `RecalcStyleDuration`;
 *   3. run the guard in that same page, then force N more and read it again.
 *
 * The DOM deliberately contains `#sliderVideo[data-e2e="feed-active-video"]` and no
 * `[data-e2e="feed-live"]` anywhere, which is the recommend feed: that is the state in which
 * the live-room branches are dead weight.
 *
 * Usage (the env prefix matters - `ELECTRON_RUN_AS_NODE` is set in agent shells and would make
 * Electron behave as plain Node):
 *
 *   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
 *     node_modules/electron/dist/electron.exe tools/inspect/style-cost-probe.js
 *
 * Options: --rounds=N (recalculations per phase, default 400), --elements=N (comment rows,
 * default 2500), --visible (show the window; it stays hidden otherwise, which is fine because
 * a forced recalculation is synchronous and does not depend on the window being painted).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const APP_ROOT = path.join(__dirname, '..', '..');
const BUNDLE_PATH = path.join(APP_ROOT, 'assets', 'douyin-optimization.user.js');
const GUARD_PATH = path.join(APP_ROOT, 'app', 'preload', 'style-cost-guard.js');

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  if (!found) return fallback;
  const parsed = Number(found.slice(prefix.length));
  return Number.isFinite(parsed) ? parsed : fallback;
}

const ROUNDS = argument('rounds', 400);
const ELEMENTS = argument('elements', 2500);
const VISIBLE = process.argv.includes('--visible');

/**
 * Pull the real stylesheet out of the bundle.
 *
 * Two sources, because the script injects CSS two ways: whole stylesheets through
 * `addStyle(\`...\`)`, and single selectors through `addBlockCSS(...)` - which joins everything
 * it is given into one rule, and is how a rule about the video info panel ends up carrying
 * live-room-only branches.
 */
function extractRealCss(bundle) {
  const blocks = [];
  for (const match of bundle.matchAll(/addStyle\(\s*`([\s\S]*?)`\s*\)/g)) {
    blocks.push(match[1]);
  }

  const gated = new Set();
  for (const line of bundle.split('\n')) {
    const at = line.indexOf('[data-e2e="feed-live"]');
    if (at === -1) continue;
    const selector = line.slice(at).trim().replace(/[,;'"`{]+$/, '').trim();
    if (selector) gated.add(selector);
  }

  const rules = [...gated].map((selector) => `${selector}{ display: none !important; }`);

  return {
    css: `${blocks.join('\n')}\n${rules.join('\n')}`,
    blockCount: blocks.length,
    gatedCount: gated.size,
  };
}

/** The recommend feed: the player and the info panel are there, the live feed is not. */
function buildPage({ css, elements }) {
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>style-cost probe</title>
<style>${safeCss}</style>
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
        <div class="douyin-player">
          <video id="the-video"></video>
          <xg-video-container class="xg-video-container"></xg-video-container>
          <div class="douyin-player-controls"><div class="douyin-player-controls-right"></div></div>
        </div>
      </div>
    </div>
    <div id="video-info-wrap"><h1>标题</h1></div>
    <div class="positionBox">右侧操作栏</div>
  </div>
  <div id="comments"></div>
</div>
<script>
  (function buildComments() {
    var list = document.getElementById('comments');
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < ${elements}; i += 1) {
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

/** Read Chromium's own counters. `RecalcStyleDuration` is in seconds. */
function metricsReader(contents) {
  return async () => {
    const { metrics } = await contents.debugger.sendCommand('Performance.getMetrics');
    return Object.fromEntries(metrics.map((entry) => [entry.name, entry.value]));
  };
}

/**
 * Force `rounds` style recalculations.
 *
 * Toggling a class on a different row each time and then asking for a computed style is what
 * makes the engine actually recompute: the class change invalidates, the `getComputedStyle`
 * resolves it. This is the shape of work the feed does constantly - rows being marked and
 * measured as they scroll.
 */
function stressScript(rounds) {
  return `(() => {
    const rows = document.querySelectorAll('#comments .comment');
    for (let i = 0; i < ${rounds}; i += 1) {
      const row = rows[i % rows.length];
      row.classList.toggle('stress');
      void getComputedStyle(row).paddingLeft;
    }
    return rows.length;
  })()`;
}

/** Load the guard module into the page and return its exports. */
function guardLoader() {
  const source = fs.readFileSync(GUARD_PATH, 'utf8');
  return `(() => {
    const module = { exports: {} };
    (function (module, exports) {
${source}
    })(module, module.exports);
    return module.exports;
  })()`;
}

async function main() {
  const bundle = fs.readFileSync(BUNDLE_PATH, 'utf8');
  const { css, blockCount, gatedCount } = extractRealCss(bundle);

  const pagePath = path.join(os.tmpdir(), `style-cost-probe-${process.pid}.html`);
  fs.writeFileSync(pagePath, buildPage({ css, elements: ELEMENTS }), 'utf8');

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: VISIBLE,
    webPreferences: {
      // Matches the real window: the guard is a preload module and the page's own scope is
      // where it runs.
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  const contents = window.webContents;
  await contents.loadFile(pagePath);

  contents.debugger.attach('1.3');
  await contents.debugger.sendCommand('Performance.enable');
  const readMetrics = metricsReader(contents);

  const measure = async (rounds) => {
    const before = await readMetrics();
    await contents.executeJavaScript(stressScript(rounds));
    const after = await readMetrics();
    return {
      duration: after.RecalcStyleDuration - before.RecalcStyleDuration,
      count: after.RecalcStyleCount - before.RecalcStyleCount,
    };
  };

  // Warm up: the first pass pays for JIT and for lazily-built internal structures, which has
  // nothing to do with the selector cost being measured.
  await measure(Math.round(ROUNDS / 4));

  const baseline = await measure(ROUNDS);

  // The guard, in the page, exactly as the preload installs it. The sweep's own cost is timed
  // too: it is paid once per stylesheet, so it has to be small next to what it saves per
  // recalculation - otherwise this would be a trade rather than a win.
  const sweepResult = await contents.executeJavaScript(`(() => {
    const guard = ${guardLoader()};
    const changed = new Map();
    const reported = [];
    const started = performance.now();
    const removed = guard.sweepStyleCost({
      doc: document,
      log: (message, data) => reported.push({ message, data }),
      changed,
    });
    const elapsed = performance.now() - started;
    window.__guardChanged = changed;
    const gates = [];
    for (const entry of changed.values()) gates.push(...entry.gates);
    const unique = [...new Set(gates)].sort();
    return {
      removed,
      rules: changed.size,
      reported: reported.length,
      liveGates: gates.filter((gate) => gate.includes('feed-live')).length,
      gates: unique,
      elapsed,
    };
  })()`);

  const after = await measure(ROUNDS);

  // Reversibility is the property the whole design rests on, so it is checked here rather than
  // asserted in a comment: make the gate appear the way a single-page navigation into a live
  // room would, and confirm every rewritten rule comes back.
  const restoreCheck = await contents.executeJavaScript(`(() => {
    const guard = ${guardLoader()};
    const changed = window.__guardChanged;
    const before = changed.size;

    const gate = document.createElement('div');
    gate.setAttribute('data-e2e', 'feed-live');
    document.body.appendChild(gate);

    const restored = guard.restoreReachable({ doc: document, log: () => {}, changed });

    return { before, restored, remaining: changed.size, gateIsThere: document.querySelectorAll('[data-e2e="feed-live"]').length };
  })()`);

  const format = (value) => `${(value * 1000).toFixed(1)} ms`;

  console.log('');
  console.log('=== 样式重算代价探针（同一渲染器会话内 A/B）===');
  console.log(`页面：${ELEMENTS} 条评论行，${blockCount} 个 addStyle 样式块 + ${gatedCount} 条 feed-live 门控规则`);
  console.log(`每阶段强制 ${ROUNDS} 次重算`);
  console.log('');
  console.log(`守卫前：${format(baseline.duration)}  /  ${baseline.count} 次重算`);
  console.log(`守卫后：${format(after.duration)}  /  ${after.count} 次重算`);
  console.log('');
  const ratio = after.duration > 0 ? baseline.duration / after.duration : Infinity;
  console.log(`降低：${(100 * (1 - after.duration / (baseline.duration || 1))).toFixed(1)}%（${ratio.toFixed(1)}x）`);
  console.log(`重算次数：${baseline.count} -> ${after.count}（次数不变，变的是每次重算的单价）`);
  console.log('');
  console.log(`移除分支：${sweepResult.removed} 段，涉及 ${sweepResult.rules} 条规则`);
  console.log(`其中 feed-live 门控：${sweepResult.liveGates} 段`);
  console.log(`扫描成本：${sweepResult.elapsed.toFixed(1)} ms（每个样式表一次，不在每帧路径上）`);
  console.log('被判定为不可达的最左选择器（全部）：');
  for (const gate of sweepResult.gates) console.log(`  - ${gate}`);
  console.log('  说明：探针页面的 DOM 是推荐页的近似，不是真实页面的快照。其中属于直播、竖屏');
  console.log('  或其他页面形态的选择器在真实推荐页上同样不存在；若某条其实存在，真实移除量会更少。');
  console.log('');
  console.log('可逆性：');
  console.log(`  加入 [data-e2e="feed-live"] 后，恢复 ${restoreCheck.restored}/${restoreCheck.before} 条规则`
    + `（剩余待观察 ${restoreCheck.remaining}，页面上的门控数 ${restoreCheck.gateIsThere}）`);
  console.log(`  规则是改写而非删除，层叠顺序不受影响`);

  fs.rmSync(pagePath, { force: true });
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
