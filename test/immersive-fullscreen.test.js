'use strict';

// The "鼠标进入显示" immersive mode only lowers the controls' opacity, so they still occupy
// layout - and Douyin's player reserves 48px at the bottom of the video for them. The video is
// therefore smaller than the screen even though nothing is drawn there.
//
// Measured on the live player (2048x1152 screen, 1920x1080 stream, real fullscreen):
//   before: xg-video-container 2048x1105, picture painted 1964x1105
//   after : xg-video-container 2048x1153, picture painted 2048x1152  (fills the screen)
// The "全部" mode already filled the screen because it sets `display: none` on the controls and
// `bottom: 0` on the container; this mode cannot hide them (they must show on hover), so the
// patch only gives the reserved strip back.
//
// This lives in the bundle, which is a dependency we update from upstream - an update would
// drop the patch silently and the symptom would come back with no error anywhere. Hence a test
// that reads the bundle rather than trusting a comment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BUNDLE = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'douyin-optimization.user.js'),
  'utf8',
);

/** The `fullScreen(mode)` branches, keyed by mode. */
function immersiveBranches() {
  const start = BUNDLE.indexOf('fullScreen(mode) {');
  assert.notEqual(start, -1, 'fullScreen(mode) 已不在脚本里（上游改名了？）');
  const end = BUNDLE.indexOf('autoEnterElementFullScreen(', start);
  assert.notEqual(end, -1, 'fullScreen 分支的结尾找不到');

  const body = BUNDLE.slice(start, end);
  const mouseStart = body.indexOf('mode === "mouseEnterShow"');
  assert.notEqual(mouseStart, -1, 'mouseEnterShow 分支已不在脚本里');
  const mouseEnd = body.indexOf('else if (mode ===', mouseStart);
  assert.notEqual(mouseEnd, -1, 'mouseEnterShow 分支的结尾找不到');

  return { all: body.slice(0, mouseStart), mouseEnterShow: body.slice(mouseStart, mouseEnd) };
}

test('鼠标进入显示模式在全屏时把控制栏占的 48px 还给视频', () => {
  const { mouseEnterShow } = immersiveBranches();

  assert.match(mouseEnterShow, /xg-video-container\.xg-video-container/, '缺少放开占位的规则');
  assert.match(mouseEnterShow, /bottom:\s*0px\s*!important/, '规则没有把 bottom 归零');
});

test('这条规则只在全屏下生效，窗口模式的行为不变', () => {
  const { mouseEnterShow } = immersiveBranches();

  // Windowed mode also reserves the 48px; changing it there is a different (unasked for) change.
  assert.match(mouseEnterShow, /\.isCssFullScreen\s+xg-video-container/, '网页全屏（isCssFullScreen）没覆盖');
  assert.match(mouseEnterShow, /:fullscreen\s+xg-video-container/, '真实全屏（Fullscreen API）没覆盖');
});

test('原有的悬停显示规则还在：补丁只加占位，不动显隐', () => {
  const { mouseEnterShow } = immersiveBranches();

  assert.match(mouseEnterShow, /opacity:\s*0\s*!important/, '隐藏控件的规则不见了');
  assert.match(mouseEnterShow, /opacity:\s*1\s*!important/, '悬停显示控件的规则不见了');
});

test('「全部」模式本来就靠 bottom:0 铺满，别把它删了', () => {
  const { all } = immersiveBranches();
  assert.match(all, /xg-video-container\.xg-video-container\{[\s\S]*?bottom:\s*0px\s*!important/);
});
