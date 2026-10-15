/**
 * URL のパスを比較用のセグメントに分ける。
 * 末尾のスラッシュ、"/index.html"、".html" の違いは同じページとして扱う。
 * デコードできないパスは null を返す。
 */
export function toSegments(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null; // 不正なエスケープを含むパスはどのページにも一致させない
  }
  p = p.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '');
  return p.split('/').filter(Boolean);
}

/**
 * パスに一致するエントリを返す。
 * ワイルドカード（"_" で始まるフォルダ）より、名前が完全に一致するセグメントの多いものを優先する。
 */
export function findEntry(entries, pathname) {
  const target = toSegments(pathname);
  if (!target) return null;
  let best = null;
  let bestScore = -1;

  for (const entry of entries) {
    if (entry.segments.length !== target.length) continue;

    let score = 0;
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
