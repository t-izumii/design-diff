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
const MAX_BODY = 16 * 1024;

// overlay.js を script タグで読み込んだページのうち、受け付ける開発環境のホスト。これ以外は設定ファイルの allowedHosts で追加する
// 拡張から起動したページの要求は background.js から届くため、ここには関係しない
// *.local は同じネットワークの機器も名乗れるため含めない。Local などで使う場合は、案件のドメインを allowedHosts に書く
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '*.localhost', '*.test'];
// 拡張から起動したページの要求は、拡張のバックグラウンド（background.js）がこのヘッダーを付けて送る
// Web ページは独自のヘッダーを付けると CORS のプリフライトが必要になり、CLI はこのヘッダーを許可しないため、ページからは付けられない
const EXTENSION_HEADER = 'x-design-diff-client';

export function startServer({ rootDir, port }) {
  const selfHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  // 案内を出したオリジン。ページを開くたびに同じ案内を出さない
  const hintedOrigins = new Set();

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
    const url = new URL(req.url, `http://${req.headers.host}`);
    // 「//別のホスト/…」のような要求先ではホストが差し替わるため受け付けない
    if (url.host !== req.headers.host) return sendJson(res, 400, { error: 'bad request' });

    // script タグで読み込んだ overlay.js はページのオリジンで fetch するため、ローカル開発のオリジンにだけ CORS を許可する
    const origin = req.headers.origin;
    if (isFromExtension(req)) {
      // 拡張から起動したページ。ページのオリジンを使わずに届くため、どの URL のページで起動しても受け付ける
    } else if (origin) {
      if (!isAllowedOrigin(origin, loadConfig(rootDir).allowedHosts)) {
        hintLocalOrigin(origin);
        return sendJson(res, 403, { error: 'forbidden origin' });
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else if (url.pathname !== '/overlay.js') {
      // 外部サイトの <img> など Origin の付かない要求には、画像も対応表も返さない（パネルは画像も CORS で読み込む）
      // script タグで読み込む /overlay.js には Origin が付かないため、これだけは返す
      return sendJson(res, 403, { error: 'forbidden origin' });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/api/images') return handleSave(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });

    if (url.pathname === '/api/match') return handleMatch(url, res);
    if (url.pathname === '/api/manifest') return handleManifest(res);
    if (url.pathname === '/overlay.js') return sendFile(res, OVERLAY_FILE);
    if (url.pathname.startsWith('/images/')) return handleImage(url, res);
    sendJson(res, 404, { error: 'not found' });
  }

  // *.local は既定では許可しないため、Local などのサイトでパネルが出ない理由を、オリジンごとに一度だけ案内する
  // 表示には受け取ったヘッダーをそのまま使わず、解析し直したオリジンを使う
  function hintLocalOrigin(origin) {
    if (!URL.canParse(origin)) return;
    const { origin: pageOrigin, hostname } = new URL(origin);
    if (!hostname.endsWith('.local') || hintedOrigins.has(pageOrigin)) return;
    hintedOrigins.add(pageOrigin);
    console.warn(`design-diff: ${pageOrigin} からの要求を拒否しました。開発中のサイトなら、design-diff.config.json の allowedHosts に "${hostname}" を追加してください（拡張のボタンで起動する場合は不要です）`);
  }

  // 画像の追加・差し替えや images.json の編集がすぐ反映されるよう、リクエストごとに走査する
  function current() {
    return { config: loadConfig(rootDir), ...scan(rootDir) };
  }

  function handleMatch(url, res) {
    const target = URL.canParse(url.searchParams.get('url')) ? new URL(url.searchParams.get('url')) : null;
    if (!target) return sendJson(res, 400, { error: 'bad request' });
    const { entries } = current();
    const entry = findEntry(entries, target.pathname);
    if (!entry) return sendJson(res, 404, { matched: false });

    // url.host は検証済みの Host と同じなので、画像の URL に使ってよい
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
      // 設定ファイルに書かれたほかの値は返さない
      config: { port: config.port, allowedHosts: config.allowedHosts },
      warnings,
      entries: entries.map((e) => ({ route: routeLabel(e.segments), images: e.images })),
    });
  }

  // パネルで変えた倍率と位置を images.json に書き込む
  function handleSave(req, res) {
    // 書き込みはローカル開発のページ（上で Origin を検証済み）と拡張からだけ受け付ける
    if (!req.headers.origin && !isFromExtension(req)) return sendJson(res, 403, { error: 'forbidden origin' });
    // application/json 以外は CORS のプリフライトを経ずに送れるため受け付けない
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendJson(res, 415, { error: 'unsupported media type' });
    if (Number(req.headers['content-length']) > MAX_BODY) return sendJson(res, 413, { error: 'payload too large' });

    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      // 上限を超えたら、残りは読み捨ててメモリに溜めない
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_BODY) {
        tooLarge = true;
        body = '';
      }
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
    // 対応表に載っている画像だけを配信する。設定ファイルや、design-diff/ の外を指すシンボリックリンクは返さない
    const listed = scan(rootDir, {}, { checkMissing: false }).entries.some((e) => e.images.some((img) => img.file === rel));
    if (!listed) return sendJson(res, 404, { error: 'not found' });
    sendFile(res, path.join(rootDir, rel));
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 外部から画像を見られないよう、ループバックだけで待ち受ける
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// 拡張は CLI へのアクセス権（manifest.json の host_permissions）を持つため、CORS を経ずに送る。Origin は付かないか chrome-extension:// になる
// Web ページの Origin が付いた要求は、ヘッダーがあっても拡張からの要求として扱わない
function isFromExtension(req) {
  const origin = req.headers.origin;
  return req.headers[EXTENSION_HEADER] === 'extension' && (origin === undefined || origin.startsWith('chrome-extension://'));
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
  const stream = fs.createReadStream(file);
  // 読み込めないファイルでも、サーバーを止めない
  stream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    console.error(`design-diff: ${err.message}`);
    sendJson(res, 500, { error: 'internal error' });
  });
  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    stream.pipe(res);
  });
  // 受信が途中で切れても、ファイルを開いたままにしない
  res.on('close', () => stream.destroy());
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(body));
}
