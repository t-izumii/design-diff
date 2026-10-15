#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startServer } from '../lib/server.js';
import { scan, loadConfig, routeLabel, DEFAULT_CONFIG } from '../lib/scan.js';

const HELP = `使い方: design-diff <command> [options]

commands:
  init     design-diff/ フォルダと設定ファイルを作る
  serve    画像と対応表を配信する（Chrome拡張がここを参照する）
  list     URLと画像の対応を一覧表示する

options:
  --dir    画像フォルダ（既定: ./design-diff）
  --port   serve のポート（既定: 設定ファイルの port、なければ 4567）
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

if (command === 'init') {
  fs.mkdirSync(path.join(rootDir, 'localhost_3000', 'index'), { recursive: true });
  const configFile = path.join(rootDir, 'design-diff.config.json');
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }
  console.log(`作成しました: ${path.relative(process.cwd(), rootDir)}/`);
  console.log('localhost_3000/index/ に pc.png・sp.png を置き、フォルダ名を実際のホストに合わせてください。');
} else if (command === 'list') {
  const config = loadConfig(rootDir);
  const { entries, warnings } = scan(rootDir, config);
  for (const e of entries) {
    const files = e.images.map((i) => i.file.split('/').pop()).join(', ');
    console.log(`${e.host === '*' ? '(全ホスト)' : e.host}${routeLabel(e.segments)}  →  ${files}`);
  }
  if (entries.length === 0) console.log('対応する画像がありません。');
  for (const w of warnings) console.warn(`警告: ${w}`);
} else if (command === 'serve') {
  if (!fs.existsSync(rootDir)) {
    console.error(`画像フォルダがありません: ${rootDir}\n先に design-diff init を実行してください。`);
    process.exit(1);
  }
  const port = Number(values.port ?? loadConfig(rootDir).port);
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
