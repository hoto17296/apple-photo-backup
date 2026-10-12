# Backup
[macOS PhotoKit Server](../macos-photokit-server/README.md) から写真ライブラリを読み取り、Amazon S3 もしくは S3 互換ストレージにバックアップするスクリプト

## 使い方
リポジトリルートの README の手順で環境変数を設定した Dev Container の中で、リポジトリルートから実行する。Mac 側で PhotoKit Server を起動しておくこと。

```sh
# 全アセットをバックアップする
bun ./backup

# 1 アセットだけバックアップする（ID は PhotoKit の localIdentifier）
bun ./backup --id 'D488F985-503B-46A5-AC88-24C25C0DF33D/L0/001'
```

### オプション

| オプション | 内容 |
| --- | --- |
| `--id <id>` | 指定したアセット（localIdentifier）だけをバックアップする |
| `--continue-on-error` | エラーが起きたアセットだけを中止して、次のアセットに進む（デフォルトはその場で停止する） |
| `--force` | バックアップ済み（`backup.log` がある）アセットもバックアップし直す |
| `-h`, `--help` | ヘルプを表示する |

### 環境変数

| 環境変数 | 必須 | 内容 |
| --- | --- | --- |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_BUCKET` | ✓ | S3 の接続情報。Bun の `S3Client` がそのまま読む（`S3_ENDPOINT` なども使える） |
| `S3_PREFIX` | | 保存先のプレフィックス。ない場合はバケットのルートに保存する。末尾に `/` がなければ補う |
| `S3_STORAGE_CLASS` | | 保存するオブジェクトのストレージクラス。デフォルトは `INTELLIGENT_TIERING`。空文字列にするとストレージクラスを指定しない（Intelligent-Tiering に対応していない S3 互換ストレージ向け） |
| `PHOTOKIT_SERVER_URL` | | PhotoKit Server の URL。デフォルトは `http://host.docker.internal:8080` |
| `PHOTOKIT_SERVER_TOKEN` | | PhotoKit Server を `--token` 付きで起動している場合のトークン |

### 出力
1 アセットごとに 1 行、処理済み件数 / 全体の件数とともにログを標準出力に出し、最後に集計を出す。

```
[    1/12909] F9B6AB7F-CC73-4223-955A-C0E50FB8A3CF IMG_2235.HEIC: uploaded 7 files (2.2 MB)
[    2/12909] B1CDF4C4-8088-4DEF-9565-62962EA562E9 IMG_0431.JPG: skipped (already backed up)
[    3/12909] 2475184C-5369-4290-976F-A6079A1A3866 IMG_0013.jpg: failed: GET /assets/... failed with 500: ...
Done: 1 uploaded, 1 skipped, 1 failed (stopped on error)
```

終了コードは、すべて成功（またはスキップ）なら `0`、失敗したアセットがあれば `1`、オプションが不正なら `2`。

## S3 バケットの構造
- S3 バケット
  - (`S3_PREFIX`)
    - assets/
      - {CloudIdentifier の UUID 部分}/
        - metadata.json
        - resources.json
        - thumbnail.jpeg
        - resources/
          - (resources.json に記載されている全ファイル, オブジェクト名は filename と同じ)
        - backup.log

| ファイル | 取得元 |
| --- | --- |
| `metadata.json` | アセット一覧の要素（`--id` 指定時は `GET /assets/{id}`） |
| `resources.json` | `GET /assets/{id}/resources` |
| `thumbnail.jpeg` | `GET /assets/{id}/thumbnail`（デフォルトの長辺 512px の JPEG） |
| `resources/{filename}` | `GET /assets/{id}/resources/{index}`。Content-Type はリソースの `mime_type` |
| `backup.log` | バックアップが完了したタイムスタンプ（後述） |

## 仕様
- 連写ファイルは代表の1ファイルのみを保存する
- 共有アルバムの写真は保存しない
- 非表示のアセットも保存する
- 一度バックアップを取ったあとで編集された内容は取り込まない
- Apple アカウント側で削除された写真・動画のバックアップは自動的に削除されない
- backup.log ファイルは「バックアップが完了したタイムスタンプ」を記録するテキストファイル
  - 1回でも全ファイル (`metadata.json`, `resources.json`, `thumbnail.jpeg`, `resources/*`) のバックアップが完了したら作成される
  - 1行につきひとつ ISO 8601 形式のタイムスタンプが記述される
  - `--force` で同じアセットを再バックアップした場合、backup.log の新しい行にタイムスタンプが追記される

### 処理の流れ
1. アセット一覧（`GET /assets?hidden=include&sort=created_at`）を最後のページまで取得して、全体の件数を数える
2. S3 の `(S3_PREFIX)assets/` の下を一覧取得（ListObjectsV2）して、`backup.log` があるアセットの UUID を集める
    - アセットごとに HEAD するより速い（1,324 件で HEAD 約 41 秒 → 一覧取得 約 1 秒）
    - `--id` を指定したときは一覧取得せず、そのアセットの `backup.log` を HEAD で確認する
3. アセットを撮影日時の古い順に 1 件ずつ処理する（並列処理はしない）
    1. `cloud_identifier` の UUID 部分から保存先を決める。`cloud_identifier` がない、または書式が違う場合はエラー
    2. `backup.log` があればスキップする（`--force` 指定時を除く。`--force` 指定時は既存の `backup.log` を読んで追記する）
    3. `resources/*` → `thumbnail.jpeg` → `metadata.json` → `resources.json` の順に保存し、最後に `backup.log` を書く

- `backup.log` がないアセットは、途中まで保存されたファイルがあっても全ファイルを最初から保存し直す
- すべてのオブジェクト（`backup.log` を含む）を `S3_STORAGE_CLASS` のストレージクラスで保存する。Intelligent-Tiering では 128KB 未満のオブジェクトは監視されず常に高頻度アクセス層（Standard と同じ単価）になるため、小さい JSON や `backup.log` を同じクラスにしても不利にならない
- リソースとサムネイルは、PhotoKit Server からのレスポンスをストリームのまま S3 に書き込む。大きいファイルは自動でマルチパートアップロードになり、ダウンロードが途中で失敗した場合はマルチパートアップロードを中止する
- `filename` にパス区切り（`/`, `\`）が含まれるリソースがある場合、そのアセットはエラーにする
- アセット一覧の取得に失敗した場合は、`--continue-on-error` に関係なく停止する

## テスト
リポジトリルートで実行する。

```sh
bun test backup
```

PhotoKit Server と S3 の偽物（`test/fake-photokit.ts`, `test/fake-s3.ts`）を `Bun.serve` でローカルに立ててテストするため、Mac の PhotoKit Server や AWS へのアクセスは不要。偽の S3 には Bun の本物の `S3Client` から接続するので、マルチパートアップロードとその中止もテストで確認できる。

型チェックはリポジトリルートで `bunx tsc --noEmit -p .` を実行する。

## 実装メモ
- S3 への書き込みに `S3File.writer()` は使っていない。Bun 1.4.3 では `end(error)` を呼んでもマルチパートアップロードが中止されず、途中までの内容で完了してしまうため。代わりに `S3File.write(response)` にレスポンスをそのまま渡している
- マルチパートアップロードの中止リクエストは、`write()` が失敗を返したあとに非同期で送られる。プロセスの終了などで中止されずに残ったアップロードに備えて、バケットに未完了のマルチパートアップロードを削除するライフサイクルルール（`AbortIncompleteMultipartUpload`）を設定しておくとよい
