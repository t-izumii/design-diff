/*
 * overlay.js のパネルを起動・停止する。
 * ローカル開発のページでは autostart.js が開いた時点で起動し、それ以外のページでは拡張のボタンを押すと background.js が起動する。
 */
(() => {
  // 拡張のボタンで読み込み直しても、二重に定義しない
  if (globalThis.__designDiffLoader) return;

  // CLI（design-diff serve）の待ち受け先。--port を変えた場合はここも合わせる
  const SERVER = 'http://localhost:4567';

  // 拡張のボタンで起動したときの送り方。CLI への要求は background.js が送る
  // content script から送るとページのオリジンが付き、CLI はローカル開発以外のページからの要求を拒否するため
  const viaExtension = {
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
  // 起動中の送り方。'page' はページから CLI に問い合わせ、'extension' は background.js を経由する
  let mode = null;
  let lastUrl = '';
  let timer = 0;

  function start(via) {
    if (mode) return true;
    mode = via;
    const options = via === 'extension' ? { transport: viaExtension } : {};
    const load = () => {
      lastUrl = pageKey();
      globalThis.__designDiff.load(SERVER, options);
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
    mode = null;
    globalThis.__designDiff.unmount();
    return false;
  }

  // 拡張のボタン。自動で起動したのにパネルが出ていない場合（.local を allowedHosts に書いていないなど）は、拡張経由で起動し直す
  function toggle() {
    if (mode === 'extension' || (mode === 'page' && globalThis.__designDiff.isMounted())) return stop();
    stop();
    return start('extension');
  }

  // 戻り値は起動中かどうか。background.js がボタンの表示に使う
  globalThis.__designDiffLoader = { start, stop, toggle };
})();
