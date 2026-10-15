/*
 * design-diff overlay
 * Chrome拡張の content script として読み込むほか、CLI の /overlay.js を script タグで読み込んでも動く。
 * content script の隔離された環境では customElements が使えないため、通常の div に Shadow DOM を付ける。
 */
(() => {
  if (globalThis.__designDiff) return;

  const STORE_PREFIX = 'design-diff:';
  const DEFAULT_STATE = { visible: true, opacity: 0.5, blend: 'normal', breakpoint: 'auto', fit: 'fit', x: 0, y: 0, collapsed: false };

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
    if (!data || typeof data.route !== 'string' || !Array.isArray(data.breakpoints) || !Array.isArray(data.images)) return null;
    const origin = new URL(server).origin;
    const breakpoints = data.breakpoints
      .filter((bp) => bp && typeof bp.name === 'string')
      .map((bp) => ({ name: bp.name, designWidth: positive(bp.designWidth), maxWidth: positive(bp.maxWidth) }));
    const images = data.images
      .filter((img) => img && typeof img.breakpoint === 'string' && isFrom(img.src, origin))
      .map((img) => ({ breakpoint: img.breakpoint, scale: positive(img.scale) ?? 1, src: img.src }));
    return images.length ? { route: data.route, breakpoints, images } : null;
  }

  function positive(value) {
    return Number.isFinite(value) && value > 0 ? value : undefined;
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

  function mount(data) {
    const storeKey = `${STORE_PREFIX}${location.host}${data.route}`;
    const state = { ...DEFAULT_STATE, ...readStore(storeKey) };
    const save = () => writeStore(storeKey, state);

    const host = document.createElement('div');
    host.setAttribute('data-design-diff', '');
    host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;';
    // host に z-index を付けると重なりの文脈が閉じ、差分（mix-blend-mode）がページと合成されなくなる
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="layer"><img alt="" draggable="false"></div>
      <section class="panel">
        <header>
          <strong>Design Diff</strong>
          <span class="route"></span>
          <button type="button" class="collapse" aria-label="パネルを折りたたむ"></button>
        </header>
        <div class="body">
          <label class="row"><input type="checkbox" name="visible"> 表示 <kbd>Alt+Shift+D</kbd></label>
          <label class="row">不透明度 <input type="range" name="opacity" min="0" max="1" step="0.05"><output></output></label>
          <label class="row">重ね方
            <select name="blend">
              <option value="normal">通常</option>
              <option value="difference">差分</option>
            </select>
          </label>
          <label class="row">画像
            <select name="breakpoint"></select>
          </label>
          <label class="row">幅
            <select name="fit">
              <option value="fit">表示幅に合わせる</option>
              <option value="center">デザイン幅・中央</option>
              <option value="left">デザイン幅・左</option>
            </select>
          </label>
          <div class="row offset">
            <label>X <input type="number" name="x" step="1"></label>
            <label>Y <input type="number" name="y" step="1"></label>
            <button type="button" class="reset">位置を戻す</button>
          </div>
          <p class="hint">Alt+Shift+矢印で1px移動</p>
          <p class="status" role="status"></p>
        </div>
      </section>`;

    const $ = (sel) => root.querySelector(sel);
    const layer = $('.layer');
    const img = $('img');
    const panel = $('.panel');
    const form = {
      visible: $('[name=visible]'),
      opacity: $('[name=opacity]'),
      blend: $('[name=blend]'),
      breakpoint: $('[name=breakpoint]'),
      fit: $('[name=fit]'),
      x: $('[name=x]'),
      y: $('[name=y]'),
    };
    $('.route').textContent = data.route;

    const available = data.breakpoints.filter((bp) => data.images.some((img) => img.breakpoint === bp.name));
    // 応答由来の文字列は innerHTML に入れず、テキストとして扱う
    form.breakpoint.replaceChildren(new Option('自動', 'auto'), ...available.map((bp) => new Option(bp.name, bp.name)));
    if (state.breakpoint !== 'auto' && !available.some((bp) => bp.name === state.breakpoint)) state.breakpoint = 'auto';

    function pickBreakpoint(viewport) {
      if (state.breakpoint !== 'auto') return data.breakpoints.find((bp) => bp.name === state.breakpoint);
      const sorted = [...data.breakpoints].sort((a, b) => (a.maxWidth ?? Infinity) - (b.maxWidth ?? Infinity));
      return sorted.find((bp) => viewport <= (bp.maxWidth ?? Infinity));
    }

    function render() {
      // スクロールバーを除いた幅で判定・配置する
      const viewport = document.documentElement.clientWidth;
      const bp = pickBreakpoint(viewport);
      const image = bp && data.images.find((i) => i.breakpoint === bp.name);
      const status = $('.status');

      if (!image) {
        img.removeAttribute('src');
        layer.hidden = true;
        status.textContent = `表示幅 ${viewport}px に対応する画像がありません`;
        return;
      }
      if (img.getAttribute('src') !== image.src) img.src = image.src;

      const designWidth = bp.designWidth ?? (img.naturalWidth ? img.naturalWidth / image.scale : viewport);
      const width = state.fit === 'fit' ? viewport : designWidth;
      const left = state.fit === 'center' ? (viewport - width) / 2 : 0;

      // 位置調整やデザイン幅の表示で画像がはみ出しても、ページに横スクロールを出さない
      layer.style.width = `${viewport}px`;
      layer.hidden = !state.visible;
      layer.style.opacity = String(state.opacity);
      layer.style.mixBlendMode = state.blend;
      img.style.width = `${width}px`;
      img.style.transform = `translate(${left + state.x}px, ${state.y}px)`;
      status.textContent = `${bp.name}（デザイン ${designWidth}px / 表示 ${viewport}px）`;
    }

    function syncForm() {
      form.visible.checked = state.visible;
      form.opacity.value = String(state.opacity);
      $('output').textContent = `${Math.round(state.opacity * 100)}%`;
      form.blend.value = state.blend;
      form.breakpoint.value = state.breakpoint;
      form.fit.value = state.fit;
      form.x.value = String(state.x);
      form.y.value = String(state.y);
      panel.classList.toggle('is-collapsed', state.collapsed);
      $('.collapse').textContent = state.collapsed ? '＋' : '－';
    }

    function update(patch) {
      Object.assign(state, patch);
      save();
      syncForm();
      render();
    }

    root.addEventListener('input', (e) => {
      const { name, type, checked, value } = e.target;
      if (!(name in form)) return;
      if (type === 'checkbox') update({ [name]: checked });
      else if (type === 'range' || type === 'number') update({ [name]: Number(value) || 0 });
      else update({ [name]: value });
    });
    $('.reset').addEventListener('click', () => update({ x: 0, y: 0 }));
    $('.collapse').addEventListener('click', () => update({ collapsed: !state.collapsed }));
    img.addEventListener('load', render);
    img.addEventListener('error', () => {
      $('.status').textContent = '画像を読み込めませんでした';
    });

    function onKeydown(e) {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (e.code === 'KeyD') {
        e.preventDefault();
        update({ visible: !state.visible });
      } else if (moves[e.code]) {
        e.preventDefault();
        const [dx, dy] = moves[e.code];
        update({ x: state.x + dx, y: state.y + dy });
      }
    }

    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', render);
    document.documentElement.appendChild(host);
    syncForm();
    render();

    return {
      destroy() {
        window.removeEventListener('keydown', onKeydown, true);
        window.removeEventListener('resize', render);
        host.remove();
      },
    };
  }

  function readStore(key) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}');
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
      position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; width: 240px;
      font: 12px/1.5 system-ui, sans-serif; color: #f5f5f5;
      background: rgb(24 24 27 / 0.92); border-radius: 8px;
      box-shadow: 0 4px 16px rgb(0 0 0 / 0.3); overflow: hidden;
    }
    header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: rgb(255 255 255 / 0.06); }
    .route { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.7; }
    .body { display: grid; gap: 6px; padding: 8px; }
    .is-collapsed .body { display: none; }
    .row { display: flex; align-items: center; gap: 6px; }
    .row select, .row input[type=range] { flex: 1; min-width: 0; }
    .offset label { display: flex; align-items: center; gap: 4px; }
    .offset input { width: 52px; }
    .offset .reset { margin-left: auto; white-space: nowrap; }
    output { width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
    kbd, .hint { opacity: 0.6; font-size: 11px; }
    .hint, .status { margin: 0; }
    .status { color: #a5d8ff; }
    button, select, input { font: inherit; color: #111; }
    .collapse { width: 22px; height: 22px; padding: 0; line-height: 1; }
  `;

  globalThis.__designDiff = { load, unmount };

  // script タグで読み込まれた場合は、読み込み元の CLI をそのまま参照して起動する
  const script = document.currentScript;
  if (script?.src) load(new URL(script.src).origin);
})();
