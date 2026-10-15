import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, syncSettings, updateSettings, loadSettings, loadConfig, routeLabel } from '../lib/scan.js';

// 1x1 の PNG。中身は走査では見ないが、画像として正しいものにしておく
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-diff-test-'));
  created.push(dir);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content ?? PNG);
  }
  return dir;
}

const routes = (entries) => entries.map((e) => `${routeLabel(e.segments)} ${e.images.map((i) => i.name).join(',')}`);

test('フォルダの階層をそのままページのパスとして読む', () => {
  const dir = makeDir({
    'index/TOP.png': null,
    'index/TOP 10.png': null,
    'index/TOP 2.jpg': null,
    'news/_slug/記事詳細.png': null,
    'about/memo.txt': 'not image',
  });
  const { entries, warnings } = scan(dir, {});
  assert.deepEqual(routes(entries).sort(), ['/ TOP 2.jpg,TOP 10.png,TOP.png', '/news/:slug 記事詳細.png']);
  assert.deepEqual(warnings, []);
});

test('以前の版のホスト名のフォルダは読み飛ばして警告し、通常のページ名は読む', () => {
  const dir = makeDir({
    'localhost_8888/index/a.png': null,
    'mysite.local/index/a.png': null,
    '_any/index/a.png': null,
    'campaign_2024/a.png': null,
  });
  const { entries, warnings } = scan(dir, {});
  assert.deepEqual(routes(entries), ['/campaign_2024 a.png']);
  assert.equal(warnings.filter((w) => w.includes('ホスト名のフォルダ')).length, 3);
});

test('画像を移し終えたホスト名のフォルダには警告しない', () => {
  const dir = makeDir({ 'localhost_8888/index/memo.txt': 'not image', 'index/a.png': null });
  assert.deepEqual(scan(dir, {}).warnings, []);
});

test('design-diff/ 直下の画像は無視して警告する', () => {
  const dir = makeDir({ 'top.png': null });
  const { entries, warnings } = scan(dir, {});
  assert.deepEqual(entries, []);
  assert.match(warnings[0], /index フォルダに置いてください/);
});

test('sync はホスト名のフォルダから移した画像の値を引き継ぐ', () => {
  const dir = makeDir({ 'index/a.png': null, 'index/b.png': null });
  fs.writeFileSync(
    path.join(dir, 'images.json'),
    JSON.stringify({ 'localhost_8888/index/a.png': { zoom: 0.5, x: 3, y: -4, scale: 2 } }),
  );
  const result = syncSettings(dir);
  assert.deepEqual(result.added, ['index/b.png']);
  assert.deepEqual(result.removed, ['localhost_8888/index/a.png']);
  assert.deepEqual(loadSettings(dir), {
    'index/a.png': { zoom: 0.5, x: 3, y: -4 },
    'index/b.png': { zoom: 1, x: 0, y: 0 },
  });
});

test('パネルからの保存は design-diff/ にある画像だけを書き換える', () => {
  const dir = makeDir({ 'index/a.png': null });
  assert.deepEqual(updateSettings(dir, 'index/a.png', { x: 5 }), { zoom: 1, x: 5, y: 0 });
  assert.equal(updateSettings(dir, '../outside.png', { x: 1 }), null);
  assert.equal(updateSettings(dir, 'index/none.png', { x: 1 }), null);
  assert.deepEqual(Object.keys(loadSettings(dir)), ['index/a.png']);
});

// Windows ではシンボリックリンクの作成に権限が要るため省く
const noSymlink = process.platform === 'win32';

test('design-diff/ の外を指すシンボリックリンクの画像は使わない', { skip: noSymlink }, () => {
  const dir = makeDir({ 'index/a.png': null });
  const outside = makeDir({ 'secret.png': 'secret' });
  fs.symlinkSync(path.join(outside, 'secret.png'), path.join(dir, 'index/leak.png'));
  fs.symlinkSync('a.png', path.join(dir, 'index/link.png'));
  const { entries, warnings } = scan(dir, {});
  assert.deepEqual(routes(entries), ['/ a.png,link.png']);
  assert.deepEqual(warnings, ['design-diff/ の外を指すシンボリックリンクは使えないため無視しました: index/leak.png']);
});

test('images.json がシンボリックリンクでも、リンク先には書き込まない', { skip: noSymlink }, () => {
  const dir = makeDir({ 'index/a.png': null });
  const target = path.join(makeDir({}), 'target.txt');
  fs.symlinkSync(target, path.join(dir, 'images.json'));
  syncSettings(dir);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.lstatSync(path.join(dir, 'images.json')).isSymbolicLink(), false);
  assert.deepEqual(loadSettings(dir), { 'index/a.png': { zoom: 1, x: 0, y: 0 } });
  // 一時ファイルを残さない
  assert.deepEqual(fs.readdirSync(dir).sort(), ['images.json', 'index']);
});

test('design-diff/ の外を指す images.json と設定ファイルは読み込まない', { skip: noSymlink }, () => {
  const dir = makeDir({ 'index/a.png': null });
  const secret = path.join(makeDir({ 'secret.json': '{"token":"secret"}' }), 'secret.json');
  fs.symlinkSync(secret, path.join(dir, 'images.json'));
  fs.symlinkSync(secret, path.join(dir, 'design-diff.config.json'));
  assert.throws(() => loadSettings(dir), /シンボリックリンク/);
  assert.throws(() => loadConfig(dir), /シンボリックリンク/);
  assert.throws(() => updateSettings(dir, 'index/a.png', { x: 1 }), /シンボリックリンク/);
  assert.equal(fs.readFileSync(secret, 'utf8'), '{"token":"secret"}');
});
