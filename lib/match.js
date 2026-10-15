/**
 * URL のパスを比較用のセグメントに分ける。
 * 末尾のスラッシュ、"/index.html"、".html" の違いは同じページとして扱う。
 */
export function toSegments(pathname) {
  let p = decodeURIComponent(pathname);
  p = p.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '');
  return p.split('/').filter(Boolean);
}

/**
 * ホストとパスに一致するエントリを返す。
 * 完全一致のセグメントが多いもの、ホスト指定が "_any" でないものを優先する。
 */
export function findEntry(entries, host, pathname) {
  const target = toSegments(pathname);
  let best = null;
  let bestScore = -1;

  for (const entry of entries) {
    if (entry.host !== host && entry.host !== '*') continue;
    if (entry.segments.length !== target.length) continue;

    let score = entry.host === '*' ? 0 : 1000;
    let ok = true;
    for (let i = 0; i < target.length; i++) {
      const seg = entry.segments[i];
      if (seg.startsWith('_')) continue;
      if (seg !== target[i]) {
        ok = false;
        break;
      }
      score += 1;
    }
    if (ok && score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}
