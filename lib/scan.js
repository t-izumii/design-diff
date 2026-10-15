import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  port: 4567,
  // maxWidth の小さい順に評価し、表示幅が maxWidth 以下の最初のものを使う。
  // maxWidth を持たないものは、それ以外すべての幅で使う。
  breakpoints: [
    { name: 'sp', designWidth: 375, maxWidth: 767 },
    { name: 'pc', designWidth: 1440 },
  ],
  // localhost・127.0.0.1・*.localhost・*.local・*.test 以外の開発ドメインを使う場合に追加する（例: "*.example.dev"）
  allowedHosts: [],
};

const IMAGE_RE = /^(.+?)(?:@(\d+(?:\.\d+)?)x)?\.(png|jpe?g|webp)$/i;

export function loadConfig(rootDir) {
  const file = path.join(rootDir, 'design-diff.config.json');
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  const user = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...DEFAULT_CONFIG, ...user };
}

/**
 * design-diff/ 以下を走査して、ホスト・ルートごとの画像一覧を返す。
 *
 * design-diff/<host>/<route...>/<breakpoint>[@<scale>x].png
 *   - host のポートは ":" の代わりに "_" で書く（localhost_3000）。"_any" はすべてのホストに一致する
 *   - ルート直下（/）は "index" フォルダに置く
 *   - "_" で始まるフォルダ名は1セグメント分のワイルドカード（news/_slug → /news/任意）
 */
export function scan(rootDir, config) {
  const names = new Set(config.breakpoints.map((bp) => bp.name));
  const entries = [];
  const warnings = [];

  if (!fs.existsSync(rootDir)) return { entries, warnings };

  for (const hostDir of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!hostDir.isDirectory()) continue;
    const host = hostDir.name === '_any' ? '*' : hostDir.name.replace(/_(\d+)$/, ':$1');
    walk(path.join(rootDir, hostDir.name), []);

    function walk(dir, segments) {
      const images = [];
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.isDirectory()) {
          walk(path.join(dir, item.name), [...segments, item.name]);
          continue;
        }
        const m = item.name.match(IMAGE_RE);
        if (!m) continue;
        const rel = path.relative(rootDir, path.join(dir, item.name)).split(path.sep).join('/');
        if (!names.has(m[1])) {
          warnings.push(`ブレークポイント名に一致しないため無視しました: ${rel}`);
          continue;
        }
        images.push({ breakpoint: m[1], scale: m[2] ? Number(m[2]) : 1, file: rel });
      }
      if (images.length === 0) return;

      // ルート直下は index フォルダ。それ以外の階層の index は通常のセグメントとして扱う
      const routeSegments = segments.length === 1 && segments[0] === 'index' ? [] : segments;
      if (segments.length === 0) {
        warnings.push(`ホスト直下の画像は無視しました。ルート（/）の画像は index フォルダに置いてください: ${hostDir.name}/`);
        return;
      }
      entries.push({ host, segments: routeSegments, images });
    }
  }

  return { entries, warnings };
}

export function routeLabel(segments) {
  return '/' + segments.map((s) => (s.startsWith('_') ? `:${s.slice(1)}` : s)).join('/');
}
