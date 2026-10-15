import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  port: 4567,
  // localhost・127.0.0.1・*.localhost・*.local・*.test 以外の開発ドメインを使う場合に追加する（例: "*.example.dev"）
  allowedHosts: [],
};

// 画像ごとの倍率と位置。design-diff sync で画像の追加・削除を反映し、値はパネルの操作か手で編集する
export const SETTINGS_FILE = 'images.json';

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
// zoom は画像の横幅に掛ける表示倍率（1 で画像の実寸どおり）
const DEFAULT_SETTINGS = { zoom: 1, x: 0, y: 0 };
// 以前の版で使っていた項目。書き込むときに取り除く
const LEGACY_KEYS = ['scale'];

export function loadConfig(rootDir) {
  const file = path.join(rootDir, 'design-diff.config.json');
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  const user = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...DEFAULT_CONFIG, ...user };
}

export function loadSettings(rootDir) {
  const file = path.join(rootDir, SETTINGS_FILE);
  if (!fs.existsSync(file)) return {};
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${SETTINGS_FILE} を読み込めません: ${err.message}`);
  }
  return isObject(data) ? data : {};
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 手で編集した値が不正でも表示できるよう、使えない値は初期値に戻す
function resolveSettings(saved = {}) {
  return {
    zoom: Number.isFinite(saved.zoom) && saved.zoom > 0 ? saved.zoom : DEFAULT_SETTINGS.zoom,
    x: Number.isFinite(saved.x) ? saved.x : DEFAULT_SETTINGS.x,
    y: Number.isFinite(saved.y) ? saved.y : DEFAULT_SETTINGS.y,
  };
}

// 書き込む値。初期値で欠けた項目を補い、手で足した項目は残して、以前の版の項目だけを除く
function toStored(saved, patch = {}) {
  const next = { ...DEFAULT_SETTINGS, ...(isObject(saved) ? saved : {}), ...patch };
  for (const key of LEGACY_KEYS) delete next[key];
  return next;
}

// 以前の版のホスト名のフォルダ（localhost_3000、mysite.local、_any など）。ページのパスと取り違えないよう読み飛ばす
// campaign_2024 のような通常のページ名と区別するため、localhost・IP・ドメイン形式（ドットを含む名前）に限る
const LEGACY_HOST_RE = /^(_any|localhost(_\d+)?|[a-z0-9-]+(\.[a-z0-9-]+)+(_\d+)?)$/i;

/**
 * design-diff/ 以下を走査して、ページ（パス）ごとの画像一覧を返す。
 *
 * design-diff/<route...>/<任意の名前>.png
 *   - トップページ（/）は "index" フォルダに置く
 *   - "_" で始まるフォルダ名は1セグメント分のワイルドカード（news/_slug → /news/任意）
 *   - 1つのフォルダに複数の画像を置ける。倍率と位置は images.json の値を使う
 *   - ホスト・ポートは区別しない。serve を起動した案件の画像だけを配信するため
 */
export function scan(rootDir, settings = loadSettings(rootDir), { checkMissing = true } = {}) {
  const entries = [];
  const warnings = [];

  if (!fs.existsSync(rootDir)) return { entries, warnings };
  walk(rootDir, []);

  function walk(dir, segments) {
    const images = [];
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (segments.length === 0 && LEGACY_HOST_RE.test(item.name)) {
          // 画像を移し終えた空のフォルダには警告しない
          if (hasImages(path.join(dir, item.name))) {
            warnings.push(`ホスト名のフォルダは使わなくなったため無視しました。中身を design-diff/ の直下へ移してください: ${item.name}/`);
          }
          continue;
        }
        walk(path.join(dir, item.name), [...segments, item.name]);
        continue;
      }
      if (item.name.startsWith('.') || !IMAGE_RE.test(item.name)) continue;
      const rel = path.relative(rootDir, path.join(dir, item.name)).split(path.sep).join('/');
      const saved = isObject(settings[rel]) ? settings[rel] : undefined;
      if (rel in settings && !saved) warnings.push(`${SETTINGS_FILE} の値が { "zoom", "x", "y" } の形ではないため初期値を使いました: ${rel}`);
      const resolved = resolveSettings(saved);
      const invalid = saved ? Object.keys(DEFAULT_SETTINGS).filter((key) => key in saved && saved[key] !== resolved[key]) : [];
      if (invalid.length) warnings.push(`${SETTINGS_FILE} の値が不正なため初期値を使いました（${invalid.join(', ')}）: ${rel}`);
      images.push({ name: item.name, file: rel, ...resolved });
    }
    if (images.length === 0) return;

    if (segments.length === 0) {
      warnings.push('design-diff/ 直下の画像は無視しました。トップページ（/）の画像は index フォルダに置いてください');
      return;
    }
    // トップページは index フォルダ。それ以外の階層の index は通常のセグメントとして扱う
    const routeSegments = segments.length === 1 && segments[0] === 'index' ? [] : segments;
    images.sort((a, b) => compareNames(a.name, b.name));
    entries.push({ segments: routeSegments, images });
  }

  for (const file of checkMissing ? Object.keys(settings) : []) {
    if (!fs.existsSync(path.join(rootDir, file))) {
      warnings.push(`${SETTINGS_FILE} にある画像が見つかりません（design-diff sync で削除できます）: ${file}`);
    }
  }

  return { entries, warnings };
}

/**
 * images.json を画像フォルダの内容に合わせる。
 * 新しい画像は初期値で追加し、既にある画像の値はそのまま残す。存在しない画像の項目は削除する。
 */
export function syncSettings(rootDir) {
  const saved = loadSettings(rootDir);
  const files = scan(rootDir, saved, { checkMissing: false }).entries.flatMap((e) => e.images.map((img) => img.file)).sort(compareNames);
  const next = {};
  const added = [];
  for (const file of files) {
    const value = isObject(saved[file]) ? saved[file] : legacyValue(rootDir, saved, file);
    if (!value) added.push(file);
    next[file] = toStored(value);
  }
  const removed = Object.keys(saved).filter((file) => !(file in next));
  fs.writeFileSync(path.join(rootDir, SETTINGS_FILE), JSON.stringify(next, null, 2) + '\n');
  // 置き換えた項目の警告は不要なので、書き込んだ内容で改めて確かめる
  const { warnings } = scan(rootDir, next, { checkMissing: false });
  return { added, removed, total: files.length, warnings };
}

function hasImages(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).some((item) =>
    item.isDirectory() ? hasImages(path.join(dir, item.name)) : IMAGE_RE.test(item.name) && !item.name.startsWith('.'),
  );
}

// ホスト名のフォルダから直下へ移した画像は、以前のキー（localhost_3000/index/a.png）の値を引き継ぐ
function legacyValue(rootDir, saved, file) {
  const key = Object.keys(saved).find(
    (k) => LEGACY_HOST_RE.test(k.split('/')[0]) && k.split('/').slice(1).join('/') === file && !fs.existsSync(path.join(rootDir, k)),
  );
  return key && isObject(saved[key]) ? saved[key] : undefined;
}

// 「TOP 2」が「TOP 10」より前に来るよう、数字を数値として比べる
function compareNames(a, b) {
  return a.localeCompare(b, 'ja', { numeric: true });
}

/**
 * パネルで変えた 1 枚分の値を images.json に書き込む。
 * 画像フォルダにない画像は書き込まず null を返す。patch 以外の値（手で足した項目など）は残す。
 */
export function updateSettings(rootDir, file, patch) {
  const saved = loadSettings(rootDir);
  const exists = scan(rootDir, saved, { checkMissing: false }).entries.some((e) => e.images.some((img) => img.file === file));
  if (!exists) return null;
  saved[file] = toStored(saved[file], patch);
  fs.writeFileSync(path.join(rootDir, SETTINGS_FILE), JSON.stringify(saved, null, 2) + '\n');
  return resolveSettings(saved[file]);
}

export function routeLabel(segments) {
  return '/' + segments.map((s) => (s.startsWith('_') ? `:${s.slice(1)}` : s)).join('/');
}
