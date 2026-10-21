'use strict';

/**
 * Does this app stop producing frames when its window is covered?
 *
 * This settles a question the project left open on purpose. `backgroundThrottling: false` is
 * already set in `main/window.js`, and the note there says it exists because Chromium throttles
 * timers and requestAnimationFrame for windows it considers occluded. But that preference only
 * governs **JS-side throttling**. Windows' own occlusion detection is a separate thing, and while
 * it is active Chromium can stop producing frames entirely - so a video would keep decoding while
 * the picture stops updating.
 *
 * The earlier decision was to change nothing, on the grounds that a covered window not painting is
 * reasonable and that the flags would have been a guess. That decision was written down with the
 * experiment needed to overturn it: measure the same window while focused and while covered, and
 * see whether the native occlusion feature is what changes.
 *
 * So this probe measures one window across five states, in one process, and can be run twice -
 * once as-is and once with `--flag` - to show what the feature actually does:
 *
 *   focused  ->  half covered  ->  fully covered  ->  minimized  ->  restored
 *
 * What it counts:
 *
 *   - `requestAnimationFrame` ticks, i.e. **frames actually produced**;
 *   - a 16 ms `setInterval`, i.e. **timers still running** (this is what
 *     `backgroundThrottling: false` governs);
 *   - `document.visibilityState`, i.e. what Chromium told the page.
 *
 * The point of measuring both counters is that they separate the two mechanisms: timers stopping
 * means JS throttling, frames stopping while timers run means the compositor stopped.
 *
 * The cover window is a second frameless always-on-top window sized to the target. It is created
 * for the run and destroyed at the end, so this probe **does briefly cover the screen**.
 *
 * Usage (the env prefix matters - `ELECTRON_RUN_AS_NODE` is set in agent shells and would make
 * Electron behave as plain Node):
 *
 *   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
 *     node_modules/electron/dist/electron.exe tools/inspect/occlusion-probe.js
 *
 *   # and the same again with the candidate fix:
 *   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
 *     node_modules/electron/dist/electron.exe tools/inspect/occlusion-probe.js --flag
 *
 *   # and with Chromium's default throttling, to check what the app's preference actually buys:
 *   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
 *     node_modules/electron/dist/electron.exe tools/inspect/occlusion-probe.js --throttled
 *
 * Options: --phase-s=N (seconds per state, default 8), --settle-ms=N (after each transition,
 * default 700), --flag (disable the native occlusion feature), --throttled.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  if (!found) return fallback;
  const parsed = Number(found.slice(prefix.length));
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PHASE_S = argument('phase-s', 8);
const SETTLE_MS = argument('settle-ms', 700);
const WITH_FLAG = process.argv.includes('--flag');
/**
 * Create the target window with Chromium's default throttling instead of the app's preference.
 *
 * This is how the project's earlier note gets checked. That note - "a 2 s interval ticked 3x in
 * 30 s then stopped" - is about a window whose timers are being clamped, and `main/window.js`
 * deliberately turns that off. Running both ways says whether the note describes the app's window
 * or a probe window that did not carry the preference.
 */
const THROTTLED = process.argv.includes('--throttled');

/**
 * The value actually handed to `webPreferences`.
 *
 * Written out rather than inlined so the report and the window cannot disagree: an earlier version
 * printed one value in the header while passing the opposite to the window, which made two runs
 * with identical settings look like a comparison of two settings.
 */
const BACKGROUND_THROTTLING = THROTTLED;

const FEATURE = 'CalculateNativeWinOcclusion';

/**
 * The feature has to be switched off before the app is ready, so this happens at module scope.
 *
 * `appendSwitch` **replaces** the switch value rather than appending to it, so the value Electron
 * already set is read first and carried over. Dropping it would silently re-enable whatever
 * Electron disables by default, which would make this probe measure the wrong thing.
 */
if (WITH_FLAG) {
  const existing = app.commandLine.getSwitchValue('disable-features');
  const merged = existing ? `${existing},${FEATURE}` : FEATURE;
  app.commandLine.appendSwitch('disable-features', merged);
  console.log(`[flag] disable-features 原值：${existing || '(空)'}`);
  console.log(`[flag] disable-features 现值：${merged}`);
}

/** A page that counts frames and timers, and reports what Chromium told it. */
const TICK_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>occlusion probe</title></head>
<body style="margin:0;background:#101418;color:#e8e8e8;font:18px/1.6 monospace">
<div style="padding:24px">
  <div>遮挡探针</div>
  <div id="counts" style="font-size:28px"></div>
</div>
<script>
  window.__stats = { raf: 0, timer16: 0, timer200: 0, visibility: [] };
  (function frame() {
    window.__stats.raf += 1;
    requestAnimationFrame(frame);
  })();
  setInterval(function () { window.__stats.timer16 += 1; }, 16);
  // 200 ms, not 2 s: throttling clamps timers to a 1 s granularity, so a 2 s interval ticks at
  // 0.5/s whether or not it is clamped - it cannot tell the two apart. 200 ms is 5/s normally and
  // 1/s when clamped, which is the difference worth seeing.
  setInterval(function () { window.__stats.timer200 += 1; }, 200);
  document.addEventListener('visibilitychange', function () {
    window.__stats.visibility.push(document.visibilityState);
  });
  setInterval(function () {
    document.getElementById('counts').textContent =
      'raf ' + window.__stats.raf + '  16ms ' + window.__stats.timer16
      + '  200ms ' + window.__stats.timer200 + '  ' + document.visibilityState;
  }, 100);
</script>
</body>
</html>`;

async function main() {
  const pagePath = path.join(os.tmpdir(), `occlusion-probe-${process.pid}.html`);
  fs.writeFileSync(pagePath, TICK_PAGE, 'utf8');

  // The same web preferences as `main/window.js`, because the question is about this app.
  const target = new BrowserWindow({
    width: 1100,
    height: 720,
    x: 80,
    y: 80,
    title: 'occlusion probe (target)',
    backgroundColor: '#101418',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      backgroundThrottling: BACKGROUND_THROTTLING,
    },
  });

  await target.loadFile(pagePath);
  target.focus();

  const cover = new BrowserWindow({
    show: false,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await cover.loadURL('data:text/html,<body style="margin:0;background:%23000"></body>');

  // A small, focusable window used only to take focus away from the target. "Visible but not
  // focused" is the state a user is in whenever they click another window while the video plays,
  // and it is not the same as being covered.
  const focusStealer = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    frame: true,
    skipTaskbar: true,
    title: 'occlusion probe (focus stealer)',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await focusStealer.loadURL('data:text/html,<body style="margin:0;background:%23333"></body>');

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Sample once per second for the whole phase rather than reading a single total.
   *
   * A single total hides *when* something changed, and the first version of this probe reported
   * 180 fps for a fully covered window in one run and 0 fps in the next. The difference was the
   * phase length: native occlusion detection does not take effect instantly, so a short window
   * can finish before the state propagates. Per-second samples show the transition instead of
   * depending on where the window happened to land.
   */
  const measure = async (label, seconds) => {
    await target.webContents.executeJavaScript(
      'window.__stats.raf = 0; window.__stats.timer16 = 0; window.__stats.timer200 = 0;'
      + ' window.__stats.visibility = []; void 0',
    );
    const series = [];
    let previous = { raf: 0, timer16: 0, timer200: 0 };
    for (let second = 0; second < seconds; second += 1) {
      await wait(1000);
      const now = await target.webContents.executeJavaScript(`({
        raf: window.__stats.raf,
        timer16: window.__stats.timer16,
        timer200: window.__stats.timer200,
        state: document.visibilityState,
        focused: document.hasFocus(),
        transitions: window.__stats.visibility.join(' -> '),
      })`);
      series.push({
        raf: now.raf - previous.raf,
        timer16: now.timer16 - previous.timer16,
        timer200: now.timer200 - previous.timer200,
        state: now.state,
      });
      previous = now;
      if (second === seconds - 1) {
        series[second].focused = now.focused;
        series[second].transitions = now.transitions;
      }
    }
    return { label, series };
  };

  const bounds = target.getBounds();
  const placeCover = (width, height) => {
    cover.setBounds({ x: bounds.x, y: bounds.y, width, height });
    cover.showInactive();
  };

  const results = [];

  // 1. Focused and fully visible - the baseline the user actually cares about.
  target.show();
  target.focus();
  await wait(SETTLE_MS);
  results.push(await measure('聚焦 · 完全可见', PHASE_S));

  // 2. Visible but not focused: another window took the keyboard.
  focusStealer.show();
  focusStealer.focus();
  await wait(SETTLE_MS);
  results.push(await measure('可见但未聚焦', PHASE_S));

  // 3. Partially covered. This is the interesting one: if Windows' detection is coarse, having
  //    any window overlap the app would be enough to stop its frames.
  focusStealer.hide();
  target.focus();
  await wait(SETTLE_MS);
  placeCover(Math.round(bounds.width * 0.6), bounds.height);
  await wait(SETTLE_MS);
  results.push(await measure('被遮住 60% 宽', PHASE_S));

  // 4. Fully covered.
  placeCover(bounds.width, bounds.height);
  await wait(SETTLE_MS);
  results.push(await measure('被完全遮住', PHASE_S));

  // 5. Minimized, as a control: this is unambiguous occlusion, and it tells us whether the
  //    measurement apparatus can see the effect at all.
  cover.hide();
  target.minimize();
  await wait(SETTLE_MS);
  results.push(await measure('最小化', PHASE_S));

  // 6. Restored, to confirm the window comes back and the counters resume.
  target.restore();
  target.show();
  target.focus();
  await wait(SETTLE_MS);
  results.push(await measure('恢复并聚焦', PHASE_S));

  const pad = (text, width) => String(text).padEnd(width);
  const series = (row, key) => row.series.map((sample) => String(sample[key]).padStart(4)).join('');
  const states = (row) => [...new Set(row.series.map((sample) => sample.state))].join('/');
  const last = (row) => row.series[row.series.length - 1];

  console.log('');
  const throttleLabel = THROTTLED ? 'Chromium 默认' : '本应用的设置';
  console.log(`=== 遮挡与停帧探针${WITH_FLAG ? `（已关掉 ${FEATURE}）` : '（默认特性）'}`
    + ` · backgroundThrottling: ${BACKGROUND_THROTTLING}（${throttleLabel}） ===`);
  console.log(`每阶段 ${PHASE_S} 秒，逐秒采样（每秒一格）；切换后等 ${SETTLE_MS} ms 再开始`);
  console.log('');
  console.log('每秒产出的帧数（rAF）—— 掉到 0 就是画面停住：');
  for (const row of results) {
    console.log(`  ${pad(row.label, 18)}${series(row, 'raf')}   ${states(row)}`);
  }
  console.log('');
  console.log('每秒触发的 16 ms 定时器 —— 正常 63，被钳制约 1–2，0 就是完全停摆：');
  for (const row of results) {
    console.log(`  ${pad(row.label, 18)}${series(row, 'timer16')}   hasFocus ${last(row).focused}`
      + `  变化 ${last(row).transitions || '(无)'}`);
  }
  console.log('');
  console.log('读法：');
  console.log('  rAF 掉到 0 而定时器还在 = 合成器停帧，解码可能仍在继续（画面冻住）。');
  console.log('  定时器掉到 1–2 = JS 侧被节流；两者一起掉 = 整个渲染进程被当成后台。');
  console.log('  逐秒采样是为了看**什么时候**开始掉 —— 原生遮挡检测有传播延迟，');
  console.log('  短窗口会在状态生效之前就结束（本探针第一版就因此两次给出相反的结果）。');

  focusStealer.destroy();
  cover.destroy();
  fs.rmSync(pagePath, { force: true });
  app.quit();
}

app.whenReady().then(main).catch((error) => {
  console.error('探针失败', error);
  app.exit(1);
});
