# Create Index

画像・動画データのメタデータに対してインデックスを作成し、S3 上の SQLite ファイルに保存するスクリプト

インデックスは、ビューアアプリでのフィルタリング・ソートに使う。

## 使い方

リポジトリルートの README の手順で環境変数を設定した Dev Container の中で、リポジトリルートから実行する。PhotoKit Server は使わない（S3 上のバックアップだけを読む）。

```sh
# 未登録のアセットをインデックスに登録する
bun create-index/index.ts

# 登録済みのアセットも含めて、すべて登録し直す
bun create-index/index.ts --rebuild
```

### オプション

| オプション     | 内容                                                                            |
| -------------- | ------------------------------------------------------------------------------- |
| `--rebuild`    | 登録済みのアセットも含めて、すべて登録し直す（NULL を許す列を追加したときなど） |
| `-h`, `--help` | ヘルプを表示する                                                                |

### 環境変数

`S3_PREFIX` と `S3_STORAGE_CLASS` の扱いは backup スクリプトと同じ（`backup/index.ts` の `loadConfig` を使う）。

| 環境変数                                                             | 必須 | 内容                                                                                              |
| -------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_BUCKET` | ✓    | S3 の接続情報。Bun の `S3Client` がそのまま読む                                                   |
| `S3_PREFIX`                                                          |      | バックアップの保存先のプレフィックス。インデックスは `{S3_PREFIX}index.sqlite` に保存する         |
| `S3_STORAGE_CLASS`                                                   |      | `index.sqlite` のストレージクラス。デフォルトは `INTELLIGENT_TIERING`。空文字列にすると指定しない |

### 出力

```
[   1/5726] 0002A4F1-...-6C1B IMG_1234.HEIC: indexed
...
Done: 5726 indexed, 0 failed, 0 already indexed (saved to apple-photo/index.sqlite)
```

終了コードは、すべて成功なら `0`、登録に失敗したアセットがあれば `1`、オプションが不正なら `2`。

## テーブル

テーブル定義は [schema.ts](schema.ts)（Drizzle ORM）。テーブルは `assets` の 1 つだけ。

| 列                            | 型                | 元の項目                                                  |
| ----------------------------- | ----------------- | --------------------------------------------------------- |
| `uuid`                        | TEXT（主キー）    | `cloud_identifier` の UUID 部分（S3 の `assets/{uuid}/`） |
| `media_type`                  | TEXT              | `media_type`（`image` / `video` / `audio`）               |
| `media_subtypes`              | TEXT（JSON 配列） | `media_subtypes`（`screenshot`, `live_photo` など）       |
| `created_at`                  | TEXT              | `created_at`（撮影日時）                                  |
| `added_at`                    | TEXT              | `added_at`（ライブラリに追加した日時）                    |
| `is_favorite`                 | INTEGER（0/1）    | `is_favorite`                                             |
| `is_hidden`                   | INTEGER（0/1）    | `is_hidden`                                               |
| `has_adjustments`             | INTEGER（0/1）    | `has_adjustments`                                         |
| `pixel_width`, `pixel_height` | INTEGER           | `pixel_width`, `pixel_height`（編集後のサイズ）           |
| `duration`                    | REAL              | `duration`（動画の長さ、秒）                              |
| `latitude`, `longitude`       | REAL              | `location`                                                |
| `content_type`                | TEXT              | `content_type`（オリジナルの UTI）                        |
| `original_filename`           | TEXT              | `original_filename`                                       |
| `total_size`                  | INTEGER           | `resources.json` の `data_size` の合計                    |
| `backed_up_at`                | TEXT              | `backup.log` の更新日時（最後にバックアップした日時）     |

- インデックス: `created_at`, `added_at`
- 日時はすべて UTC の ISO 8601（`YYYY-MM-DDTHH:MM:SSZ`）。文字列の順番がそのまま時間の順番になるので、TEXT のまま並べ替え・範囲指定にインデックスが使える。この書式でない値はエラーにする
  - インデックスを効かせるには、`date(created_at)` のように列を関数で包まず、`created_at >= '2024-05-01' AND created_at < '2024-05-02'` のように範囲で書く
- `media_subtypes` での絞り込みは `EXISTS (SELECT 1 FROM json_each(media_subtypes) WHERE value = 'screenshot')` のように書く

## 処理の流れ

1. S3 の `{S3_PREFIX}index.sqlite` をメモリ上に読み込む（なければ空の DB から始める）
2. `schema.ts` の定義と DB のテーブル構成を比べ、差分があれば適用する（drizzle-kit の `push` 相当。`drizzle-kit/api` の `pushSQLiteSchema` を使う）
   - インデックスは S3 上のバックアップから作り直せるので、データが失われる変更（行の削除を伴う列の追加など）もそのまま適用する。消えた行は未登録になり、この実行の中で登録し直される
   - NULL を許す列を追加した場合、既存の行は NULL のままになるので、`--rebuild` で登録し直す
3. S3 の `{S3_PREFIX}assets/` の下を一覧取得して、`backup.log` がある（バックアップが完了している）アセットの UUID と `backup.log` の更新日時を集める
4. インデックスに未登録の UUID だけを対象に、`metadata.json` と `resources.json` を読んで登録する（同時に 8 件ずつ）
   - 登録に失敗したアセットは飛ばして続行する。未登録のまま残るので、次の実行で登録し直される
5. スキーマかデータに変更があれば、DB をシリアライズして `{S3_PREFIX}index.sqlite` に保存する（変更がなければ保存しない）

- S3 上のバックアップから削除されたアセットの行は、インデックスから削除しない
- 同時に複数実行すると、後から保存したほうで上書きされる

## テスト

リポジトリルートで実行する。

```sh
bun test create-index
```

S3 の偽物（`backup/test/fake-s3.ts` を共用）を `Bun.serve` でローカルに立ててテストするため、AWS へのアクセスは不要。
