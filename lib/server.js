import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, loadConfig, routeLabel, updateSettings } from './scan.js';
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
const MAX_BODY = 16 * 1024;

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
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'POST' && url.pathname === '/api/images') return handleSave(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });

    if (url.pathname === '/api/match') return handleMatch(url, res);
    if (url.pathname === '/api/manifest') return handleManifest(res);
    if (url.pathname === '/overlay.js') return sendFile(res, OVERLAY_FILE);
    if (url.pathname.startsWith('/images/')) return handleImage(url, res);
    sendJson(res, 404, { error: 'not found' });
  }

  // 画像の追加・差し替えや images.json の編集がすぐ反映されるよう、リクエストごとに走査する
  function current() {
    return { config: loadConfig(rootDir), ...scan(rootDir) };
  }

  function handleMatch(url, res) {
    const target = URL.canParse(url.searchParams.get('url')) ? new URL(url.searchParams.get('url')) : null;
    if (!target) return sendJson(res, 400, { error: 'bad request' });
    const { entries } = current();
    const entry = findEntry(entries, target.host, target.pathname);
    if (!entry) return sendJson(res, 404, { matched: false });

    // url.host は上で検証済みの Host なので、画像の URL に使ってよい
    const origin = `http://${url.host}`;
    sendJson(res, 200, {
      matched: true,
      route: routeLabel(entry.segments),
      images: entry.images.map((img) => ({
        name: img.name,
        file: img.file,
        zoom: img.zoom,
        x: img.x,
        y: img.y,
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

  // パネルで変えた倍率と位置を images.json に書き込む
  function handleSave(req, res) {
    // 書き込みはローカル開発のページ（上で Origin を検証済み）からだけ受け付ける
    if (!req.headers.origin) return sendJson(res, 403, { error: 'forbidden origin' });
    // application/json 以外は CORS のプリフライトを経ずに送れるため受け付けない
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendJson(res, 415, { error: 'unsupported media type' });

    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) tooLarge = true;
    });
    req.on('end', () => {
      try {
        if (tooLarge) return sendJson(res, 413, { error: 'payload too large' });
        const input = JSON.parse(body);
        const patch = {};
        if (Number.isFinite(input?.zoom) && input.zoom > 0) patch.zoom = Math.round(input.zoom * 100) / 100;
        for (const key of ['x', 'y']) if (Number.isFinite(input?.[key])) patch[key] = Math.round(input[key] * 100) / 100;
        if (typeof input?.file !== 'string' || Object.keys(patch).length === 0) return sendJson(res, 400, { error: 'bad request' });
        const saved = updateSettings(rootDir, input.file, patch);
        if (!saved) return sendJson(res, 404, { error: 'not found' });
        sendJson(res, 200, { ok: true, file: input.file, ...saved });
      } catch (err) {
        if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'bad request' });
        console.error(`design-diff: ${err.message}`);
        sendJson(res, 500, { error: 'internal error' });
      }
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
