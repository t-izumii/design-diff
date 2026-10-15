/*
 * design-diff overlay
 * Chrome拡張の content script として読み込むほか、CLI の /overlay.js を script タグで読み込んでも動く。
 * content script の隔離された環境では customElements が使えないため、通常の div に Shadow DOM を付ける。
 */
(() => {
  if (globalThis.__designDiff) return;

  const STORE_PREFIX = 'design-diff:';
  // パネルの位置はページをまたいで共通にする
  const PANEL_STORE_KEY = `${STORE_PREFIX}panel`;
  // 倍率と位置（X・Y）は案件ごとの images.json に CLI 経由で保存するため、ここには保存しない
  const DEFAULT_STATE = { visible: true, opacity: 0.5, blend: 'normal', image: '', collapsed: false };
  // 矢印キーの連打などで書き込みが続かないよう、操作が止まってから保存する
  const SAVE_DELAY = 400;
  const ZOOM_STEP = 0.1;
  const ZOOM_MIN = 0.01;
  const ZOOM_MAX = 10;
  const PANEL_MARGIN = 12;

  let current = null;

  // クエリや # にはトークンなどが含まれうるため、照合に使うオリジンとパスだけを送る
  async function load(server, pageUrl = location.origin + location.pathname) {
    unmount();
    let data;
    try {
      const res = await fetch(`${server}/api/match?url=${encodeURIComponent(pageUrl)}`);
      if (!res.ok) return false;
      data = sanitize(await res.json(), server);
    } catch {
      return false; // CLI が起動していなければ何もしない
    }
    if (!data) return false;
    current = mount(data);
    return true;
  }

  // ポート上で応答したのが本物の CLI とは限らないため、応答は型と値を確かめてから使う
  function sanitize(data, server) {
    if (!data || typeof data.route !== 'string' || !Array.isArray(data.images)) return null;
    const origin = new URL(server).origin;
    const images = data.images
      .filter((img) => img && typeof img.name === 'string' && typeof img.file === 'string' && isFrom(img.src, origin))
      .map((img) => ({
        name: img.name,
        file: img.file,
        src: img.src,
        zoom: Number.isFinite(img.zoom) && img.zoom > 0 ? toZoom(img.zoom) : 1,
        x: Number.isFinite(img.x) ? img.x : 0,
        y: Number.isFinite(img.y) ? img.y : 0,
      }));
    return images.length ? { server: origin, route: data.route, images } : null;
  }

  // 画像は CLI 自身が配信するものだけを読み込む
  function isFrom(src, origin) {
    try {
      return typeof src === 'string' && new URL(src).origin === origin;
    } catch {
      return false;
    }
  }

  function unmount() {
    current?.destroy();
    current = null;
  }

  // 0.1 ずつの増減で 0.30000000000000004 のような値にならないよう、0.01 単位に丸める
  function toZoom(value) {
    const n = Math.round(Number(value) * 100) / 100;
    return Number.isFinite(n) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n)) : 1;
  }

  function mount(data) {
    const storeKey = `${STORE_PREFIX}${location.host}${data.route}`;
    // 以前の版で保存した x・y・zoom・breakpoint・fit などは読み込まない
    const stored = readStore(storeKey);
    const state = { ...DEFAULT_STATE };
    for (const key of Object.keys(DEFAULT_STATE)) if (key in stored) state[key] = stored[key];
    const save = () => writeStore(storeKey, state);

    const host = document.createElement('div');
    host.setAttribute('data-design-diff', '');
    host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;';
    // host に z-index を付けると重なりの文脈が閉じ、差分（mix-blend-mode）がページと合成されなくなる
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="layer"><img alt="" draggable="false"></div>
      <section class="panel" aria-label="Design Diff">
        <header class="panel-header" title="ドラッグでパネルを移動">
          <span class="grip" aria-hidden="true"></span>
          <strong class="title">Design Diff</strong>
          <span class="route"></span>
          <button type="button" class="icon-button corner" aria-label="パネルを次の隅へ移動" title="パネルを次の隅へ移動">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>
          </button>
          <button type="button" class="icon-button collapse" aria-label="操作パネル" aria-controls="panel-body">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
          </button>
        </header>
        <div class="panel-body" id="panel-body">
          <div class="group">
            <label class="switch-row">
              <span>重ねて表示 <kbd>Alt+Shift+D</kbd></span>
              <input type="checkbox" role="switch" name="visible">
            </label>
            <label class="field">
              <span class="field-label">画像</span>
              <select name="image"></select>
            </label>
            <label class="field">
              <span class="field-label">不透明度</span>
              <span class="range">
                <input type="range" name="opacity" min="0" max="1" step="0.05">
                <output></output>
              </span>
            </label>
            <div class="field">
              <span class="field-label" id="blend-label">重ね方</span>
              <div class="segmented" role="radiogroup" aria-labelledby="blend-label">
                <label><input type="radio" name="blend" value="normal"><span>通常</span></label>
                <label><input type="radio" name="blend" value="difference"><span>差分</span></label>
              </div>
            </div>
          </div>
          <div class="group">
            <div class="field">
              <label class="field-label" for="zoom">倍率</label>
              <div class="stepper">
                <button type="button" class="step-button" data-zoom="-1" aria-label="倍率を0.1下げる">−</button>
                <input type="number" id="zoom" name="zoom" min="${ZOOM_MIN}" max="${ZOOM_MAX}" step="0.01" inputmode="decimal">
                <button type="button" class="step-button" data-zoom="1" aria-label="倍率を0.1上げる">＋</button>
                <button type="button" class="text-button zoom-reset">1x</button>
              </div>
            </div>
            <div class="field" role="group" aria-labelledby="offset-label">
              <span class="field-label" id="offset-label">位置</span>
              <div class="offset">
                <label><span>X</span><input type="number" name="x" step="1"></label>
                <label><span>Y</span><input type="number" name="y" step="1"></label>
                <button type="button" class="text-button reset">0に戻す</button>
              </div>
            </div>
            <p class="hint"><kbd>Alt+Shift+矢印</kbd> で1px移動。倍率と位置は images.json に自動で保存</p>
          </div>
          <p class="info"></p>
          <p class="error" role="status"></p>
        </div>
      </section>`;

    const $ = (sel) => root.querySelector(sel);
    const layer = $('.layer');
    const img = $('img');
    const panel = $('.panel');
    const header = $('.panel-header');
    const form = {
      visible: $('[name=visible]'),
      opacity: $('[name=opacity]'),
      blend: [...root.querySelectorAll('[name=blend]')],
      image: $('[name=image]'),
      zoom: $('[name=zoom]'),
      x: $('[name=x]'),
      y: $('[name=y]'),
    };
    $('.route').textContent = data.route;
    $('.route').title = data.route;

    // 応答由来の文字列は innerHTML に入れず、テキストとして扱う
    form.image.replaceChildren(...data.images.map((i) => new Option(i.name, i.name)));
    if (!data.images.some((i) => i.name === state.image)) state.image = data.images[0].name;
    // 画像ごとの倍率と位置。初期値は images.json の値で、変更すると CLI に保存を依頼する
    const adjustments = new Map(data.images.map((i) => [i.name, { zoom: i.zoom, x: i.x, y: i.y }]));
    const currentAdjustment = () => adjustments.get(state.image);
    const currentImage = () => data.images.find((i) => i.name === state.image);

    function render() {
      // スクロールバーを除いた幅で配置する
      const viewport = document.documentElement.clientWidth;
      const image = currentImage();
      const adjustment = adjustments.get(image.name);
      if (img.getAttribute('src') !== image.src) {
        img.src = image.src;
        $('.error').textContent = '';
      }

      // 1x は画像の実寸どおり。読み込み前は画面幅を仮の幅にする
      const naturalWidth = img.naturalWidth || viewport;
      const width = naturalWidth * adjustment.zoom;

      // 位置調整や拡大で画像がはみ出しても、ページに横スクロールを出さない
      layer.style.width = `${viewport}px`;
      layer.hidden = !state.visible;
      layer.style.opacity = String(state.opacity);
      layer.style.mixBlendMode = state.blend;
      img.style.width = `${width}px`;
      img.style.transform = `translate(${adjustment.x}px, ${adjustment.y}px)`;
      $('.info').textContent = `画像 ${naturalWidth}px → 表示 ${round(width)}px（画面 ${viewport}px）`;
    }

    // typing には入力中の欄の名前を渡す。その欄だけは書き換えない（「1.」の途中などで値が消えないように）
    function syncForm(typing) {
      form.visible.checked = state.visible;
      form.opacity.value = String(state.opacity);
      $('output').textContent = `${Math.round(state.opacity * 100)}%`;
      for (const radio of form.blend) radio.checked = radio.value === state.blend;
      form.image.value = state.image;
      const adjustment = currentAdjustment();
      if (typing !== 'zoom') form.zoom.value = adjustment.zoom.toFixed(2);
      if (typing !== 'x') form.x.value = String(adjustment.x);
      if (typing !== 'y') form.y.value = String(adjustment.y);
      panel.classList.toggle('is-collapsed', state.collapsed);
      $('.collapse').setAttribute('aria-expanded', String(!state.collapsed));
      $('.collapse').title = state.collapsed ? 'パネルを開く' : 'パネルを折りたたむ';
    }

    function update(patch, typing) {
      Object.assign(state, patch);
      save();
      syncForm(typing);
      render();
      placePanel();
    }

    function adjust(patch, typing) {
      Object.assign(currentAdjustment(), patch);
      syncForm(typing);
      render();
      scheduleSave(currentImage());
    }

    // 保存待ちの画像。ページを離れるときは待たずに送る
    const pending = new Map();

    function scheduleSave(image) {
      clearTimeout(pending.get(image.name)?.timer);
      pending.set(image.name, { image, timer: setTimeout(() => saveNow(image.name), SAVE_DELAY) });
    }

    async function saveNow(name, keepalive = false) {
      const item = pending.get(name);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(name);
      const { zoom, x, y } = adjustments.get(name);
      try {
        const res = await fetch(`${data.server}/api/images`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: item.image.file, zoom, x, y }),
          keepalive,
        });
        if (!res.ok) throw new Error(String(res.status));
        if (!pending.size) $('.error').textContent = '';
      } catch {
        $('.error').textContent = 'images.json に保存できませんでした。CLI が起動しているか確認してください';
      }
    }

    function flushSaves() {
      for (const name of [...pending.keys()]) saveNow(name, true);
    }

    root.addEventListener('input', (e) => {
      const { name, type, checked, value } = e.target;
      if (!(name in form)) return;
      if (name === 'x' || name === 'y') adjust({ [name]: Number(value) || 0 }, name);
      else if (name === 'zoom') {
        // 空欄や入力途中は反映を待つ
        if (value !== '' && Number(value) > 0) adjust({ zoom: toZoom(value) }, name);
      } else if (type === 'checkbox') update({ [name]: checked });
      else if (type === 'range') update({ [name]: Number(value) || 0 });
      else update({ [name]: value });
    });
    // 入力を終えたら、丸めた値や確定前の値を欄に戻す
    for (const field of [form.zoom, form.x, form.y]) field.addEventListener('change', () => syncForm());
    for (const button of root.querySelectorAll('[data-zoom]')) {
      button.addEventListener('click', () => adjust({ zoom: toZoom(currentAdjustment().zoom + Number(button.dataset.zoom) * ZOOM_STEP) }));
    }
    $('.zoom-reset').addEventListener('click', () => adjust({ zoom: 1 }));
    $('.reset').addEventListener('click', () => adjust({ x: 0, y: 0 }));
    $('.collapse').addEventListener('click', () => update({ collapsed: !state.collapsed }));
    img.addEventListener('load', render);
    img.addEventListener('error', () => {
      $('.error').textContent = '画像を読み込めませんでした';
    });

    // パネルの位置。未設定なら右下（CSS の既定）に置き、設定済みなら画面内に収まるよう調整する
    let panelPos = readStore(PANEL_STORE_KEY);

    function placePanel() {
      if (!Number.isFinite(panelPos.left) || !Number.isFinite(panelPos.top)) {
        panel.style.removeProperty('left');
        panel.style.removeProperty('top');
        panel.classList.remove('is-placed');
        return;
      }
      const maxLeft = Math.max(0, document.documentElement.clientWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
      panel.classList.add('is-placed');
      panel.style.left = `${Math.min(maxLeft, Math.max(0, panelPos.left))}px`;
      panel.style.top = `${Math.min(maxTop, Math.max(0, panelPos.top))}px`;
    }

    function savePanel(pos) {
      panelPos = pos;
      writeStore(PANEL_STORE_KEY, panelPos);
      placePanel();
    }

    // ドラッグできない場合の代わりに、ボタンで 右下 → 左下 → 左上 → 右上 の順に移動する
    $('.corner').addEventListener('click', () => {
      const rect = panel.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const right = rect.left + rect.width / 2 > viewportWidth / 2;
      const bottom = rect.top + rect.height / 2 > window.innerHeight / 2;
      const [nextRight, nextBottom] = right && bottom ? [false, true] : !right && bottom ? [false, false] : !right ? [true, false] : [true, true];
      savePanel({
        left: nextRight ? viewportWidth - rect.width - PANEL_MARGIN : PANEL_MARGIN,
        top: nextBottom ? window.innerHeight - rect.height - PANEL_MARGIN : PANEL_MARGIN,
      });
    });

    let drag = null;
    header.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      header.setPointerCapture(e.pointerId);
      panel.classList.add('is-dragging');
    });
    header.addEventListener('pointermove', (e) => {
      if (!drag) return;
      panelPos = { left: e.clientX - drag.dx, top: e.clientY - drag.dy };
      placePanel();
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      panel.classList.remove('is-dragging');
      savePanel(panelPos);
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);

    function onKeydown(e) {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (e.code === 'KeyD') {
        e.preventDefault();
        update({ visible: !state.visible });
      } else if (moves[e.code]) {
        e.preventDefault();
        const [dx, dy] = moves[e.code];
        const { x, y } = currentAdjustment();
        adjust({ x: x + dx, y: y + dy });
      }
    }

    function onResize() {
      render();
      placePanel();
    }

    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('pagehide', flushSaves);
    document.documentElement.appendChild(host);
    syncForm();
    render();
    placePanel();

    return {
      destroy() {
        flushSaves();
        window.removeEventListener('keydown', onKeydown, true);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('pagehide', flushSaves);
        host.remove();
      },
    };
  }

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function readStore(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '{}');
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // 保存できなくても表示は続ける
    }
  }

  const STYLE = `
    :host { all: initial; }
    .layer { position: absolute; top: 0; left: 0; z-index: 2147483646; overflow-x: clip; pointer-events: none; }
    .layer[hidden] { display: none; }
    .layer img { display: block; max-width: none; height: auto; user-select: none; }

    .panel {
      --bg: rgb(24 24 27 / 0.96);
      --surface: #27272a;
      --border: #52525b;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --accent: #60a5fa;
      --accent-strong: #2563eb;
      --danger: #fca5a5;
      --radius: 6px;
      position: fixed; right: ${PANEL_MARGIN}px; bottom: ${PANEL_MARGIN}px; z-index: 2147483647;
      width: 272px; max-width: calc(100vw - ${PANEL_MARGIN * 2}px);
      color-scheme: dark;
      font: 12px/1.5 system-ui, -apple-system, "Hiragino Sans", sans-serif; color: var(--text);
      background: var(--bg); border: 1px solid rgb(255 255 255 / 0.08); border-radius: 10px;
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
    }
    .panel.is-placed { right: auto; bottom: auto; }
    .panel.is-dragging { opacity: 0.85; }

    .panel-header {
      display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 8px;
      cursor: grab; user-select: none; touch-action: none;
      border-bottom: 1px solid rgb(255 255 255 / 0.08);
    }
    .is-dragging .panel-header { cursor: grabbing; }
    .is-collapsed .panel-header { border-bottom: 0; }
    .grip {
      width: 6px; height: 14px; flex: none; opacity: 0.5;
      background-image: radial-gradient(currentColor 1px, transparent 1.5px);
      background-size: 3px 4px;
    }
    .title { font-weight: 600; white-space: nowrap; }
    .route { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }

    .panel-body { display: grid; gap: 10px; padding: 10px; }
    .is-collapsed .panel-body { display: none; }
    .group { display: grid; gap: 8px; }
    .group + .group { padding-top: 10px; border-top: 1px solid rgb(255 255 255 / 0.08); }

    .field { display: grid; grid-template-columns: 56px minmax(0, 1fr); align-items: center; gap: 8px; }
    .field-label { color: var(--muted); }
    .switch-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 24px; cursor: pointer; }

    p { margin: 0; }
    .hint { color: var(--muted); font-size: 11px; }
    .info { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .error { color: var(--danger); }
    .error:empty { display: none; }
    kbd {
      font: 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted);
      padding: 2px 4px; border: 1px solid var(--border); border-radius: 4px;
    }

    button, select, input { font: inherit; color: var(--text); margin: 0; }
    select, input[type=number] {
      box-sizing: border-box; width: 100%; min-width: 0; height: 28px; padding: 0 8px;
      background-color: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    }
    select {
      appearance: none; padding-right: 26px; text-overflow: ellipsis; cursor: pointer;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4' fill='none' stroke='%23a1a1aa' stroke-width='1.5'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 8px center; background-size: 12px;
    }
    /* 狭い欄で値が隠れないよう、スピンボタンは出さない（矢印キーでの増減は使える） */
    input[type=number] { font-variant-numeric: tabular-nums; appearance: textfield; }
    input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { appearance: none; margin: 0; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

    .range { display: flex; align-items: center; gap: 8px; }
    .range input { flex: 1; min-width: 0; margin: 0; accent-color: var(--accent-strong); }
    output { width: 34px; text-align: right; font-variant-numeric: tabular-nums; }

    input[role=switch] {
      appearance: none; flex: none; position: relative; width: 32px; height: 18px; margin: 0; cursor: pointer;
      background: var(--border); border-radius: 9px; transition: background-color 0.15s;
    }
    input[role=switch]::before {
      content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
      background: #fff; border-radius: 50%; transition: transform 0.15s;
    }
    input[role=switch]:checked { background: var(--accent-strong); }
    input[role=switch]:checked::before { transform: translateX(14px); }

    .segmented { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; padding: 2px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
    .segmented label { position: relative; cursor: pointer; }
    .segmented input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
    .segmented span { display: block; padding: 2px 0; text-align: center; border-radius: 4px; color: var(--muted); }
    .segmented input:checked + span { background: var(--accent-strong); color: #fff; }
    .segmented input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 1px; }

    .stepper { display: grid; grid-template-columns: 28px minmax(0, 1fr) 28px auto; gap: 4px; }
    .stepper input { text-align: center; padding: 0 4px; }
    .offset { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 6px; }
    .offset label { display: flex; align-items: center; gap: 4px; min-width: 0; color: var(--muted); }

    .step-button, .text-button, .icon-button {
      height: 28px; padding: 0 8px; cursor: pointer; white-space: nowrap;
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    }
    .step-button { padding: 0; }
    .step-button:hover, .text-button:hover, .icon-button:hover { background: #3f3f46; }
    .icon-button { display: grid; place-items: center; flex: none; width: 26px; height: 26px; padding: 0; background: transparent; border-color: transparent; }
    .icon-button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
    .collapse svg { transition: transform 0.15s; }
    .collapse[aria-expanded=false] svg { transform: rotate(180deg); }

    @media (prefers-reduced-motion: reduce) {
      input[role=switch], input[role=switch]::before, .collapse svg { transition: none; }
    }
  `;

  globalThis.__designDiff = { load, unmount };

  // script タグで読み込まれた場合は、読み込み元の CLI をそのまま参照して起動する
  const script = document.currentScript;
  if (script?.src) load(new URL(script.src).origin);
})();
