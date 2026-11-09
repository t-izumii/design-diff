/*
 * 拡張のボタンで、開いているタブにデザイン画像を重ねる・やめる。
 * ボタンで起動したタブの CLI への要求はここから送る。content script から送るとページのオリジンが付き、
 * CLI はローカル開発以外のページからの要求を拒否するため。
 */
const SCRIPTS = ['overlay.js', 'content.js'];
// CLI がこの拡張からの要求と見分けるためのヘッダー
const CLIENT_HEADER = { 'X-Design-Diff-Client': 'extension' };
const IMAGE_TYPE = /^image\/(png|jpeg|webp)$/;

// ボタンで起動したタブ。サービスワーカーが止まっても忘れないよう、ブラウザを閉じるまで保存する
const tabKey = (tabId) => `tab:${tabId}`;

async function isEnabled(tabId) {
  const key = tabKey(tabId);
  return Boolean((await chrome.storage.session.get(key))[key]);
}

async function setEnabled(tabId, on) {
  if (on) await chrome.storage.session.set({ [tabKey(tabId)]: true });
  else await chrome.storage.session.remove(tabKey(tabId));
  // タブを閉じたあとなどは表示を変えられないため、失敗は無視する
  await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' }).catch(() => {});
}

// タブにパネルを読み込み、起動（start）または切り替え（toggle）をする。戻り値は起動中かどうか
async function run(tabId, action) {
  await chrome.scripting.executeScript({ target: { tabId }, files: SCRIPTS });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [action],
    func: (name) => {
      const loader = globalThis.__designDiffLoader;
      return name === 'toggle' ? loader.toggle() : loader.start('extension');
    },
  });
  return result?.result === true;
}

async function toggle(tab) {
  try {
    await setEnabled(tab.id, await run(tab.id, 'toggle'));
  } catch (err) {
    // chrome:// のページや Chrome ウェブストアなど、拡張が読み込めないページ
    console.warn(`design-diff: ${err.message}`);
    await setEnabled(tab.id, false);
  }
}

chrome.action.onClicked.addListener(toggle);

// ボタンで起動したタブは、再読み込みや同じサイト内のページ移動のあとも重ね続ける
// 別のサイトに移ると、ボタンで得た権限（activeTab）がなくなって読み込めないため、起動前の状態に戻す
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete' || !(await isEnabled(tabId))) return;
  try {
    await setEnabled(tabId, await run(tabId, 'start'));
  } catch {
    await setEnabled(tabId, false);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(tabKey(tabId)));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'design-diff:request' || sender.id !== chrome.runtime.id || !sender.tab) return false;
  forward(message).then(sendResponse, () => sendResponse({ ok: false }));
  return true;
});

// content script から頼まれた要求を CLI に送る。宛先は手元の CLI の API と画像に限る
async function forward({ url, method = 'GET', body, as }) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(target.hostname) || !isCliPath(method, target.pathname)) {
    return { ok: false };
  }
  const res = await fetch(target, {
    method,
    headers: method === 'POST' ? { ...CLIENT_HEADER, 'Content-Type': 'application/json' } : CLIENT_HEADER,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  });
  if (!res.ok) return { ok: false, status: res.status };
  if (as !== 'image') return { ok: true, body: await res.json() };

  // 拡張のメッセージでは画像のデータをそのまま渡せないため、data: URL にする
  const type = res.headers.get('Content-Type') ?? '';
  if (!IMAGE_TYPE.test(type)) return { ok: false };
  return { ok: true, body: `data:${type};base64,${toBase64(new Uint8Array(await res.arrayBuffer()))}` };
}

function isCliPath(method, pathname) {
  if (method === 'POST') return pathname === '/api/images';
  return method === 'GET' && (pathname === '/api/match' || pathname.startsWith('/images/'));
}

function toBase64(bytes) {
  let binary = '';
  // 一度に渡す引数が多すぎないよう、区切って文字列にする
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
