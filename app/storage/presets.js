'use strict';

/**
 * Ready-made script configurations, one JSON file each.
 *
 * The point is to stop asking people to hand-edit a dozen switches: pick a preset from the
 * menu and the whole configuration is replaced with a known-good one. Files use the same
 * format as 导出配置, so a preset is just a backup that ships with the app - and dropping
 * another backup into the folder adds another preset, no code change.
 *
 * A preset that cannot be parsed is returned with `ok: false` rather than thrown away: the
 * menu shows it greyed out with the reason, which is the difference between "my file is
 * broken" and "the feature is broken".
 *
 * No `electron` import - the reading and validation are unit tested against a temp folder.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseImportPayload } = require('./config-transfer');

/**
 * Read one preset file.
 *
 * @param {string} filePath
 * @returns {{ ok: true, id: string, name: string, description: string, values: object, keys: string[] }
 *          | { ok: false, id: string, name: string, error: string }}
 */
function readPreset(filePath) {
  const id = path.basename(filePath);
  const fallbackName = path.basename(filePath, path.extname(filePath));

  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { ok: false, id, name: fallbackName, error: `读取失败：${(error && error.message) || error}` };
  }

  const parsed = parseImportPayload(text);
  if (!parsed.ok) return { ok: false, id, name: fallbackName, error: parsed.error };

  // The display name is metadata, not part of the configuration: a preset that only carries
  // values still works, it just shows its file name.
  let meta = {};
  try {
    meta = JSON.parse(text);
  } catch {
    meta = {};
  }

  return {
    ok: true,
    id,
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : fallbackName,
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    values: parsed.values,
    keys: parsed.keys,
  };
}

/**
 * Every preset in a folder, readable ones first, then by name.
 *
 * @param {string} dir
 * @returns {Array<ReturnType<typeof readPreset>>}
 */
function loadPresets(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No folder is not an error: the menu simply has nothing to offer.
    return [];
  }

  const presets = names
    .filter((name) => /\.json$/i.test(name))
    .sort()
    .map((name) => readPreset(path.join(dir, name)));

  return presets.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

module.exports = { loadPresets, readPreset };
