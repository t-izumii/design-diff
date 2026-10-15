import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEntry, toSegments } from '../lib/match.js';
import { routeLabel } from '../lib/scan.js';

// design-diff/ に次のフォルダがある状態を表す
const entries = [
  { segments: [] }, //                      index/
  { segments: ['about'] }, //               about/
  { segments: ['news'] }, //                news/
  { segments: ['news', '_slug'] }, //       news/_slug/
  { segments: ['news', 'special'] }, //     news/special/
  { segments: ['blog', '_cat', '_slug'] }, // blog/_cat/_slug/
  { segments: ['campaign_2024'] }, //       campaign_2024/
];

const routeOf = (pathname) => {
  const entry = findEntry(entries, pathname);
  return entry ? routeLabel(entry.segments) : null;
};

test('トップページは index フォルダに一致する', () => {
  assert.equal(routeOf('/'), '/');
  assert.equal(routeOf('/index.html'), '/');
  assert.equal(routeOf(''), '/');
});

test('末尾のスラッシュ・.html・/index.html の違いは同じページとして扱う', () => {
  for (const p of ['/about', '/about/', '/about.html', '/about/index.html']) {
    assert.equal(routeOf(p), '/about', p);
  }
});

test('_slug は記事詳細など1階層分の任意の名前に一致する', () => {
  assert.equal(routeOf('/news/2024-10-01'), '/news/:slug');
  assert.equal(routeOf('/news/hello-world/'), '/news/:slug');
  assert.equal(routeOf('/news/hello-world.html'), '/news/:slug');
  // 日本語のスラッグ（URL ではエスケープされている）
  assert.equal(routeOf('/news/%E8%A8%98%E4%BA%8B'), '/news/:slug');
});

test('_slug より、名前が完全に一致するフォルダを優先する', () => {
  assert.equal(routeOf('/news/special'), '/news/special');
});

test('一覧ページ（/news）と記事詳細（/news/xxx）は別の画像になる', () => {
  assert.equal(routeOf('/news'), '/news');
  assert.equal(routeOf('/news/'), '/news');
});

test('ワイルドカードは1階層分だけで、階層の数が違えば一致しない', () => {
  assert.equal(routeOf('/news/2024/10'), null);
  assert.equal(routeOf('/blog/tech/my-post'), '/blog/:cat/:slug');
  assert.equal(routeOf('/blog/tech'), null);
});

test('対応する画像がないページは一致しない', () => {
  assert.equal(routeOf('/contact'), null);
  // フォルダ名とは大文字・小文字を区別する
  assert.equal(routeOf('/About'), null);
});

test('数字付きのページ名もそのままパスとして扱う', () => {
  assert.equal(routeOf('/campaign_2024'), '/campaign_2024');
});

test('デコードできないパスはエラーにせず一致なしにする', () => {
  assert.equal(toSegments('/news/%E0%A4%A'), null);
  assert.equal(routeOf('/news/%E0%A4%A'), null);
});
