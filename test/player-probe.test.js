'use strict';

// The recorder that runs while the user watches, so the two things worth pinning down are
// that it reports what it claims to report, and that it does not flood the log: a probe that
// writes one line per hover event is unreadable exactly when it is needed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { installPlayerProbe, signatureOf, snapshot } = require('../app/diagnostics/player-probe');

/** A document small enough to reason about, shaped like the parts the probe touches. */
function fakePage(options = {}) {
  const video = options.noVideo ? null : {
    tagName: 'VIDEO',
    videoWidth: options.intrinsic ? options.intrinsic[0] : 1080,
    videoHeight: options.intrinsic ? options.intrinsic[1] : 1920,
    paused: false,
    className: '',
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1000, height: 600 }),
    closest: () => ({
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 1000, height: 600 }),
      className: 'xg-video-container',
    }),
    querySelector: () => null,
  };

  const backdropImage = {
    naturalWidth: 360,
    naturalHeight: 640,
    complete: true,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1000, height: 600 }),
  };
  const backdrop = {
    className: options.backdropClass || 'imgBackground',
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1000, height: 600 }),
    querySelector: () => backdropImage,
  };

  const listeners = new Map();
  const view = {
    innerWidth: 1000,
    innerHeight: 600,
    location: { pathname: '/video/123' },
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    requestAnimationFrame: (fn) => { fn(); return 1; },
    getComputedStyle: (element) => element.__style || { display: 'block', filter: 'none', opacity: '0', bottom: '48px', objectFit: 'contain' },
  };

  const doc = {
    defaultView: view,
    fullscreenElement: options.fullscreen ? { className: 'xgplayer xgplayer-is-fullscreen' } : null,
    elementFromPoint: () => video,
    querySelector: (selector) => {
      if (selector === '.isCssFullScreen') return options.cssFull ? { className: 'isCssFullScreen' } : null;
      return null;
    },
    querySelectorAll: (selector) => {
      if (selector === 'video') return video ? [video] : [];
      if (selector === '.imgBackground') return options.noBackdrop ? [] : [backdrop];
      return [];
    },
    __listeners: listeners,
  };

  backdropImage.__style = { display: options.backdropImageDisplay || 'block', filter: 'none' };
  return doc;
}

test('同样的画面只算一条：签名忽略时间与触发原因', () => {
  const page = fakePage();
  const a = snapshot(page, { reason: 'heartbeat', elapsedMs: 100 });
  const b = snapshot(page, { reason: 'hover', elapsedMs: 9000 });

  assert.equal(signatureOf(a), signatureOf(b));
});

test('画面真的变了，签名就不同', () => {
  const plain = snapshot(fakePage(), { reason: 'heartbeat' });
  const hidden = snapshot(fakePage({ backdropImageDisplay: 'none' }), { reason: 'heartbeat' });
  const portrait = snapshot(fakePage({ intrinsic: [1080, 1920] }), { reason: 'heartbeat' });
  const landscape = snapshot(fakePage({ intrinsic: [1920, 1080] }), { reason: 'heartbeat' });

  assert.notEqual(signatureOf(plain), signatureOf(hidden), '背景图显隐要能区分');
  assert.notEqual(signatureOf(portrait), signatureOf(landscape), '视频分辨率要能区分');
});

test('快照记录背景层的存在、类名和图片显隐', () => {
  const hidden = snapshot(fakePage({ backdropClass: 'hiddenImgbackgroundPlugin imgBackground', backdropImageDisplay: 'none' }), {});
  assert.equal(hidden.backdrop.present, true);
  assert.match(hidden.backdrop.className, /hiddenImgbackgroundPlugin/);
  assert.equal(hidden.backdrop.image.display, 'none');

  const missing = snapshot(fakePage({ noBackdrop: true }), {});
  assert.equal(missing.backdrop.present, false);
});

test('页面里没有播放器时不抛错，只留空字段', () => {
  const sample = snapshot(fakePage({ noVideo: true }), { reason: 'start' });
  assert.equal(sample.player.video, null);
  assert.equal(sample.player.intrinsic, null);
  assert.deepEqual(sample.viewport, [1000, 600]);
});

test('连续相同状态只上报一次，摘掉之后不再上报', () => {
  const page = fakePage();
  const seen = [];
  const stop = installPlayerProbe({ doc: page, heartbeatMs: 5, onSample: (sample) => seen.push(sample.reason) });

  // start + the deduplicated heartbeats.
  assert.deepEqual(seen, ['start']);

  // A real change gets through.
  page.querySelectorAll = ((original) => (selector) => (
    selector === '.imgBackground' ? [] : original(selector)
  ))(page.querySelectorAll);
  page.__listeners.get('wheel')();
  assert.deepEqual(seen, ['start', 'wheel']);

  stop();
  const before = seen.length;
  page.__listeners.get('wheel')?.();
  assert.equal(seen.length, before, '摘掉之后不应再有条目');
});
