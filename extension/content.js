/*
 * overlay.js のパネルを起動・停止する。拡張のボタンを押すと、background.js がこのファイルを読み込んで呼び出す。
 */
(() => {
  // ボタンを押すたびに読み込まれるため、二重に定義しない
  if (globalThis.__designDiffLoader) return;

  // CLI（design-diff serve）の待ち受け先。--port を変えた場合はここも合わせる
  const SERVER = 'http://localhost:4567';

  // CLI への要求は background.js が送る
  // content script から送るとページのオリジンが付き、CLI はローカル開発以外のページからの要求を拒否するため
  const transport = {
    getJson: (url) => request({ url }),
    postJson: async (url, body) => (await request({ url, method: 'POST', body })) !== null,
    loadImage: (url) => request({ url, as: 'image' }),
  };

  // 失敗した場合は null を返す
  async function request(message) {
    const res = await chrome.runtime.sendMessage({ type: 'design-diff:request', ...message });
    return res?.ok ? res.body : null;
  }

  const pageKey = () => location.origin + location.pathname;
  let running = false;
  let lastUrl = '';
  let timer = 0;

  function start() {
    if (running) return true;
    running = true;
    const load = () => {
      lastUrl = pageKey();
      globalThis.__designDiff.load(SERVER, { transport });
    };
    load();
    // SPA など、再読み込みなしでパスが変わった場合に画像を切り替える（# の変化は無視する）
    timer = setInterval(() => {
      if (pageKey() !== lastUrl) load();
    }, 1000);
    return true;
  }

  function stop() {
    clearInterval(timer);
    running = false;
    globalThis.__designDiff.unmount();
    return false;
  }

  // 戻り値は起動中かどうか。background.js がボタンの表示に使う
  globalThis.__designDiffLoader = { start, stop, toggle: () => (running ? stop() : start()) };
})();
