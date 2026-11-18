import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const rendererZh = (await import(pathToFileURL(path.join(ROOT, 'src/renderer/js/i18n/locales/zh-CN.mjs')))).default;
const rendererEn = (await import(pathToFileURL(path.join(ROOT, 'src/renderer/js/i18n/locales/en.mjs')))).default;
const mainZh = require(path.join(ROOT, 'src/main/i18n/locales/zh-CN.js'));
const mainEn = require(path.join(ROOT, 'src/main/i18n/locales/en.js'));

const CJK = /[\u3400-\u9fff]/;
const errors = [];

function walk(directory, predicate) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(target, predicate));
    else if (predicate(target)) result.push(target);
  }
  return result;
}

function firstArgument(source, start) {
  let depth = 1;
  let quote = '';
  let escaped = false;
  let index = start;
  const output = [];
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (quote) {
      output.push(char);
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
      output.push(char);
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      output.push(char);
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (!depth) break;
      output.push(char);
    } else {
      output.push(char);
    }
    index += 1;
  }
  return output.join('');
}

function collectKeys(source) {
  const keys = new Set();
  for (const match of source.matchAll(/(?<![\w$.])t\(/g)) {
    const argument = firstArgument(source, match.index + match[0].length);
    for (const literal of argument.matchAll(/'((?:\\.|[^'])*)'|"((?:\\.|[^"])*)"/g)) {
      const value = literal[1] ?? literal[2];
      if (value && (value.includes('.') || CJK.test(value))) keys.add(value);
    }
  }
  for (const match of source.matchAll(/\bi18nKey:\s*'([^']+)'/g)) keys.add(match[1]);
  for (const match of source.matchAll(/\baddSystemMessage\([^,]+,\s*'([^']+)'/g)) keys.add(match[1]);
  for (const match of source.matchAll(/'(main\.reason\.[A-Za-z0-9_.]+|secure\.reason\.[A-Za-z0-9_.]+)'/g)) keys.add(match[1]);
  return keys;
}

function keyExists(catalog, key) {
  return Object.prototype.hasOwnProperty.call(catalog, key)
    || Object.prototype.hasOwnProperty.call(catalog, `${key}.one`)
    || Object.prototype.hasOwnProperty.call(catalog, `${key}.other`);
}

function checkCatalog(name, zh, en) {
  const zhKeys = new Set(Object.keys(zh));
  const enKeys = new Set(Object.keys(en));
  for (const key of zhKeys) if (!enKeys.has(key)) errors.push(`${name}: missing en key "${key}"`);
  for (const key of enKeys) if (!zhKeys.has(key)) errors.push(`${name}: missing zh-CN key "${key}"`);
  for (const key of enKeys) {
    const base = key.replace(/\.(one|other)$/, '');
    if (key.endsWith('.one') && !enKeys.has(`${base}.other`)) errors.push(`${name}: "${base}.one" lacks ".other"`);
    if (key.endsWith('.other') && !enKeys.has(`${base}.one`)) errors.push(`${name}: "${base}.other" lacks ".one"`);
  }
}

function checkUsage(name, catalog, keys) {
  for (const key of keys) {
    if (CJK.test(key)) {
      errors.push(`${name}: translation key contains CJK text: "${key}"`);
      continue;
    }
    if (!keyExists(catalog, key)) errors.push(`${name}: missing translation key "${key}"`);
  }
}

checkCatalog('renderer', rendererZh, rendererEn);
checkCatalog('main', mainZh, mainEn);

const rendererFiles = walk(path.join(ROOT, 'src/renderer'), (file) => file.endsWith('.js') && !file.includes(`${path.sep}i18n${path.sep}`));
const rendererKeys = new Set();
for (const file of rendererFiles) {
  for (const key of collectKeys(fs.readFileSync(file, 'utf8'))) rendererKeys.add(key);
}
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
for (const match of html.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]*)"/g)) rendererKeys.add(match[1]);
if (/data-i18n-html/.test(html)) errors.push('renderer: data-i18n-html is not allowed; split markup into separate elements');
checkUsage('renderer', rendererEn, rendererKeys);

const mainFiles = walk(path.join(ROOT, 'src/main'), (file) => file.endsWith('.js') && !file.includes(`${path.sep}i18n${path.sep}locales${path.sep}`));
const mainKeys = new Set();
for (const file of mainFiles) {
  for (const key of collectKeys(fs.readFileSync(file, 'utf8'))) mainKeys.add(key);
}
checkUsage('main', mainEn, mainKeys);

if (errors.length) {
  console.error(`i18n check failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`i18n check passed: renderer ${Object.keys(rendererEn).length} entries, main ${Object.keys(mainEn).length} entries.`);
