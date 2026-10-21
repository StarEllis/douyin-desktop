'use strict';

/**
 * Apply a preset from the 抖音优化 menu.
 *
 * Replacing the whole configuration is destructive, so this does three things in order and
 * stops on the first failure: write the current configuration to a timestamped backup next
 * to the real file, replace it, then reload the page (the script reads its configuration at
 * document-start, so a reload is what makes the new values take effect).
 *
 * The backup is a plain copy of `userscript-config.json`, not an export: it must work even
 * if the preset is wrong in a way that breaks the script's own export path.
 */

const fs = require('node:fs');
const path = require('node:path');
const { dialog } = require('electron');
const log = require('../diagnostics/logger');
const { USERSCRIPT_CONFIG_PATH } = require('../platform/constants');
const { userscriptStore } = require('../storage/userscript-store');
const { afterConfigurationReplaced } = require('./userscript-config');
const { getMainWindow } = require('./window');

/** `userscript-config.backup-20261021-1830.json`, next to the live file. */
function backupFileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
  return `userscript-config.backup-${stamp}.json`;
}

function writeBackup(values) {
  const file = path.join(path.dirname(USERSCRIPT_CONFIG_PATH), backupFileName());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(values, null, 2), 'utf8');
  return file;
}

/**
 * Ask, then replace the configuration.
 *
 * @param {{ name: string, description?: string, values: object, keys: string[] }} preset
 * @returns {Promise<{ ok: boolean, canceled?: boolean, backup?: string, error?: string }>}
 */
async function applyPreset(preset) {
  const window = getMainWindow();
  if (!preset || !preset.values) return { ok: false, error: '预设内容为空' };

  const confirm = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['取消', '套用'],
    defaultId: 1,
    cancelId: 0,
    title: '套用预设配置',
    message: `即将套用「${preset.name}」（${preset.keys.length} 项配置）。`,
    detail: [
      preset.description,
      '当前配置会先备份到数据目录，然后整体覆盖，页面会自动刷新。',
    ].filter(Boolean).join('\n\n'),
  });
  if (confirm.response !== 1) return { ok: false, canceled: true };

  let backup;
  try {
    backup = writeBackup(userscriptStore.getAll());
  } catch (error) {
    const message = String((error && error.message) || error);
    log.error('套用预设前备份失败，已中止', { error: message });
    await dialog.showMessageBox(window, {
      type: 'error',
      title: '套用失败',
      message: '备份当前配置失败，为免丢失配置已中止。',
      detail: message,
      buttons: ['好'],
    });
    return { ok: false, error: message };
  }

  userscriptStore.replaceAll(preset.values);
  log.info('已套用预设配置', { preset: preset.id || preset.name, keys: preset.keys.length, backup });
  afterConfigurationReplaced(preset.values);
  return { ok: true, backup };
}

module.exports = { applyPreset, backupFileName };
