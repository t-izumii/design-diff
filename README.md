# design-diff

Figma から書き出したデザイン画像をプロジェクト内に置き、ローカル開発中のページに URL ごとに自動で重ねて確認するためのツールです。読み込みは Chrome 拡張が担うので、案件の HTML・テーマ・ビルド結果にはコードが入りません。Vite・WordPress・静的 HTML のどれでも同じ手順で使えます。

```
Chrome拡張（extension/）
  └ ページを開くと http://localhost:4567/api/match に問い合わせ、画像があれば重ねる
CLI（design-diff serve）
  └ 案件の design-diff/ フォルダから、URLと画像の対応と画像を配信する
```

必要なもの: Node.js 20 以上、Chrome。実行時の依存パッケージはありません。

## 使い方

### 1. 拡張を Chrome に入れる（最初の1回だけ）

1. `chrome://extensions` を開き、右上の「デベロッパーモード」をオンにする
2. 「パッケージ化されていない拡張機能を読み込む」で、このリポジトリの `extension/` フォルダを選ぶ

既定では `localhost`、`127.0.0.1`、`*.localhost`、`*.local`、`*.test` のページで動きます。WordPress の管理画面（`/wp-admin/`、`/wp-login.php`）では動きません。ほかのドメインで使う場合は、`extension/manifest.json` の `matches` と、設定ファイルの `allowedHosts` の両方に追加し、拡張を再読み込みしてください。

### 2. 案件に画像を置く

```sh
npx design-diff init      # 案件のルートで実行。design-diff/ と設定ファイルができる
```

```
design-diff/
  design-diff.config.json
  localhost_3000/           ← ホスト名。ポートの ":" は "_" に置き換える
    index/                  ← ルート（/）
      pc.png
      sp@2x.png             ← @2x を付けると 2倍書き出しとして扱う
    about/
      pc.png                ← /about、/about/、/about.html に一致
    news/
      _slug/                ← "_" で始まるフォルダは1階層分のワイルドカード
        pc.png              ← /news/任意の記事 に一致
  mysite.local/             ← WordPress（Local など）のドメイン
    index/pc.png
  _any/                     ← すべてのホストに一致（ホスト別の指定が優先）
    contact/pc.png
```

画像のファイル名は、設定ファイルのブレークポイント名（既定は `pc` と `sp`）にします。それ以外の名前の画像は無視され、`design-diff list` で警告が出ます。

### 3. サーバーを起動して確認する

```sh
npx design-diff serve     # 開発サーバーと並べて起動しておく
npx design-diff list      # URLと画像の対応を確認する
```

あとは開発中のページを開くだけです。対応する画像があるページでは右下にパネルが出ます。CLI を止めているときや画像がないページでは何も表示されません。

画像の追加や差し替えは、ページを再読み込みすれば反映されます（サーバーの再起動は不要です）。

## パネルの操作

| 操作 | 内容 |
| --- | --- |
| 表示 / `Alt+Shift+D` | 画像の表示を切り替える |
| 不透明度 | 画像の濃さ |
| 重ね方 | 「差分」にすると、ずれている部分だけが明るく表示される |
| 画像 | 自動（表示幅で pc / sp を選ぶ）か、固定 |
| 幅 | 表示幅に合わせて拡大縮小する / デザイン幅のまま中央・左に置く |
| X・Y / `Alt+Shift+矢印` | 画像の位置を 1px 単位で調整する |

設定はページ（ホスト + ルート）ごとにブラウザの localStorage に保存されます。

## 設定ファイル

`design-diff/design-diff.config.json`

```json
{
  "port": 4567,
  "breakpoints": [
    { "name": "sp", "designWidth": 375, "maxWidth": 767 },
    { "name": "pc", "designWidth": 1440 }
  ],
  "allowedHosts": []
}
```

- `designWidth`: デザインカンプの幅（CSS ピクセル）。@2x の画像も、この幅として扱われます
- `maxWidth`: 表示幅がこの値以下のときに使うブレークポイント。`maxWidth` のないものは、それより広いすべての幅で使います。`tablet` などを追加することもできます
- 判定に使う表示幅は、スクロールバーを除いた幅（`document.documentElement.clientWidth`）です

- `allowedHosts`: CLI に問い合わせてよい開発ドメインの追加分（例: `"*.example.dev"`）。`localhost`・`127.0.0.1`・`*.localhost`・`*.local`・`*.test` は最初から許可されています

`port` を変えた場合は、`extension/content.js` の `SERVER` も合わせてください。

## 運用上の注意

- デザイン画像は容量が大きいので、案件のリポジトリでは `.gitignore` に `design-diff/` を入れるか、Git LFS で管理してください。本番に公開するディレクトリの外に置いてください
- CLI は `127.0.0.1` でだけ待ち受けます。同じネットワークのほかの端末からは見えません
- CLI は、ローカル開発のドメイン（上記と `allowedHosts`）以外のページからの問い合わせと、`localhost:ポート` / `127.0.0.1:ポート` 以外の宛先へのリクエストを拒否します。外部サイトの JS から画像や対応表を読まれないようにするためです
- 拡張は CLI にページのオリジンとパスだけを送り、クエリ文字列や `#` 以降は送りません
- 拡張がないブラウザで使いたい場合は、`<script src="http://localhost:4567/overlay.js"></script>` を開発環境でだけ読み込んでも動きます

## 今後の拡張候補

- 拡張のオプション画面からポートを変えられるようにする
- Vite プラグイン（`apply: 'serve'` で開発時だけ読み込む）
- Playwright と pixelmatch による差分の自動レポート
