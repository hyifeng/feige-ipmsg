'use strict';

const path = require('node:path');
const { DEFAULT_DISCOVERY_PORT } = require('../../shared/protocol');

const ROOT = path.join(__dirname, '../../..');

const APP_NAME = '飞鸽';
const IS_DEV = process.env.FEIGE_DEV === '1';
const DEMO = process.env.FEIGE_DEMO === '1';

const ICON_PATH = path.join(ROOT, 'assets/icon.png');
const PRELOAD_PATH = path.join(ROOT, 'src/main/preload.js');
const RENDERER_INDEX = path.join(ROOT, 'src/renderer/index.html');

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_READ_IMAGE_BYTES = 30 * 1024 * 1024;

function discoveryPort() {
  const port = Number(process.env.FEIGE_DISCOVERY_PORT);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_DISCOVERY_PORT;
}

module.exports = {
  ROOT,
  APP_NAME,
  IS_DEV,
  DEMO,
  ICON_PATH,
  PRELOAD_PATH,
  RENDERER_INDEX,
  IMAGE_EXTENSIONS,
  IMAGE_MIME,
  MAX_IMAGE_BYTES,
  MAX_READ_IMAGE_BYTES,
  DISCOVERY_PORT: discoveryPort(),
};
