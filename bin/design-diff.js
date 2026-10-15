#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startServer } from '../lib/server.js';
import { scan, loadConfig, routeLabel, syncSettings, DEFAULT_CONFIG, SETTINGS_FILE } from '../lib/scan.js';

const HELP = `使い方: design-diff <command> [options]

commands:
  init       design-diff/ フォルダと設定ファイルを作る
  sync       画像の追加・削除を images.json に反映する（手で書いた値は残る）
  serve      画像と対応表を配信する（Chrome拡張がここを参照する）
  list       URLと画像の対応を一覧表示する
  extension  Chrome拡張のフォルダの場所を表示する（chrome://extensions で読み込む）

options:
  --dir      画像フォルダ（既定: ./design-diff）
  --port     serve のポート（既定: 設定ファイルの port、なければ 4567）
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: 'design-diff' },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0];
const rootDir = path.resolve(values.dir);

if (values.help || !command) {
  console.log(HELP);
  process.exit(0);
}

// images.json の書き間違いなどは、スタックトレースではなくメッセージだけを出す
function orExit(fn) {
  try {
    return fn();
  } catch (err) {
    console.error(`エラー: ${err.message}`);
    process.exit(1);
  }
}

if (command === 'extension') {
  // npm install -g で入れると拡張は node_modules の奥に置かれるため、読み込む場所を案内する
  console.log(fileURLToPath(new URL('../extension/', import.meta.url)).replace(/\/$/, ''));
} else if (command === 'init') {
  fs.mkdirSync(path.join(rootDir, 'index'), { recursive: true });
  const configFile = path.join(rootDir, 'design-diff.config.json');
  // 既にあれば書き換えない。wx はシンボリックリンクも既存として扱い、リンク先に書き込まない
  try {
    fs.writeFileSync(configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  orExit(() => syncSettings(rootDir));
  console.log(`作成しました: ${path.relative(process.cwd(), rootDir)}/`);
  console.log('トップページの画像は index/ に、下層ページの画像は about/ のようにパスと同じ名前のフォルダに置いてください。');
  console.log(`画像を置いたら design-diff sync を実行すると、${SETTINGS_FILE} に倍率と位置の項目が追加されます。`);
} else if (command === 'sync') {
  if (!fs.existsSync(rootDir)) {
    console.error(`画像フォルダがありません: ${rootDir}\n先に design-diff init を実行してください。`);
    process.exit(1);
  }
  const { added, removed, total, warnings } = orExit(() => syncSettings(rootDir));
  for (const file of added) console.log(`追加: ${file}`);
  for (const file of removed) console.log(`削除: ${file}`);
  console.log(`${SETTINGS_FILE} を更新しました（画像 ${total} 件、追加 ${added.length} 件、削除 ${removed.length} 件）`);
  for (const w of warnings) console.warn(`警告: ${w}`);
} else if (command === 'list') {
  const { entries, warnings } = orExit(() => scan(rootDir));
  for (const e of entries) {
    console.log(routeLabel(e.segments));
    for (const img of e.images) console.log(`  ${img.name}  倍率${img.zoom}  x:${img.x} y:${img.y}`);
  }
  if (entries.length === 0) console.log('対応する画像がありません。');
  for (const w of warnings) console.warn(`警告: ${w}`);
} else if (command === 'serve') {
  if (!fs.existsSync(rootDir)) {
    console.error(`画像フォルダがありません: ${rootDir}\n先に design-diff init を実行してください。`);
    process.exit(1);
  }
  const port = Number(values.port ?? orExit(() => loadConfig(rootDir)).port);
  try {
    await startServer({ rootDir, port });
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `ポート ${port} は使用中です。--port で変更してください。` : err.message);
    process.exit(1);
  }
  console.log(`design-diff: http://localhost:${port}  (${path.relative(process.cwd(), rootDir) || '.'})`);
  if (port !== 4567) console.log('既定以外のポートです。拡張の content.js の SERVER も合わせてください。');
} else {
  console.error(`不明なコマンドです: ${command}\n\n${HELP}`);
  process.exit(1);
}
