// CLI（design-diff serve）の待ち受け先。--port を変えた場合はここも合わせる
const SERVER = 'http://localhost:4567';

const pageKey = () => location.origin + location.pathname;
let lastUrl = pageKey();
globalThis.__designDiff.load(SERVER);

// SPA など、再読み込みなしでパスが変わった場合に画像を切り替える（# の変化は無視する）
setInterval(() => {
  if (pageKey() === lastUrl) return;
  lastUrl = pageKey();
  globalThis.__designDiff.load(SERVER);
}, 1000);
