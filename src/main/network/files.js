'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { isFileEntry } = require('../../shared/protocol');
const { MAX_ATTACH_FILES } = require('./constants');
const { uid } = require('./utils');

function safeRelPath(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function topSegment(relPath) {
  return relPath.split('/')[0];
}

function replaceTopSegment(relPath, replacement) {
  const parts = relPath.split('/');
  parts[0] = replacement;
  return parts.join('/');
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function uniqueTopNames(root, relPaths) {
  const tops = [...new Set(relPaths.map(topSegment).filter(Boolean))];
  const mapping = new Map();
  for (const top of tops) {
    let candidate = top;
    let index = 1;
    while (await pathExists(path.join(root, candidate))) {
      candidate = `${top} (${index})`;
      index += 1;
    }
    mapping.set(top, candidate);
  }
  return mapping;
}

function normalizeFiles(list, limit = MAX_ATTACH_FILES) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (!isFileEntry(raw)) continue;
    const relPath = safeRelPath(raw.relPath);
    if (!relPath) continue;
    out.push({
      id: raw.id,
      name: raw.name.trim().slice(0, 255),
      relPath,
      size: raw.dir ? 0 : raw.size,
      mtime: Number(raw.mtime) || 0,
      dir: raw.dir,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function walkDirectory(absDir, relDir, out) {
  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  if (!entries.length) {
    out.push({
      id: uid(),
      name: path.basename(absDir),
      relPath: relDir,
      size: 0,
      mtime: 0,
      dir: true,
      absPath: absDir,
    });
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const childAbs = path.join(absDir, entry.name);
    const childRel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkDirectory(childAbs, childRel, out);
    } else if (entry.isFile()) {
      try {
        const stat = await fsp.stat(childAbs);
        out.push({
          id: uid(),
          name: entry.name,
          relPath: childRel,
          size: stat.size,
          mtime: stat.mtimeMs,
          dir: false,
          absPath: childAbs,
        });
      } catch {
        /* 文件在扫描时消失，跳过 */
      }
    }
  }
}

module.exports = {
  safeRelPath,
  topSegment,
  replaceTopSegment,
  pathExists,
  uniqueTopNames,
  normalizeFiles,
  walkDirectory,
};
