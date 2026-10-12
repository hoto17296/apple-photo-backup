# macOS PhotoKit Server
macOS の「写真」ライブラリを PhotoKit 経由で読み取り、HTTP API として提供するサーバ

## 必要なもの

- macOS 27
- Swift 6.2 以降
    - Command Line Tools で可, Xcode 不要

## ビルドと起動

コマンドはこのディレクトリ（`Package.swift` のある場所）で実行する。

```sh
swift build -c release
.build/release/photokit-server
```

初回起動時に「（ターミナルアプリ）が写真へのアクセスを求めています」というダイアログが出るので許可する。許可は起動元のターミナルアプリ（Terminal.app、iTerm、VS Code など）に付く。拒否してしまった場合は「システム設定 > プライバシーとセキュリティ > 写真」で許可してから再起動する。

SSH 経由では許可ダイアログを出せないため、GUI のターミナルから起動すること。常時起動しておきたい場合は tmux などを使う。

### オプション

| オプション | 環境変数 | デフォルト | 内容 |
| --- | --- | --- | --- |
| `--port` | `PHOTOKIT_SERVER_PORT` | `8080` | 待ち受けポート |
| `--token` | `PHOTOKIT_SERVER_TOKEN` | なし | 指定するとクライアントに `Authorization: Bearer <token>` を要求する |
| `--no-network` | | | iCloud にしかないファイルをデフォルトではダウンロードしない |
| `--download-timeout` | | `300` | ファイル取得（iCloud からのダウンロードを含む）のタイムアウト秒数 |
| `--max-concurrent-downloads` | | `4` | ファイル取得・サムネイル生成の同時実行数 |
| `--log-level` | | `info` | ログレベル |

## API

- レスポンスは JSON（キーは snake_case、日時は ISO 8601）。値がない項目はキーごと省略される
- アセット ID・アルバム ID は PhotoKit の `localIdentifier`。`/` を含むので、パスに入れるときは URL エンコードする（例: `ABCD-1234/L0/001` → `ABCD-1234%2FL0%2F001`）
- エラーは `{"error": {"code": "...", "message": "..."}}` の形で返る

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/health` | 死活監視（トークン不要） |
| GET | `/openapi.json` | この API の OpenAPI 3.1 仕様（トークン不要） |
| GET | `/library` | 許可状態、メディア種別ごとの件数、現在の変更トークン |
| GET | `/assets` | アセット一覧 |
| GET | `/assets/{id}` | アセットのメタデータ |
| GET | `/assets/{id}/resources` | アセットを構成するファイルの一覧 |
| GET | `/assets/{id}/resources/{index}` | ファイルの中身 |
| GET | `/assets/{id}/original` | オリジナル（未編集）ファイル |
| GET | `/assets/{id}/rendered` | 編集後のファイル（未編集ならオリジナル） |
| GET | `/assets/{id}/thumbnail` | サムネイル画像 |
| GET | `/albums` | アルバム一覧 |
| GET | `/albums/{id}` | アルバムのメタデータ |
| GET | `/albums/{id}/assets` | アルバム内のアセット一覧 |
| GET | `/changes` | 変更差分 |

### アセット一覧（`/assets`, `/albums/{id}/assets`）

| パラメータ | 例 | 内容 |
| --- | --- | --- |
| `media_type` | `image,video` | メディア種別（`image` / `video` / `audio`）。カンマ区切りでいずれかに一致 |
| `subtype` | `live_photo,screenshot` | サブタイプ。カンマ区切りでいずれかに一致。`panorama` `hdr` `screenshot` `live_photo` `depth_effect` `animation` `spatial` `streamed` `high_frame_rate` `timelapse` `screen_recording` `cinematic` |
| `favorite` | `true` | お気に入りかどうか |
| `hidden` | `include` | 非表示のアセットの扱い。`exclude`（デフォルト）/ `include` / `only` |
| `from`, `to` | `2025-01-01` | 撮影日時の範囲（`from` 以上、`to` 未満）。日付のみの場合はローカルタイムゾーン |
| `sort` | `-created_at` | `created_at` / `modified_at` / `added_at`。先頭に `-` で降順。デフォルトは `-created_at` |
| `limit` | `100` | 1 ページの件数（1〜1000、デフォルト 100） |
| `cursor` | | 前のレスポンスの `next_cursor`。フィルタと `sort` は前回と同じものを指定する |

レスポンスは `{"items": [...], "next_cursor": "..."}`。最後のページでは `next_cursor` がない。

### ファイル取得（`resources/{index}`, `original`, `rendered`, `thumbnail`）

- `network=true|false`: iCloud にしかないファイルをダウンロードするか（デフォルトは起動オプションに従う）。ダウンロードしない場合は `409` が返る
- `resources/{index}` / `original` / `rendered` は `Range` ヘッダに対応する
- `rendered` は、編集済みなのにライブラリに編集後のファイルがない場合、その場でレンダリングする。動画の場合は再エンコードするため、動画の長さに応じて時間がかかる（`--download-timeout` の対象）
- `thumbnail` は `size`（長辺のピクセル数、16〜4096、デフォルト 512）、`format`（`jpeg` / `heic` / `png`、デフォルト `jpeg`）、`quality`（0〜1、デフォルト 0.8）を指定できる

### アルバム一覧（`/albums`）

- `type=user,smart,shared`: 種別で絞り込む（デフォルトはすべて）
- フォルダに入っているアルバムは `folder_path` にフォルダ名が外側から順に入る

### 変更差分（`/changes`）

1. `since` なしで呼ぶと、現在の変更トークンが `token` に入って返る
2. 次回は `?since=<token>` を付けて呼ぶと、その時点以降に追加・更新・削除されたアセットとアルバムの ID と、新しい `token` が返る
3. トークンが古すぎて履歴が残っていない場合は `410` が返るので、全件を取り直す

## Python からの利用例

```python
from urllib.parse import quote

import requests

BASE = "http://127.0.0.1:8080"

# 最近のお気に入り写真を 10 件取得してサムネイルを保存
page = requests.get(f"{BASE}/assets", params={"media_type": "image", "favorite": "true", "limit": 10}).json()
for asset in page["items"]:
    asset_id = quote(asset["id"], safe="")
    thumb = requests.get(f"{BASE}/assets/{asset_id}/thumbnail", params={"size": 1024})
    thumb.raise_for_status()
    with open(f"{asset_id}.jpg", "wb") as f:
        f.write(thumb.content)


# 全アセットを順に取得
def all_assets(**params):
    params = {"limit": 1000, **params}
    while True:
        page = requests.get(f"{BASE}/assets", params=params).json()
        yield from page["items"]
        if "next_cursor" not in page:
            break
        params["cursor"] = page["next_cursor"]
```

## 開発

```sh
swift build
swift test
```

- API を変更したら [Sources/PhotoKitServer/openapi.json](Sources/PhotoKitServer/openapi.json) も手で更新する。ルーターと仕様のパスが一致しているかはテスト（`OpenAPITests`）で確認しているが、パラメータやレスポンスの中身は確認していない
- `swift test` が「plugin for module 'TestingMacros' not found」で失敗する場合は、`rm -rf .build/out` してから再実行する（Command Line Tools 環境でのビルドキャッシュの問題）
