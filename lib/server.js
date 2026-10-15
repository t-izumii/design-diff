import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, loadConfig, routeLabel } from './scan.js';
import { findEntry } from './match.js';

const OVERLAY_FILE = fileURLToPath(new URL('../extension/overlay.js', import.meta.url));

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

// 開発環境でよく使うホスト。これ以外は設定ファイルの allowedHosts で追加する
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '*.localhost', '*.local', '*.test'];

export function startServer({ rootDir, port }) {
  const selfHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      // 設定ファイルの JSON が壊れている場合などもサーバーを落とさない
      console.error(`design-diff: ${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    }
  });

  function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // DNS リバインディング対策: 別名のドメインを経由したリクエストは受け付けない
    if (!selfHosts.has(req.headers.host)) return sendJson(res, 403, { error: 'forbidden host' });

    // 拡張の content script はページのオリジンで fetch するため、ローカル開発のオリジンにだけ CORS を許可する
    const origin = req.headers.origin;
    if (origin) {
      if (!isAllowedOrigin(origin, loadConfig(rootDir).allowedHosts)) return sendJson(res, 403, { error: 'forbidden origin' });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET' });
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/match') return handleMatch(url, res);
    if (url.pathname === '/api/manifest') return handleManifest(res);
    if (url.pathname === '/overlay.js') return sendFile(res, OVERLAY_FILE);
    if (url.pathname.startsWith('/images/')) return handleImage(url, res);
    sendJson(res, 404, { error: 'not found' });
  }

  // 画像を追加・差し替えたらすぐ反映されるよう、リクエストごとに走査する
  function current() {
    const config = loadConfig(rootDir);
    return { config, ...scan(rootDir, config) };
  }

  function handleMatch(url, res) {
    const target = URL.canParse(url.searchParams.get('url')) ? new URL(url.searchParams.get('url')) : null;
    if (!target) return sendJson(res, 400, { error: 'bad request' });
    const { config, entries } = current();
    const entry = findEntry(entries, target.host, target.pathname);
    if (!entry) return sendJson(res, 404, { matched: false });

    // url.host は上で検証済みの Host なので、画像の URL に使ってよい
    const origin = `http://${url.host}`;
    sendJson(res, 200, {
      matched: true,
      route: routeLabel(entry.segments),
      breakpoints: config.breakpoints,
      images: entry.images.map((img) => ({
        breakpoint: img.breakpoint,
        scale: img.scale,
        src: `${origin}/images/${img.file.split('/').map(encodeURIComponent).join('/')}`,
      })),
    });
  }

  function handleManifest(res) {
    const { config, entries, warnings } = current();
    sendJson(res, 200, {
      config,
      warnings,
      entries: entries.map((e) => ({ host: e.host, route: routeLabel(e.segments), images: e.images })),
    });
  }

  function handleImage(url, res) {
    let rel;
    try {
      rel = decodeURIComponent(url.pathname.slice('/images/'.length));
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }
    const file = path.resolve(rootDir, rel);
    if (!file.startsWith(path.resolve(rootDir) + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
    // 設定ファイルなど、画像以外は配信しない
    if (!IMAGE_EXTS.has(path.extname(file).toLowerCase())) return sendJson(res, 404, { error: 'not found' });
    sendFile(res, file);
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 外部から画像を見られないよう、ループバックだけで待ち受ける
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function isAllowedOrigin(origin, extraHosts = []) {
  let hostname;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return [...LOCAL_HOSTS, ...extraHosts].some((pattern) =>
    pattern.startsWith('*.') ? hostname.endsWith(pattern.slice(1)) : hostname === pattern,
  );
}

function sendFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(body));
}
