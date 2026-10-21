'use strict';

/**
 * What does subscribing to `console-message` actually cost?
 *
 * This is the last structural difference from the comparison every user makes - "Edge with the
 * same script is smooth". In Edge, a userscript's `console.log` lands in the page's console and
 * goes no further. Here, `main/window.js` attaches `page-diagnostics.js`, and **attaching a
 * `console-message` listener is what makes Chromium forward every console call from the renderer
 * to the browser process**. The handler then discards everything below warning level, because the
 * bundled userscript logs heavily at info level (338 `log.info` call sites).
 *
 * So the question is whether that discard happens early enough to be free, or whether the app pays
 * a cross-process round trip for messages it has already decided to throw away.
 *
 * Three phases, same window, same message volume:
 *
 *   - no listener        - what Edge effectively does;
 *   - a counting listener - isolates the forwarding cost from the handler's cost;
 *   - the app's own `attachPageDiagnostics`, with a stub log - the real configuration.
 *
 * The measurement is the **main process's own CPU time** (`process.cpuUsage`), because that is the
 * process the forwarding lands on. Renderer time is not the thing at stake here.
 *
 * Usage (the env prefix matters - `ELECTRON_RUN_AS_NODE` is set in agent shells and would make
 * Electron behave as plain Node):
 *
 *   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
 *     node_modules/electron/dist/electron.exe tools/inspect/console-forwarding-probe.js
 *
 * Options: --messages=N (per phase, default 20000), --level=info|warning (default info, which is
 * the level the app discards), --rounds=N (repetitions per phase, default 3).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const APP_ROOT = path.join(__dirname, '..', '..');
const DIAGNOSTICS_PATH = path.join(APP_ROOT, 'app', 'diagnostics', 'page-diagnostics.js');

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  if (!found) return fallback;
  const parsed = Number(found.slice(prefix.length));
  return Number.isFinite(parsed) ? parsed : fallback;
}

const MESSAGES = argument('messages', 20000);
const ROUNDS = argument('rounds', 3);
const LEVEL = (process.argv.find((value) => value.startsWith('--level=')) || '').slice(8) || 'info';

/** The page, with an emitter so the volume is exactly controlled. */
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>console forwarding probe</title></head>
<body style="margin:0;background:#101418;color:#e8e8e8;font:16px monospace;padding:20px">
<div id="out">ready</div>
<script>
  window.__emit = function (count) {
    var level = ${JSON.stringify(LEVEL)};
    var write = level === 'warning' ? console.warn : console.info;
    for (var i = 0; i < count; i += 1) {
      // Distinct messages, and long enough to look like the real ones: the cost of marshalling a
      // string across the process boundary depends on its size, and a probe that sends "1" would
      // understate it.
      write('probe message #' + i + ' 来源 https://www.douyin.com/aweme/v1/web/feed/?count=10');
    }
    return count;
  };
</script>
</body>
</html>`;

async function main() {
  const pagePath = path.join(os.tmpdir(), `console-forwarding-probe-${process.pid}.html`);
  fs.writeFileSync(pagePath, PAGE, 'utf8');

  const window = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  const contents = window.webContents;
  await contents.loadFile(pagePath);

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Main-process CPU spent while `count` messages are emitted, plus how many arrived. */
  const measure = async (label, count, attach) => {
    const detach = attach ? attach() : null;
    const cpuBefore = process.cpuUsage();
    const start = process.hrtime.bigint();
    await contents.executeJavaScript(`window.__emit(${count})`);
    // The forwarding is asynchronous; a short drain keeps its cost inside the measured window
    // rather than charging it to the next phase.
    await wait(400);
    const cpu = process.cpuUsage(cpuBefore);
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (detach) detach();
    return { label, userMs: cpu.user / 1000, systemMs: cpu.system / 1000, wallMs };
  };

  const phases = [
    {
      label: '不订阅（相当于 Edge 的行为）',
      attach: null,
    },
    {
      label: '订阅并只计数（隔离转发本身的开销）',
      attach: () => {
        let received = 0;
        const onConsole = () => { received += 1; };
        contents.on('console-message', onConsole);
        return () => { contents.removeListener('console-message', onConsole); };
      },
    },
    {
      label: '应用的 attachPageDiagnostics（真实配置，日志用桩）',
      attach: () => {
        const { attachPageDiagnostics } = require(DIAGNOSTICS_PATH);
        const stub = { info() {}, warn() {}, error() {}, success() {}, debug() {} };
        return attachPageDiagnostics(contents, stub);
      },
    },
  ];

  const results = [];
  for (const phase of phases) {
    // Warm up once, because the first pass through the emit path pays for JIT in the renderer and
    // for whatever the browser process sets up on the first forwarded message.
    await measure(phase.label, Math.round(MESSAGES / 4), phase.attach);
    const samples = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      samples.push(await measure(phase.label, MESSAGES, phase.attach));
    }
    const median = (key) => {
      const sorted = samples.map((sample) => sample[key]).sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    results.push({ label: phase.label, userMs: median('userMs'), systemMs: median('systemMs') });
  }

  const pad = (text, width) => String(text).padEnd(width);
  const baseline = results[0];

  console.log('');
  console.log(`=== console 转发开销探针（主进程 CPU，${MESSAGES} 条/轮，${ROUNDS} 轮取中位数）===`);
  console.log(`消息级别：${LEVEL}${LEVEL === 'info' ? '（应用会直接丢弃这一级）' : ''}`);
  console.log('');
  console.log(`${pad('配置', 46)} ${pad('user ms', 10)} ${pad('sys ms', 10)} 相对基线`);
  for (const row of results) {
    const delta = row.userMs - baseline.userMs;
    const per1000 = (delta / MESSAGES) * 1000;
    console.log(`${pad(row.label, 46)} ${pad(row.userMs.toFixed(1), 10)} `
      + `${pad(row.systemMs.toFixed(1), 10)} ${delta === 0 ? '(基线)' : `+${delta.toFixed(1)} ms（每千条 ${per1000.toFixed(2)} ms）`}`);
  }
  console.log('');
  console.log('读法：主进程 CPU 才是这条路径的落点；渲染进程的时间不在这个表里。');
  console.log('如果"订阅并只计数"与"真实配置"几乎相同，说明代价全在跨进程转发，');
  console.log('而丢弃 info 级这件事省不下它 —— 消息已经跨过进程边界了。');
  console.log('');
  console.log('已知局限：三个阶段是**顺序**跑的，没有交替，所以"真实配置"比"只计数"便宜这件事');
  console.log('不能当作结论 —— 那是顺序漂移（与 wait-observer-probe.js 第一版同类的问题）。');
  console.log('量级本身才是可用的信息：每千条约 8–13 µs/条，且不订阅时 Chromium 自己也要花约 15 µs/条。');

  fs.rmSync(pagePath, { force: true });
  app.quit();
}

app.whenReady().then(main).catch((error) => {
  console.error('探针失败', error);
  app.exit(1);
});
