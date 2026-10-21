'use strict';

// Unit coverage for the diagnostics log.
//
// Two things here are load-bearing rather than cosmetic:
//
//  - rotation, because a log that rotates away in an hour is no use for a failure
//    that shows up after a few;
//  - collapsing repeated console messages, because the site emits the same CSP
//    warning constantly and it would otherwise drown everything else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { HARD_LIMIT_MULTIPLE, createLogFile, dateKey } = require('../app/diagnostics/log-file');
const {
  attachPageDiagnostics,
  isLoggableNavigation,
  normalizeForDedupe,
} = require('../app/diagnostics/page-diagnostics');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dy-log-${name}-`));
}

/** A stand-in for Electron's WebContents, which is just an event emitter here. */
class FakeContents extends EventEmitter {
  constructor(url = 'https://www.douyin.com/') {
    super();
    this.url = url;
  }

  getURL() { return this.url; }

  isDestroyed() { return false; }
}

/** Capture the console output the logger mirrors, instead of printing it. */
function quiet(run) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { lines, value: run() };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}


/**
 * Remove a test's temp directory, tolerating a failure to do so.
 *
 * Cleanup says nothing about the code under test. In a sandboxed environment the delete can
 * be refused outright - a safe-delete shim failing with `ENOTEMPTY` - which showed up as
 * random failures in unrelated tests. No assertion is weakened by this.
 */
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not a test failure.
  }
}

test('a log line carries a timestamp, a level and the JSON payload', () => {
  const dir = tempDir('format');
  const log = quiet(() => createLogFile({ dir })).value;

  log.info('开始导航', { url: 'https://www.douyin.com/' });

  const content = fs.readFileSync(log.path, 'utf8');
  assert.match(content, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[info\] 开始导航 /);
  assert.match(content, /"url":"https:\/\/www\.douyin\.com\/"/);
  cleanup(dir);
});

test('the log directory is created if it does not exist', () => {
  const dir = path.join(tempDir('mkdir'), 'nested', 'logs');
  assert.equal(fs.existsSync(dir), false);
  const log = quiet(() => createLogFile({ dir })).value;
  log.info('启动');
  assert.equal(fs.existsSync(log.path), true);
  cleanup(path.dirname(path.dirname(dir)));
});

test('rotation keeps the configured number of previous files', () => {
  const dir = tempDir('rotate');
  // Tiny limit so a couple of lines trip it.
  // Small enough that every single write trips the limit: relying on an exact byte
  // boundary made this flaky.
  const log = quiet(() => createLogFile({ dir, maxBytes: 10, keep: 2 })).value;

  for (const marker of ['first', 'second', 'third', 'fourth', 'fifth']) {
    log.info(marker, { padding: 'x'.repeat(40) });
  }

  assert.equal(fs.existsSync(log.rotatedPath(1)), true, 'one rotated file expected');
  assert.equal(fs.existsSync(log.rotatedPath(2)), true, 'two rotated files expected');
  // Never more than `keep`, however long it runs.
  assert.equal(fs.existsSync(log.rotatedPath(3)), false);
  cleanup(dir);
});

test('navigations and load failures are recorded', () => {
  const dir = tempDir('nav');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();

  attachPageDiagnostics(contents, log, { dedupeMs: 0 });
  contents.emit('did-start-navigation', {}, 'https://www.douyin.com/', false, true);
  contents.emit('did-start-navigation', {}, 'https://sub.frame/', false, false); // subframe: ignored
  contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://www.douyin.com/', true);
  contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://www.douyin.com/', true); // routine

  const content = fs.readFileSync(log.path, 'utf8');
  assert.match(content, /开始导航 .*"url":"https:\/\/www\.douyin\.com\/"/);
  assert.equal(content.includes('https://sub.frame/'), false, 'subframes must not be logged');
  assert.match(content, /页面加载失败 .*ERR_NAME_NOT_RESOLVED/);
  assert.equal(content.includes('ERR_ABORTED'), false, 'ERR_ABORTED is routine noise');
  cleanup(dir);
});

test('repeated console messages are collapsed instead of flooding the log', () => {
  const dir = tempDir('dedupe');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();

  attachPageDiagnostics(contents, log, { dedupeMs: 60000 });
  // A neutral message: the ones the site actually spams (CSP, playPromise, the APM SDK) are
  // filtered as noise before dedupe ever sees them - see the noise test below.
  const repeated = '播放器状态更新失败';
  for (let i = 0; i < 12; i += 1) {
    contents.emit('console-message', {}, { level: 3, message: repeated, lineNumber: 0, sourceId: 'https://www.douyin.com/' });
  }
  // A different message must still get through immediately.
  contents.emit('console-message', {}, { level: 3, message: 'something new', lineNumber: 9, sourceId: 'https://www.douyin.com/' });

  const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, `expected 2 lines, got:\n${lines.join('\n')}`);
  assert.match(lines[0], /播放器状态更新失败/);
  assert.match(lines[1], /something new/);
  cleanup(dir);
});

test('the same message from different scripts is still the same message', () => {
  // Measured on the real site: the same warning is reported once per offending script,
  // so keying on message *and* source produced nine log lines for one problem.
  const dir = tempDir('dedupe-source');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();

  attachPageDiagnostics(contents, log, { dedupeMs: 60000 });
  const repeated = '播放器状态更新失败';
  for (const source of [
    'https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/',
    'https://www.douyin.com/',
    'https://lf-cdn-tos.bytescm.com/obj/rc-verifycenter/rmc-nocaptcha/setup.js',
    '',
  ]) {
    contents.emit('console-message', {}, { level: 3, message: repeated, lineNumber: 0, sourceId: source });
  }

  const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, `expected 1 line, got:\n${lines.join('\n')}`);
  cleanup(dir);
});

test('messages that differ only by an embedded id are treated as repeats', () => {
  // A message carrying an id looks brand new on every occurrence unless the digits are
  // normalised away. (`[SDK] <epoch-ms> already inited` is the real-world case, but that
  // one is filtered as noise before it gets here.)
  const dir = tempDir('dedupe-id');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();

  attachPageDiagnostics(contents, log, { dedupeMs: 60000 });
  for (const id of [1789912126867, 1789912999999, 1789913000123]) {
    contents.emit('console-message', {}, {
      level: 2, message: `视频 ${id} 预加载失败`, lineNumber: 0, sourceId: 'https://www.douyin.com/',
    });
  }

  const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, `expected 1 line, got:\n${lines.join('\n')}`);
  // The written line keeps the real message, not the normalised key.
  assert.match(lines[0], /1789912126867/);
  cleanup(dir);
});

test('normalisation only collapses long digit runs', () => {
  assert.equal(normalizeForDedupe('already inited'), 'already inited');
  assert.equal(normalizeForDedupe('[SDK] 1789912126867 0 already inited'), '[SDK] # 0 already inited');
  // Short numbers are meaningful and must survive.
  assert.equal(normalizeForDedupe('HTTP 404 on /aweme/v1/web/feed'), 'HTTP 404 on /aweme/v1/web/feed');
});

test('a repeat that outlives the window is logged again with the count it hid', async () => {
  const dir = tempDir('dedupe-window');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();

  // A deliberately tiny window, so the second half of the behaviour is exercised
  // without a real minute-long wait. The sleep is four times the window.
  attachPageDiagnostics(contents, log, { dedupeMs: 40 });
  const emit = () => contents.emit('console-message', {}, {
    level: 2, message: 'same', lineNumber: 1, sourceId: 'src',
  });

  emit();          // first sighting: logged
  emit();          // suppressed
  emit();          // suppressed
  await new Promise((resolve) => setTimeout(resolve, 150));
  emit();          // outlived the window: logged, reporting what it hid

  const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, `expected 2 lines, got:\n${lines.join('\n')}`);
  assert.equal(lines[0].includes('suppressedSinceLast'), false);
  assert.match(lines[1], /"suppressedSinceLast":2/);
  cleanup(dir);
});

test('info-level console output is not captured', () => {
  // The bundled userscript logs heavily at info level; capturing it would make the
  // file useless within minutes.
  const dir = tempDir('level');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();

  attachPageDiagnostics(contents, log, { dedupeMs: 0 });
  contents.emit('console-message', {}, { level: 1, message: '抖音优化 log.info', lineNumber: 1, sourceId: 'src' });
  contents.emit('console-message', {}, { level: 0, message: 'verbose', lineNumber: 1, sourceId: 'src' });

  assert.equal(fs.existsSync(log.path), false, 'no lines expected for info/verbose');
  cleanup(dir);
});

test('only real web navigations are worth a log line', () => {
  // The loading document in main/window.js is a data: URL running to several kilobytes -
  // the logo is inlined - so logging it would dump that whole string into the file on every
  // launch, once for the start and once for the finish.
  assert.equal(isLoggableNavigation('data:text/html;charset=utf-8,%3C!doctype'), false);
  assert.equal(isLoggableNavigation('about:blank'), false);
  assert.equal(isLoggableNavigation('file:///C:/app/index.html'), false);
  assert.equal(isLoggableNavigation(''), false);
  assert.equal(isLoggableNavigation(undefined), false);
  assert.equal(isLoggableNavigation('https://www.douyin.com/'), true);
  assert.equal(isLoggableNavigation('http://127.0.0.1:8080/'), true);
});

test('the loading document never reaches the log, but the page after it does', () => {
  const dir = tempDir('splash');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents('data:text/html;charset=utf-8,%3C!doctype');

  attachPageDiagnostics(contents, log, { dedupeMs: 0 });
  contents.emit('did-start-navigation', {}, 'data:text/html;charset=utf-8,%3C!doctype', false, true);
  contents.emit('did-finish-load');
  assert.equal(fs.existsSync(log.path), false, 'a data: URL must not be written');

  contents.url = 'https://www.douyin.com/';
  contents.emit('did-start-navigation', {}, 'https://www.douyin.com/', false, true);
  const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /开始导航/);
  assert.match(lines[0], /douyin\.com/);
  cleanup(dir);
});

test('the log stays bounded even when rotation cannot happen', () => {
  // The realistic way to get here: the menu item opens the log in an editor, and Windows
  // refuses to rename a file another process holds open. Rotation then silently does nothing
  // on every write, and "2 MB cap" stops being a cap.
  //
  // Forced by making the second rotated file a non-empty directory: the rotation loop tries to
  // remove it before renaming the first one over it, and removing a directory that way throws.
  const dir = tempDir('ceiling');
  const maxBytes = 1024;
  const hardLimit = maxBytes * HARD_LIMIT_MULTIPLE;
  const key = dateKey();
  try {
    fs.writeFileSync(path.join(dir, `main-${key}.1.log`), 'older', 'utf8');
    fs.mkdirSync(path.join(dir, `main-${key}.2.log`));
    fs.writeFileSync(path.join(dir, `main-${key}.2.log`, 'keep'), 'not empty', 'utf8');

    // Bigger than the ceiling before the first write even happens.
    fs.writeFileSync(path.join(dir, `main-${key}.log`), 'x'.repeat(hardLimit + 2048), 'utf8');

    const log = quiet(() => createLogFile({ dir, maxBytes, keep: 2 })).value;
    log.info('after the ceiling');

    const size = fs.statSync(log.path).size;
    assert.ok(size < hardLimit, `expected under ${hardLimit} bytes, got ${size}`);
    assert.match(fs.readFileSync(log.path, 'utf8'), /已丢弃较早内容/, 'and says why the start is missing');

    // And it stays bounded however long it keeps running.
    for (let i = 0; i < 40; i += 1) log.info(`line ${i}`, { padding: 'y'.repeat(200) });
    assert.ok(fs.statSync(log.path).size < hardLimit, 'still bounded after more writes');
  } finally {
    cleanup(dir);
  }
});

test('日志按天分文件，文件名带日期', () => {
  const dir = tempDir('daily');
  const day = new Date(2026, 9, 21, 10, 0, 0);
  const log = quiet(() => createLogFile({ dir, now: () => day })).value;
  log.info('今天');

  assert.equal(path.basename(log.path), 'main-2026-10-21.log');
  assert.equal(fs.existsSync(log.path), true);

  // 跨天之后写到新文件里，旧文件不动。
  const nextDay = new Date(2026, 9, 22, 9, 0, 0);
  const log2 = quiet(() => createLogFile({ dir, now: () => nextDay })).value;
  log2.info('明天');

  assert.equal(fs.existsSync(path.join(dir, 'main-2026-10-21.log')), true);
  assert.equal(fs.existsSync(path.join(dir, 'main-2026-10-22.log')), true);
  cleanup(dir);
});

test('超过保留天数的日志会被删掉，近期的和别的文件不动', () => {
  const dir = tempDir('prune');
  const day = new Date(2026, 9, 21, 10, 0, 0);
  // 8 天前（超出 7 天）、7 天前（保留）、当天、以及一个不属于本模块的文件。
  for (const name of ['main-2026-10-13.log', 'main-2026-10-14.log', 'main-2026-10-13.1.log']) {
    fs.writeFileSync(path.join(dir, name), 'old', 'utf8');
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me', 'utf8');

  const log = quiet(() => createLogFile({ dir, now: () => day })).value;
  log.info('写一行就会触发清理');

  assert.equal(fs.existsSync(path.join(dir, 'main-2026-10-13.log')), false, '8 天前的要删');
  assert.equal(fs.existsSync(path.join(dir, 'main-2026-10-13.1.log')), false, '轮转出来的同一天也要删');
  assert.equal(fs.existsSync(path.join(dir, 'main-2026-10-14.log')), true, '7 天内的留着');
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true, '不认识的文件不碰');
  cleanup(dir);
});

test('站点自己的控制台噪音不进日志，我们自己的消息照记', () => {
  const dir = tempDir('noise');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();
  attachPageDiagnostics(contents, log, { dedupeMs: 0 });

  const noise = [
    "The Content Security Policy directive 'upgrade-insecure-requests' is ignored",
    '%c[xgplayer] >>>>playPromise.catch AbortError',
    '[SDK] 1789912126867        0 already inited',
    "Uncaught TypeError: Cannot read properties of null (reading 'definition')",
    'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT',
  ];
  for (const message of noise) {
    contents.emit('console-message', {}, { level: 3, message, lineNumber: 1, sourceId: 'https://www.douyin.com/' });
  }
  // Our own guard messages must survive the filter: they are the log's diagnostics.
  contents.emit('console-message', {}, {
    level: 2, message: '[抖音] 已移除会隐藏视频的样式规则', lineNumber: 1, sourceId: 'app/preload/index.js',
  });

  const text = fs.readFileSync(log.path, 'utf8');
  assert.equal(text.includes('Content Security Policy'), false);
  assert.equal(text.includes('playPromise'), false);
  assert.equal(text.includes('already inited'), false);
  assert.equal(text.includes('reading \'definition\''), false);
  assert.equal(text.includes('ERR_BLOCKED_BY_CLIENT'), false);
  assert.match(text, /已移除会隐藏视频的样式规则/);
  cleanup(dir);
});

test('同文档导航（切视频）不写导航日志', () => {
  const dir = tempDir('inplace');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();
  attachPageDiagnostics(contents, log, { dedupeMs: 0 });

  for (let i = 0; i < 20; i += 1) {
    contents.emit('did-start-navigation', {}, 'https://www.douyin.com/', true, true);
  }
  contents.emit('did-start-navigation', {}, 'https://www.douyin.com/video/123', false, true);

  const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `只应有真实加载那一条：\n${lines.join('\n')}`);
  assert.match(lines[0], /video\/123/);
  cleanup(dir);
});
