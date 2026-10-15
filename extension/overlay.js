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
  // locked が false のあいだは、矢印キーで画像を動かす
  const DEFAULT_STATE = { visible: true, opacity: 0.5, blend: 'normal', image: '', collapsed: false, locked: true };
  // 矢印キーの連打などで書き込みが続かないよう、操作が止まってから保存する
  const SAVE_DELAY = 400;
  // 位置の移動量。Shift を押しながらだと大きく動かす
  const MOVE_STEP = 1;
  const MOVE_STEP_LARGE = 10;
  const BLENDS = ['normal', 'invert'];
  const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const ZOOM_STEP = 0.1;
  const ZOOM_STEP_FINE = 0.01;
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
    // 以前の版の「差分」は「反転」に置き換えた
    if (state.blend === 'difference') state.blend = 'invert';
    if (!BLENDS.includes(state.blend)) state.blend = DEFAULT_STATE.blend;
    const save = () => writeStore(storeKey, state);

    const host = document.createElement('div');
    host.setAttribute('data-design-diff', '');
    host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;';
    const root = host.attachShadow({ mode: 'open' });
    // 画像は CORS で読み込む。CLI は Origin の付かない要求には画像を返さない
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="layer"><img alt="" draggable="false" crossorigin="anonymous"></div>
      <section class="panel" aria-label="Design Diff">
        <header class="panel-header" title="ドラッグでパネルを移動">
          <svg class="mark" viewBox="0 0 18 18" aria-hidden="true">
            <g class="mark-plate mark-cyan"><circle cx="9" cy="9" r="4.25"/><path d="M9 1.5v15M1.5 9h15"/></g>
            <g class="mark-plate mark-magenta"><circle cx="9" cy="9" r="4.25"/><path d="M9 1.5v15M1.5 9h15"/></g>
          </svg>
          <strong class="title">Design Diff</strong>
          <span class="header-actions">
            <button type="button" class="icon-button toggle visible-toggle" aria-label="重ねて表示" title="重ねて表示（Alt+Shift+D）">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path class="when-off" d="M2.5 2.5l11 11"/></svg>
            </button>
            <button type="button" class="icon-button toggle invert-toggle" aria-label="色を反転" title="色を反転">
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path class="fill" d="M8 2.5a5.5 5.5 0 0 1 0 11z"/></svg>
            </button>
            <button type="button" class="icon-button toggle lock" aria-label="位置をロック">
              <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path class="when-on" d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/><path class="when-off" d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/></svg>
            </button>
          </span>
          <button type="button" class="icon-button collapse" aria-label="操作パネル" aria-controls="panel-body">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
          </button>
        </header>
        <div class="panel-body" id="panel-body">
          <div class="group">
            <div class="field">
              <span class="field-label">ページ</span>
              <span class="route"></span>
            </div>
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
          </div>
          <div class="group" role="group" aria-labelledby="adjust-title">
            <p class="group-head"><span class="group-title" id="adjust-title">倍率と位置</span><span>images.json に保存</span></p>
            <div class="field">
              <label class="field-label" for="zoom">倍率</label>
              <div class="zoom-controls">
                <div class="stepper">
                  <button type="button" class="stepper-button" data-zoom="-1" aria-label="倍率を0.1下げる"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7"/></svg></button>
                  <input type="number" id="zoom" name="zoom" min="${ZOOM_MIN}" max="${ZOOM_MAX}" step="0.01" inputmode="decimal">
                  <button type="button" class="stepper-button" data-zoom="1" aria-label="倍率を0.1上げる"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7M6 2.5v7"/></svg></button>
                </div>
                <button type="button" class="text-button zoom-reset">1xに戻す</button>
              </div>
            </div>
            <div class="field" role="group" aria-labelledby="offset-label">
              <span class="field-label" id="offset-label">位置</span>
              <div class="offset-controls">
                <label class="axis"><span>X</span><input type="number" name="x" step="1"></label>
                <label class="axis"><span>Y</span><input type="number" name="y" step="1"></label>
                <button type="button" class="text-button offset-reset">0に戻す</button>
              </div>
            </div>
            <p class="hint">ロック解除中は矢印キーで移動、<kbd>Shift</kbd>で10px</p>
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
      opacity: $('[name=opacity]'),
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
      // 色を反転して重ねる。不透明度 50% なら一致する部分が灰色になり、ずれた部分が浮き出る
      img.style.filter = state.blend === 'invert' ? 'invert(1)' : '';
      img.style.width = `${width}px`;
      img.style.transform = `translate(${adjustment.x}px, ${adjustment.y}px)`;
      $('.info').textContent = `画像 ${naturalWidth}px → 表示 ${round(width)}px（画面 ${viewport}px）`;
    }

    // typing には入力中の欄の名前を渡す。その欄だけは書き換えない（「1.」の途中などで値が消えないように）
    function syncForm(typing) {
      $('.visible-toggle').setAttribute('aria-pressed', String(state.visible));
      $('.invert-toggle').setAttribute('aria-pressed', String(state.blend === 'invert'));
      $('.lock').setAttribute('aria-pressed', String(state.locked));
      $('.lock').title = state.locked ? '位置をロック中（クリックで解除すると矢印キーで移動できる）' : 'ロック解除中：矢印キーで移動（Shift で10px）。クリックでロック';
      form.opacity.value = String(state.opacity);
      form.opacity.style.setProperty('--fill', `${state.opacity * 100}%`);
      $('output').textContent = `${Math.round(state.opacity * 100)}%`;
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
      const { name, type, value } = e.target;
      if (!(name in form)) return;
      if (name === 'x' || name === 'y') adjust({ [name]: Number(value) || 0 }, name);
      else if (name === 'zoom') {
        // 空欄や入力途中は反映を待つ
        if (value !== '' && Number(value) > 0) adjust({ zoom: toZoom(value) }, name);
      } else if (type === 'range') update({ [name]: Number(value) || 0 });
      else update({ [name]: value });
    });
    // 入力を終えたら、丸めた値や確定前の値を欄に戻す
    for (const field of [form.zoom, form.x, form.y]) field.addEventListener('change', () => syncForm());
    for (const button of root.querySelectorAll('[data-zoom]')) {
      button.addEventListener('click', () => adjust({ zoom: toZoom(currentAdjustment().zoom + Number(button.dataset.zoom) * ZOOM_STEP) }));
    }
    $('.zoom-reset').addEventListener('click', () => adjust({ zoom: 1 }));
    $('.offset-reset').addEventListener('click', () => adjust({ x: 0, y: 0 }));
    $('.collapse').addEventListener('click', () => update({ collapsed: !state.collapsed }));
    $('.visible-toggle').addEventListener('click', () => update({ visible: !state.visible }));
    $('.invert-toggle').addEventListener('click', () => update({ blend: state.blend === 'invert' ? 'normal' : 'invert' }));
    $('.lock').addEventListener('click', () => update({ locked: !state.locked }));
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
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyD') {
        e.preventDefault();
        update({ visible: !state.visible });
        return;
      }
      // ロック解除中は、矢印キーで押した方向へ 1px（Shift で 10px）動かす
      const direction = ARROWS[e.key];
      if (!direction || state.locked || e.altKey || e.ctrlKey || e.metaKey) return;
      // 入力欄や選択欄では、矢印キーを本来の操作（カーソル移動・値の増減）に使う
      if (isEditable(e.composedPath()[0])) return;
      e.preventDefault();
      const step = e.shiftKey ? MOVE_STEP_LARGE : MOVE_STEP;
      const { x, y } = currentAdjustment();
      adjust({ x: x + direction[0] * step, y: y + direction[1] * step });
    }

    // 数値の欄は編集中に ↑↓ で増減し、Shift を押すと 10 倍ずつ動かす（標準の数値欄は Shift でも同じ量）
    const fieldSteps = [
      [form.x, MOVE_STEP, MOVE_STEP_LARGE],
      [form.y, MOVE_STEP, MOVE_STEP_LARGE],
      [form.zoom, ZOOM_STEP_FINE, ZOOM_STEP],
    ];
    for (const [field, step, largeStep] of fieldSteps) {
      field.addEventListener('keydown', (e) => {
        if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        const delta = (e.shiftKey ? largeStep : step) * (e.key === 'ArrowUp' ? 1 : -1);
        const value = currentAdjustment()[field.name] + delta;
        adjust({ [field.name]: field === form.zoom ? toZoom(value) : value });
      });
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

  function isEditable(el) {
    return el instanceof Element && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
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

    /* 印刷の見当合わせ（版のずれの確認）に寄せた配色。強調はシアンだけにし、マゼンタは見出しのマークにだけ使う */
    .panel {
      --surface: rgb(30 32 38 / 0.94);
      --field: rgb(255 255 255 / 0.06);
      --field-hover: rgb(255 255 255 / 0.1);
      --line: rgb(255 255 255 / 0.08);
      --text: #eceef2;
      --muted: #9ba2ad;
      --cyan: #2bb8ec;
      --cyan-tint: rgb(43 184 236 / 0.16);
      --cyan-tint-hover: rgb(43 184 236 / 0.24);
      --magenta: #ec2c8c;
      --danger: #ff8f8f;
      --radius: 6px;
      position: fixed; right: ${PANEL_MARGIN}px; bottom: ${PANEL_MARGIN}px; z-index: 2147483647;
      /* 幅は文字の大きさの倍数で持ち、下の font の大きさを変えると幅も合わせて変わる（12px で 288px） */
      box-sizing: border-box; width: 24em; max-width: calc(100vw - ${PANEL_MARGIN * 2}px);
      color-scheme: dark;
      font: 12px/1.5 system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", Meiryo, sans-serif;
      font-feature-settings: "palt";
      color: var(--text);
      background: var(--surface);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
      backdrop-filter: blur(16px) saturate(1.4);
      border: 1px solid var(--line); border-radius: 12px;
      /* 明るいページでも暗いページでも縁が見えるよう、内側の明るい線に外側の暗い線を重ねる */
      box-shadow: 0 0 0 1px rgb(0 0 0 / 0.3), 0 18px 40px -16px rgb(0 0 0 / 0.6);
    }
    .panel.is-placed { right: auto; bottom: auto; }
    .panel.is-dragging { opacity: 0.85; }

    .panel-header {
      display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px;
      cursor: grab; user-select: none; touch-action: none;
      border-bottom: 1px solid var(--line);
    }
    .is-dragging .panel-header { cursor: grabbing; }
    .is-collapsed .panel-header { border-bottom: 0; }
    /* 見当マーク。2 色の版を少しずらして重ね、デザインと実装のずれを表す */
    .mark { width: 18px; height: 18px; flex: none; overflow: visible; }
    .mark-plate { fill: none; stroke-width: 1.25; mix-blend-mode: screen; }
    .mark-cyan { stroke: var(--cyan); }
    .mark-magenta { stroke: var(--magenta); transform: translate(1.25px, 1px); }
    .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .header-actions { display: flex; gap: 2px; padding-right: 6px; border-right: 1px solid var(--line); }

    .panel-body { display: grid; gap: 12px; padding: 12px; }
    .is-collapsed .panel-body { display: none; }
    .group { display: grid; gap: 8px; }
    .group + .group { padding-top: 12px; border-top: 1px solid var(--line); }
    p { margin: 0; }
    .group-head { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--muted); }
    .group-title { color: var(--text); font-weight: 600; }

    .field { display: grid; grid-template-columns: 5em minmax(0, 1fr); align-items: center; gap: 8px; }
    .field-label { color: var(--muted); }
    .route { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    button, select, input { font: inherit; color: inherit; margin: 0; }
    button { cursor: pointer; }
    :focus-visible { outline: 2px solid var(--cyan); outline-offset: 1px; }

    select {
      appearance: none; box-sizing: border-box; width: 100%; min-width: 0; height: 28px; padding: 0 26px 0 8px;
      background: var(--field) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4' fill='none' stroke='%239ba2ad' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 8px center / 12px;
      border: 0; border-radius: var(--radius); text-overflow: ellipsis; cursor: pointer;
    }
    select:hover { background-color: var(--field-hover); }

    /* 不透明度。つまみより左（--fill まで）をシアンで塗る */
    .range { display: flex; align-items: center; gap: 10px; }
    input[type=range] { flex: 1; min-width: 0; height: 20px; margin: 0; background: transparent; appearance: none; cursor: pointer; }
    input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--cyan) var(--fill, 0%), rgb(255 255 255 / 0.14) var(--fill, 0%)); }
    input[type=range]::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / 0.5); }
    input[type=range]::-moz-range-track { height: 4px; border-radius: 2px; background: rgb(255 255 255 / 0.14); }
    input[type=range]::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--cyan); }
    input[type=range]::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / 0.5); }
    output { min-width: 3em; text-align: right; font-variant-numeric: tabular-nums; }

    /* 数値欄は倍率の増減と位置の枠の中に置き、背景は枠の側で付ける */
    input[type=number] {
      box-sizing: border-box; width: 100%; min-width: 0; height: 100%; padding: 0 6px;
      background: transparent; border: 0; font-variant-numeric: tabular-nums; appearance: textfield;
    }
    /* 狭い欄で値が隠れないよう、スピンボタンは出さない（矢印キーでの増減は使える） */
    input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { appearance: none; margin: 0; }

    .zoom-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; }
    .stepper { display: grid; grid-template-columns: 28px minmax(0, 1fr) 28px; height: 28px; background: var(--field); border-radius: var(--radius); }
    .stepper input { text-align: center; }
    .stepper input:focus-visible { outline-offset: -2px; }
    .stepper-button { display: grid; place-items: center; padding: 0; color: var(--muted); background: transparent; border: 0; border-radius: var(--radius); }
    .stepper-button:hover { color: var(--text); background: var(--field-hover); }
    .stepper-button svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }

    /* 位置の欄。軸の名前を欄の中に置き、狭い幅でも値を入れる場所を広く取る */
    .offset-controls { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: center; gap: 6px; }
    .axis { display: flex; align-items: center; min-width: 0; height: 28px; padding-left: 8px; color: var(--muted); background: var(--field); border-radius: var(--radius); cursor: text; }
    .axis:hover { background: var(--field-hover); }
    .axis:focus-within { outline: 2px solid var(--cyan); outline-offset: 1px; }
    /* 軸の名前との間は詰め、狭い幅でも桁を多く見せる */
    .axis input { padding-left: 4px; color: var(--text); }
    .axis input:focus-visible { outline: none; }

    .text-button { height: 28px; padding: 0 8px; font-size: 11px; white-space: nowrap; color: var(--muted); background: transparent; border: 0; border-radius: var(--radius); }
    .text-button:hover { color: var(--text); background: var(--field-hover); }

    .icon-button { display: grid; place-items: center; flex: none; width: 28px; height: 28px; padding: 0; color: var(--muted); background: transparent; border: 0; border-radius: var(--radius); }
    .icon-button:hover { color: var(--text); background: var(--field-hover); }
    .icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
    /* オン・オフで形を変えるアイコン（目の斜線、錠の掛け金） */
    .icon-button .fill { fill: currentColor; stroke: none; }
    .icon-button[aria-pressed=true] .when-off, .icon-button[aria-pressed=false] .when-on { display: none; }
    /* 色が付いているボタンがオン（表示中・反転中・ロック中） */
    .toggle[aria-pressed=true] { color: var(--cyan); background: var(--cyan-tint); }
    .toggle[aria-pressed=true]:hover { color: var(--cyan); background: var(--cyan-tint-hover); }
    .collapse svg { transition: transform 0.15s; }
    .collapse[aria-expanded=false] svg { transform: rotate(180deg); }

    .hint, .info { font-size: 11px; color: var(--muted); }
    .info { font-variant-numeric: tabular-nums; }
    .error { color: var(--danger); }
    .error:empty { display: none; }
    kbd { font: inherit; margin: 0 2px; padding: 0 4px; color: var(--text); background: var(--field); border-radius: 4px; }

    /* ハイコントラストモードでは背景色が消えるため、欄やボタンの境界とオンの状態を線で示す */
    @media (forced-colors: active) {
      select, .stepper, .axis, .text-button, .icon-button { border: 1px solid ButtonText; }
      .toggle[aria-pressed=true] { border: 2px solid Highlight; }
    }

    @media (prefers-reduced-motion: reduce) {
      .collapse svg { transition: none; }
    }
  `;

  globalThis.__designDiff = { load, unmount };

  // script タグで読み込まれた場合は、読み込み元の CLI をそのまま参照して起動する
  const script = document.currentScript;
  if (script?.src) load(new URL(script.src).origin);
})();
