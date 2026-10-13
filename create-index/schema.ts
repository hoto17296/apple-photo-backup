// インデックス（index.sqlite）のテーブル定義
//
// create-index スクリプトは起動するたびに、この定義と index.sqlite の実際のテーブル構成を比べ、
// 差分があれば drizzle-kit の push 相当の処理で index.sqlite を更新する
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const assets = sqliteTable(
  "assets",
  {
    // CloudIdentifier の UUID 部分。S3 のキー（assets/{uuid}/）と同じ
    uuid: text().primaryKey(),
    // 'image' | 'video' | 'audio'
    mediaType: text("media_type").notNull(),
    // 'screenshot', 'live_photo' などの JSON 配列
    mediaSubtypes: text("media_subtypes", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    // 日時はすべて UTC の ISO 8601（YYYY-MM-DDTHH:MM:SSZ）。文字列の順番がそのまま時間の順番になる
    createdAt: text("created_at"),
    addedAt: text("added_at"),
    isFavorite: integer("is_favorite", { mode: "boolean" }).notNull(),
    isHidden: integer("is_hidden", { mode: "boolean" }).notNull(),
    hasAdjustments: integer("has_adjustments", { mode: "boolean" }).notNull(),
    // 編集後のサイズ
    pixelWidth: integer("pixel_width").notNull(),
    pixelHeight: integer("pixel_height").notNull(),
    // 動画の長さ（秒）
    duration: real(),
    latitude: real(),
    longitude: real(),
    // オリジナルの形式（UTI）
    contentType: text("content_type").notNull(),
    originalFilename: text("original_filename"),
    // resources/ 以下の全ファイルの合計サイズ（バイト）
    totalSize: integer("total_size").notNull(),
    // backup.log の更新日時（最後にバックアップした日時）
    backedUpAt: text("backed_up_at").notNull(),
  },
  (t) => [index("assets_created_at").on(t.createdAt), index("assets_added_at").on(t.addedAt)],
);

export type AssetRow = typeof assets.$inferInsert;
