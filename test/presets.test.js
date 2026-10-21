'use strict';

// Presets are backups that ship with the app, so the only two things to pin down are:
// a readable file becomes a menu entry with its own name, and an unreadable one does not
// disappear (a preset that vanishes looks like the menu is broken).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadPresets, readPreset } = require('../app/storage/presets');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dy-presets-'));
}

function write(dir, name, payload) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

test('读取预设：名字来自文件里的 name，缺省时退回文件名', () => {
  const dir = tempDir();
  const named = write(dir, 'a.json', { name: '精简浏览', format: 1, app: 'douyin-desktop', values: { GM_Panel: { fullScreen: true } } });
  const bare = write(dir, 'b.json', { GM_Panel: { fullScreen: false } });

  assert.equal(readPreset(named).name, '精简浏览');
  assert.equal(readPreset(named).keys.length, 1);
  assert.equal(readPreset(bare).name, 'b');
  assert.equal(readPreset(bare).ok, true, '裸配置也要能当预设');
});

test('坏文件保留在列表里，并带上原因', () => {
  const dir = tempDir();
  write(dir, 'good.json', { GM_Panel: { fullScreen: true } });
  write(dir, 'broken.json', '{ not json');

  const presets = loadPresets(dir);
  assert.equal(presets.length, 2);
  assert.equal(presets[0].ok, true, '可用的排在前面');
  const broken = presets.find((item) => item.id === 'broken.json');
  assert.equal(broken.ok, false);
  assert.match(broken.error, /JSON/);
});

test('空文件夹、不存在的文件夹都不算错误', () => {
  assert.deepEqual(loadPresets(tempDir()), []);
  assert.deepEqual(loadPresets(path.join(os.tmpdir(), 'definitely-not-here-12345')), []);
});

test('只认 .json，别的文件不参与', () => {
  const dir = tempDir();
  write(dir, 'notes.txt', 'hello');
  write(dir, 'real.json', { GM_Panel: { a: 1 } });
  assert.deepEqual(loadPresets(dir).map((item) => item.id), ['real.json']);
});

test('内置预设本身是可用的', () => {
  const bundled = loadPresets(path.join(__dirname, '..', 'assets', 'presets'));
  assert.ok(bundled.length >= 1, '至少带一个预设');
  for (const preset of bundled) {
    assert.equal(preset.ok, true, `${preset.id} 解析失败：${preset.error}`);
    assert.ok(preset.values.GM_Panel, `${preset.id} 里没有 GM_Panel`);
  }
});
