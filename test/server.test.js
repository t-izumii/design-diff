import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.js';

// 1x1 の PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
// 拡張を入れたローカル開発のページのオリジン
const ORIGIN = 'http://localhost:3000';
const JSON_POST = { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' } };
// Windows ではシンボリックリンクの作成に権限が要るため省く
const noSymlink = process.platform === 'win32';

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-diff-server-test-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content ?? PNG);
  }
  return dir;
}

// 空いているポートで serve を起動し、そこへ要求を送る関数を返す
async function serve(dir) {
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const server = await startServer({ rootDir: dir, port });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const request = (pathname, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end(body);
    });
  return { port, request };
}

const matchUrl = (pageUrl) => `/api/match?url=${encodeURIComponent(pageUrl)}`;

test('ローカル開発のページには、対応表と画像を CORS で返す', async () => {
  const { port, request } = await serve(makeDir({ 'index/TOP.png': null }));
  const match = await request(matchUrl(`${ORIGIN}/`), { headers: { Origin: ORIGIN } });
  assert.equal(match.status, 200);
  assert.equal(match.headers['access-control-allow-origin'], ORIGIN);
  const src = new URL(JSON.parse(match.body).images[0].src);
  assert.equal(src.host, `127.0.0.1:${port}`);

  const image = await request(src.pathname, { headers: { Origin: ORIGIN } });
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['access-control-allow-origin'], ORIGIN);
});

test('Origin の付かない要求（外部サイトの <img> など）には、/overlay.js 以外を返さない', async () => {
  const { request } = await serve(makeDir({ 'index/TOP.png': null }));
  assert.equal((await request('/overlay.js')).status, 200);
  assert.equal((await request('/images/index/TOP.png')).status, 403);
  assert.equal((await request(matchUrl(`${ORIGIN}/`))).status, 403);
  assert.equal((await request('/api/manifest')).status, 403);
});

test('ローカル開発以外のオリジンや、別名のホストを経由した要求は拒否する', async () => {
  const { request } = await serve(makeDir({ 'index/TOP.png': null }));
  assert.equal((await request(matchUrl(`${ORIGIN}/`), { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/overlay.js', { headers: { Host: 'evil.example' } })).status, 403);
});

test('要求のパスで、画像の URL のホストを差し替えられない', async () => {
  const { request } = await serve(makeDir({ 'index/TOP.png': null }));
  const res = await request(`//evil.example${matchUrl(`${ORIGIN}/`)}`, { headers: { Origin: ORIGIN } });
  assert.equal(res.status, 400);
});

test('対応表に載っていないファイルや、design-diff/ の外を指すシンボリックリンクは返さない', { skip: noSymlink }, async () => {
  const dir = makeDir({ 'index/TOP.png': null, 'top.png': null, 'index/.hidden.png': null, 'design-diff.config.json': '{}' });
  const outside = makeDir({ 'secret.png': 'secret' });
  fs.symlinkSync(path.join(outside, 'secret.png'), path.join(dir, 'index/leak.png'));
  const { request } = await serve(dir);
  for (const pathname of ['/images/index/leak.png', '/images/top.png', '/images/index/.hidden.png', '/images/design-diff.config.json']) {
    const res = await request(pathname, { headers: { Origin: ORIGIN } });
    assert.equal(res.status, 404, pathname);
    assert.doesNotMatch(res.body, /secret/, pathname);
  }
});

test('読み込めない画像を要求されても、サーバーを止めない', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  t.mock.method(console, 'error', () => {});
  const dir = makeDir({ 'index/TOP.png': null, 'index/locked.png': null });
  fs.chmodSync(path.join(dir, 'index/locked.png'), 0o000);
  const { request } = await serve(dir);
  assert.equal((await request('/images/index/locked.png', { headers: { Origin: ORIGIN } })).status, 500);
  assert.equal((await request('/images/index/TOP.png', { headers: { Origin: ORIGIN } })).status, 200);
});

test('上限を超える本文は、メモリに溜めずに断る', async () => {
  const { request } = await serve(makeDir({ 'index/TOP.png': null }));
  // 長さが先にわかる場合は、本文を読まずに断る
  const declared = await request('/api/images', { ...JSON_POST, headers: { ...JSON_POST.headers, 'Content-Length': String(16 * 1024 + 1) } });
  assert.equal(declared.status, 413);
  // 長さがわからない場合（chunked）も、上限を超えた分は読み捨てて断る
  const streamed = await request('/api/images', { ...JSON_POST, headers: { ...JSON_POST.headers, 'Transfer-Encoding': 'chunked' }, body: 'a'.repeat(32 * 1024) });
  assert.equal(streamed.status, 413);
});

test('パネルからの保存は images.json に書き込む', async () => {
  const dir = makeDir({ 'index/TOP.png': null });
  const { request } = await serve(dir);
  const res = await request('/api/images', { ...JSON_POST, body: JSON.stringify({ file: 'index/TOP.png', x: 5 }) });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'images.json'), 'utf8')), { 'index/TOP.png': { zoom: 1, x: 5, y: 0 } });
});

test('/api/manifest は、設定ファイルに書かれたほかの値を返さない', async () => {
  const config = { port: 4567, allowedHosts: [], note: 'private' };
  const { request } = await serve(makeDir({ 'index/TOP.png': null, 'design-diff.config.json': JSON.stringify(config) }));
  const res = await request('/api/manifest', { headers: { Origin: ORIGIN } });
  assert.deepEqual(JSON.parse(res.body).config, { port: 4567, allowedHosts: [] });
});

test('既定で許可するのは localhost・127.0.0.1・*.localhost・*.test のページ', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { request } = await serve(makeDir({ 'index/TOP.png': null }));
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://mysite.localhost', 'http://mysite.test']) {
    assert.equal((await request(matchUrl(`${origin}/`), { headers: { Origin: origin } })).status, 200, origin);
  }
  assert.equal((await request(matchUrl('http://mysite.local/'), { headers: { Origin: 'http://mysite.local' } })).status, 403);
});

test('.local のページは allowedHosts に書けば通り、書くまでは serve の画面で一度だけ案内する', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const dir = makeDir({ 'index/TOP.png': null });
  const { request } = await serve(dir);
  const headers = { Origin: 'http://mysite.local' };
  assert.equal((await request(matchUrl('http://mysite.local/'), { headers })).status, 403);
  assert.equal((await request(matchUrl('http://mysite.local/about'), { headers })).status, 403);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /allowedHosts に "mysite\.local" を追加/);

  // 設定ファイルに書けば、serve を再起動しなくても通る。書いていないほかの .local は拒否したまま
  fs.writeFileSync(path.join(dir, 'design-diff.config.json'), JSON.stringify({ allowedHosts: ['mysite.local'] }));
  assert.equal((await request(matchUrl('http://mysite.local/'), { headers })).status, 200);
  assert.equal((await request(matchUrl('http://printer.local/'), { headers: { Origin: 'http://printer.local' } })).status, 403);
});
