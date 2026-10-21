'use strict';

/**
 * Record what the player looks like while the user is watching.
 *
 * This exists because a visual bug ("the blurred background disappears") cannot be settled
 * from a screenshot: the layer that paints it is chosen by the site at runtime, and the
 * element that is responsible is not the one that looks responsible. The only reliable
 * evidence is a series of snapshots taken *while it happens*, in the user's own window.
 *
 * So this is a recorder, not a fix. It is off by default and costs nothing until switched
 * on from 工具 → 记录播放器诊断: while it runs it samples on the events that matter
 * (fullscreen, video switch, pointer entering/leaving the player) plus a slow heartbeat,
 * and only when the snapshot actually differs from the previous one. A run that scrolls
 * through twenty videos produces tens of lines, not thousands.
 *
 * No `electron` import: the preload runs in the renderer and this module is unit tested
 * against a fake document.
 */

/** How often to look while nothing is happening. */
const HEARTBEAT_MS = 1000;

/** Stop after this many entries so a forgotten switch cannot fill the log. */
const MAX_ENTRIES = 600;

/**
 * The fields that make two snapshots "the same".
 *
 * Deliberately excludes the timestamps and the reason: those differ on every sample and
 * would defeat the deduplication that keeps the log readable.
 *
 * @param {object} sample
 * @returns {string}
 */
function signatureOf(sample) {
  if (!sample) return '';
  const player = sample.player || {};
  const backdrop = sample.backdrop || {};
  return JSON.stringify([
    player.fullscreen,
    player.video,
    // The intrinsic size belongs in the signature: a switch from a landscape to a portrait
    // video leaves every box the same and is precisely the change worth recording.
    player.intrinsic,
    player.fit,
    player.paused,
    player.container,
    player.containerBottom,
    player.controls,
    backdrop.present,
    backdrop.className,
    backdrop.image,
    sample.atLeft,
    sample.atRight,
  ]);
}

/** A short, stable description of a class list, without the hashed noise. */
function classOf(element) {
  if (!element) return null;
  const raw = typeof element.className === 'string' ? element.className : '';
  return raw.trim().slice(0, 120) || null;
}

/** `[x, y, width, height]`, rounded - sub-pixel values are noise here. */
function rectOf(element) {
  if (!element || typeof element.getBoundingClientRect !== 'function') return null;
  const box = element.getBoundingClientRect();
  return [box.x, box.y, box.width, box.height].map((value) => Math.round(value));
}

/**
 * What is painted at a point, as `tag.class`.
 *
 * `elementFromPoint` answers "what would receive a click here", which is the closest a page
 * can get to "what is on top" - and that is exactly the question behind the black bars.
 */
function describeAt(doc, x, y) {
  try {
    const element = doc.elementFromPoint(x, y);
    if (!element) return null;
    const cls = classOf(element);
    return cls ? `${element.tagName.toLowerCase()}.${cls.split(/\s+/)[0]}` : element.tagName.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Take one snapshot of the player.
 *
 * Everything is defensive: the site re-renders constantly and a probe that throws while the
 * user is watching is worse than no probe at all.
 *
 * @param {Document} doc
 * @param {object} [options]
 * @param {string} [options.reason]
 * @param {number} [options.elapsedMs]
 * @param {unknown} [options.immersiveMode]
 */
function snapshot(doc, options = {}) {
  const view = doc.defaultView || globalThis;
  const width = Number(view.innerWidth) || 0;
  const height = Number(view.innerHeight) || 0;

  // The video the user is actually looking at: the topmost element at the centre of the
  // page, not the first <video> in the document. Douyin keeps several stacked.
  let video = null;
  try {
    const centre = doc.elementFromPoint(width / 2, height / 2);
    video = centre && (centre.tagName === 'VIDEO' ? centre : centre.querySelector('video'));
  } catch {
    video = null;
  }
  if (!video) {
    try {
      video = Array.from(doc.querySelectorAll('video')).find((item) => item.videoWidth > 0) || null;
    } catch {
      video = null;
    }
  }

  const videoStyle = video ? view.getComputedStyle(video) : null;
  const container = video && video.closest ? video.closest('xg-video-container') : null;
  const containerStyle = container ? view.getComputedStyle(container) : null;

  // The layer that fills the sides when the video does not match the screen.
  let backdrop = { present: false };
  try {
    const box = Array.from(doc.querySelectorAll('.imgBackground'))
      .find((element) => rectOf(element) && rectOf(element)[3] > 0);
    if (box) {
      const image = box.querySelector('img');
      backdrop = {
        present: true,
        className: classOf(box),
        image: image ? {
          display: view.getComputedStyle(image).display,
          filter: view.getComputedStyle(image).filter,
          natural: [image.naturalWidth, image.naturalHeight],
          complete: image.complete,
        } : null,
      };
    }
  } catch {
    backdrop = { present: false, error: 'query failed' };
  }

  const controlOpacity = (selector) => {
    try {
      const element = doc.querySelector(selector);
      return element ? view.getComputedStyle(element).opacity : null;
    } catch {
      return null;
    }
  };

  return {
    reason: options.reason || 'heartbeat',
    atMs: Math.round(Number(options.elapsedMs) || 0),
    url: String(view.location && view.location.pathname || ''),
    viewport: [width, height],
    immersiveMode: options.immersiveMode === undefined ? null : options.immersiveMode,
    player: {
      fullscreen: Boolean(doc.fullscreenElement),
      fullscreenOn: classOf(doc.fullscreenElement),
      cssFull: Boolean(doc.querySelector('.isCssFullScreen')),
      xgFull: Boolean(doc.querySelector('.xgplayer-is-fullscreen')),
      video: video ? rectOf(video) : null,
      intrinsic: video ? [video.videoWidth, video.videoHeight] : null,
      fit: videoStyle ? videoStyle.objectFit : null,
      paused: video ? Boolean(video.paused) : null,
      container: container ? rectOf(container) : null,
      containerBottom: containerStyle ? containerStyle.bottom : null,
      controls: {
        infoWrap: controlOpacity('#video-info-wrap'),
        toolbar: controlOpacity('.positionBox'),
        xgControls: controlOpacity('xg-controls.xgplayer-controls'),
      },
    },
    backdrop,
    atLeft: describeAt(doc, Math.round(width * 0.04), Math.round(height / 2)),
    atRight: describeAt(doc, Math.round(width * 0.96), Math.round(height / 2)),
  };
}

/**
 * Watch the player and report snapshots that differ from the previous one.
 *
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {(sample: object) => void} [options.onSample]
 * @param {number} [options.heartbeatMs]
 * @param {number} [options.maxEntries]
 * @param {() => unknown} [options.readImmersiveMode] the script setting, read lazily
 * @returns {() => void} detaches
 */
function installPlayerProbe(options = {}) {
  const doc = options.doc || document;
  const view = doc.defaultView || globalThis;
  const onSample = typeof options.onSample === 'function' ? options.onSample : () => {};
  const heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : HEARTBEAT_MS;
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : MAX_ENTRIES;
  const readMode = typeof options.readImmersiveMode === 'function' ? options.readImmersiveMode : () => null;

  const startedAt = Date.now();
  let stopped = false;
  let lastSignature = null;
  let entries = 0;
  let timer = null;
  let pending = null;

  const emit = (reason) => {
    if (stopped) return;
    if (entries >= maxEntries) {
      stopped = true;
      onSample({ reason: 'stopped', atMs: Date.now() - startedAt, note: `已达到 ${maxEntries} 条上限，请关闭开关` });
      return;
    }
    let sample;
    try {
      sample = snapshot(doc, {
        reason,
        elapsedMs: Date.now() - startedAt,
        immersiveMode: readMode(),
      });
    } catch (error) {
      onSample({ reason: 'error', atMs: Date.now() - startedAt, error: String((error && error.message) || error) });
      return;
    }
    const signature = signatureOf(sample);
    if (signature === lastSignature && reason !== 'start' && reason !== 'stop') return;
    lastSignature = signature;
    entries += 1;
    onSample(sample);
  };

  /** Events arrive in bursts (hover fires per element); one sample per frame is enough. */
  const schedule = (reason) => {
    if (stopped || pending) return;
    pending = (view.requestAnimationFrame || ((fn) => setTimeout(fn, 16)))(() => {
      pending = null;
      emit(reason);
    });
  };

  const listeners = [
    ['fullscreenchange', () => schedule('fullscreen')],
    ['webkitfullscreenchange', () => schedule('fullscreen')],
    ['wheel', () => schedule('wheel')],
    ['mouseover', () => schedule('hover')],
    ['mouseout', () => schedule('hover')],
  ];
  for (const [type, handler] of listeners) {
    view.addEventListener(type, handler, { capture: true, passive: true });
  }

  timer = setInterval(() => emit('heartbeat'), heartbeatMs);
  if (timer.unref) timer.unref();

  emit('start');

  return () => {
    if (stopped) return;
    emit('stop');
    stopped = true;
    clearInterval(timer);
    timer = null;
    if (pending && view.cancelAnimationFrame) view.cancelAnimationFrame(pending);
    pending = null;
    for (const [type, handler] of listeners) {
      view.removeEventListener(type, handler, { capture: true });
    }
  };
}

module.exports = {
  HEARTBEAT_MS,
  MAX_ENTRIES,
  describeAt,
  installPlayerProbe,
  signatureOf,
  snapshot,
};
