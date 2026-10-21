'use strict';

/**
 * A daily log file, pruned by age.
 *
 * One file for everything was unreadable in practice: a single `main.log` grew across weeks,
 * and the lines that mattered were somewhere in the middle of thousands from other days.
 * So a day is the unit - `main-2026-10-21.log` - and files older than a week are deleted.
 *
 * Two measurements shaped the rest:
 *
 *  - capturing the page's console produced 22 lines in the first 75 seconds of an ordinary
 *    load, so a size cap inside a day is still needed as a backstop (`maxBytes`);
 *  - rotation can fail when the file is open in an editor, so the cap is also enforced by
 *    truncating rather than only by renaming (`HARD_LIMIT_MULTIPLE`).
 *
 * Age is read from the file name, not from mtime: a copy or a backup restore rewrites mtime,
 * and then a month-old log would look new. Names this module did not write are left alone.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Rotate at this size within a day. */
const MAX_BYTES = 2 * 1024 * 1024;

/** How many rotated files to keep per day (`main-2026-10-21.1.log`, ...). */
const KEEP_ROTATED = 2;

/** Delete logs older than this many days. */
const KEEP_DAYS = 7;

/**
 * Rotation can fail, and then the file grows without limit.
 *
 * The realistic way to hit this: the menu item opens the log in an editor, and Windows refuses
 * to rename a file another process has open. Rotation then silently does nothing on every
 * write (the catch below deliberately does not fail a log line over it), and the "2 MB cap"
 * stops being a cap at all.
 *
 * So past this multiple of `MAX_BYTES`, keep the newest lines and drop the rest. A bounded log
 * with a gap in it beats an unbounded one, and the newest lines are the ones that matter.
 */
const HARD_LIMIT_MULTIPLE = 4;

/**
 * How much of the tail to keep when the ceiling is enforced, as a fraction of `maxBytes`.
 *
 * Relative rather than absolute on purpose: a fixed 256 KB would be *larger* than the whole
 * limit for a small `maxBytes`, so the "truncate" would rewrite a bigger file than it found
 * and the ceiling would never hold.
 */
const TRUNCATE_KEEP_RATIO = 0.5;

function stamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.`
    + `${pad(date.getMilliseconds(), 3)}`;
}

/** `2026-10-21` - the date part of a file name, in local time. */
function dateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Whole days between two `YYYY-MM-DD` keys, or null when a key is not one. */
function daysBetween(fromKey, toKey) {
  const parse = (key) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!match) return null;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  };
  const from = parse(fromKey);
  const to = parse(toKey);
  if (from === null || to === null) return null;
  return Math.round((to - from) / 86400000);
}

/**
 * @param {object} options
 * @param {string} options.dir directory to write into (created if missing)
 * @param {string} [options.baseName] file stem, e.g. `main` -> `main-2026-10-21.log`
 * @param {number} [options.maxBytes] size cap per day
 * @param {number} [options.keep] rotated files per day
 * @param {number} [options.keepDays] delete day files older than this
 * @param {() => Date} [options.now] clock, for tests
 */
function createLogFile({
  dir,
  baseName = 'main',
  maxBytes = MAX_BYTES,
  keep = KEEP_ROTATED,
  keepDays = KEEP_DAYS,
  now = () => new Date(),
}) {
  let broken = false;
  let currentKey = dateKey(now());
  let prunedFor = null;

  const fileFor = (key) => path.join(dir, `${baseName}-${key}.log`);
  const rotatedFor = (key, index) => path.join(dir, `${baseName}-${key}.${index}.log`);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    broken = true;
    // A logger that throws is worse than no logger.
    console.error('[抖音] 无法创建日志目录', dir, error);
  }

  /**
   * Delete day files older than `keepDays`.
   *
   * Runs at most once per day file, not on every line: the directory listing is the expensive
   * part and nothing it would find can change within the same day.
   */
  const prune = (key) => {
    if (prunedFor === key) return;
    prunedFor = key;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    const pattern = new RegExp(`^${baseName}-(\\d{4}-\\d{2}-\\d{2})(?:\\.\\d+)?\\.log$`);
    for (const name of names) {
      const match = pattern.exec(name);
      if (!match) continue;
      const age = daysBetween(match[1], key);
      if (age === null || age <= keepDays) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // Locked by another process: it will be retried on the next day's first write.
      }
    }
  };

  /** Keep the file bounded even when rotation cannot happen. See HARD_LIMIT_MULTIPLE. */
  const enforceCeiling = (key, size) => {
    if (size < maxBytes * HARD_LIMIT_MULTIPLE) return;
    const filePath = fileFor(key);
    try {
      const fd = fs.openSync(filePath, 'r');
      const keepBytes = Math.max(1, Math.floor(maxBytes * TRUNCATE_KEEP_RATIO));
      const from = Math.max(0, size - keepBytes);
      const buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buffer, 0, buffer.length, from);
      fs.closeSync(fd);

      const text = buffer.toString('utf8');
      // Drop the partial first line, so what is kept starts at a real entry.
      const firstBreak = text.indexOf('\n');
      const kept = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
      fs.writeFileSync(
        filePath,
        `${stamp()} [warn] 日志超过上限且轮转失败，已丢弃较早内容\n${kept}`,
        'utf8',
      );
    } catch {
      // Nothing left to try. A logger that throws is worse than a logger that loses lines.
    }
  };

  const rotateIfNeeded = (key) => {
    const filePath = fileFor(key);
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return; // No file yet.
    }
    if (size < maxBytes) return;

    try {
      // Oldest first, so nothing is dropped before it has been moved.
      for (let index = keep; index >= 1; index -= 1) {
        const from = index === 1 ? filePath : rotatedFor(key, index - 1);
        const to = rotatedFor(key, index);
        if (!fs.existsSync(from)) continue;
        if (index === keep && fs.existsSync(to)) fs.rmSync(to, { force: true });
        fs.renameSync(from, to);
      }
    } catch {
      // A lost rotation is not worth failing a log line over - but it does mean the file
      // keeps growing, so fall through to the ceiling check below.
    }
    enforceCeiling(key, size);
  };

  const write = (level, message, data) => {
    const key = dateKey(now());
    if (key !== currentKey) {
      currentKey = key;
      prunedFor = null;
    }
    const line = `${stamp()} [${level}] ${message}${data === undefined ? '' : ` ${safeJson(data)}`}\n`;
    if (!broken) {
      try {
        prune(key);
        rotateIfNeeded(key);
        fs.appendFileSync(fileFor(key), line, 'utf8');
      } catch (error) {
        broken = true;
        console.error('[抖音] 写日志失败', dir, error);
      }
    }
    // Mirror to the console so `npm start` shows the same story.
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(`[抖音] ${message}`, data === undefined ? '' : data);
  };

  return {
    /** Today's file. A getter, because the day can change while the app is running. */
    get path() { return fileFor(currentKey); },
    /** `main-2026-10-21.log` for the current day. */
    fileName: () => path.basename(fileFor(currentKey)),
    rotatedPath: (index) => rotatedFor(currentKey, index),
    write,
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  };
}

module.exports = {
  HARD_LIMIT_MULTIPLE,
  KEEP_DAYS,
  KEEP_ROTATED,
  MAX_BYTES,
  TRUNCATE_KEEP_RATIO,
  createLogFile,
  dateKey,
  daysBetween,
  safeJson,
  stamp,
};
