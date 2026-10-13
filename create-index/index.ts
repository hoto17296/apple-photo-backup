// S3 にバックアップした画像・動画のメタデータからインデックスを作り、S3 上の SQLite ファイルに保存する
//
// 使い方: bun create-index/index.ts [--rebuild]
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";

import { S3Client } from "bun";
import { pushSQLiteSchema } from "drizzle-kit/api";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import { loadConfig, type StorageClass } from "../backup/index.ts";
import * as schema from "./schema.ts";
import { assets, type AssetRow } from "./schema.ts";

const USAGE = `Usage: bun create-index/index.ts [options]

Options:
  --rebuild    登録済みのアセットも含めて、すべて登録し直す
  -h, --help   このヘルプを表示する

Environment:
  S3_PREFIX              バックアップの保存先のプレフィックス（任意。なければバケットのルート）
  S3_STORAGE_CLASS       index.sqlite のストレージクラス（デフォルト: INTELLIGENT_TIERING）。
                         空にするとストレージクラスを指定しない（対応していない S3 互換ストレージ向け）
  S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION, S3_BUCKET, S3_ENDPOINT
                         S3 の接続情報（Bun の S3Client が読む）`;

// S3 からメタデータを読み込むときの同時実行数
const CONCURRENCY = 8;

// API が返す日時の書式。この形にそろっていれば、TEXT の並び順が時間の順番と一致する
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// metadata.json（PhotoKit Server の GET /assets/{id} のレスポンス）のうち、インデックスに使う項目
export type Metadata = {
  media_type: string;
  media_subtypes: string[];
  content_type: string;
  pixel_width: number;
  pixel_height: number;
  duration?: number;
  created_at?: string;
  added_at?: string;
  location?: { latitude: number; longitude: number };
  is_favorite: boolean;
  is_hidden: boolean;
  original_filename?: string;
  has_adjustments: boolean;
};

// resources.json の要素のうち、インデックスに使う項目
export type Resource = { data_size?: number };

export function toRow(
  uuid: string,
  metadata: Metadata,
  resources: Resource[],
  backupLogModified: string,
): AssetRow {
  return {
    uuid,
    mediaType: metadata.media_type,
    mediaSubtypes: metadata.media_subtypes,
    createdAt: timestamp("created_at", metadata.created_at),
    addedAt: timestamp("added_at", metadata.added_at),
    isFavorite: metadata.is_favorite,
    isHidden: metadata.is_hidden,
    hasAdjustments: metadata.has_adjustments,
    pixelWidth: metadata.pixel_width,
    pixelHeight: metadata.pixel_height,
    duration: metadata.duration ?? null,
    latitude: metadata.location?.latitude ?? null,
    longitude: metadata.location?.longitude ?? null,
    contentType: metadata.content_type,
    originalFilename: metadata.original_filename ?? null,
    totalSize: resources.reduce((sum, r) => sum + (r.data_size ?? 0), 0),
    // S3 の LastModified はミリ秒付きなので、ほかの日時と同じ書式にそろえる
    backedUpAt: new Date(backupLogModified).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

function timestamp(name: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!TIMESTAMP.test(value))
    throw new Error(`Unexpected ${name} format: ${JSON.stringify(value)}`);
  return value;
}

export type CliOptions = { rebuild: boolean; help: boolean };

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      rebuild: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  return { rebuild: values.rebuild, help: values.help };
}

export type CreateIndexDeps = {
  s3: S3Client;
  prefix: string;
  // undefined ならストレージクラスを指定しない
  storageClass?: StorageClass;
  log?: (line: string) => void;
};

export type CreateIndexOptions = { rebuild?: boolean };

export type Summary = {
  // バックアップが完了している（backup.log がある）アセットの数
  backedUp: number;
  alreadyIndexed: number;
  indexed: number;
  failed: number;
  schemaChanged: boolean;
  saved: boolean;
};

export async function createIndex(
  deps: CreateIndexDeps,
  options: CreateIndexOptions,
): Promise<Summary> {
  const log = deps.log ?? console.log;
  const indexFile = deps.s3.file(`${deps.prefix}index.sqlite`);

  // index.sqlite をメモリ上に読み込む（なければ空の DB から始める）
  const sqlite = (await indexFile.exists())
    ? Database.deserialize(await indexFile.bytes())
    : new Database(":memory:");
  const db = drizzle({ client: sqlite, schema });

  const schemaChanged = await pushSchema(db, log);
  if (options.rebuild) db.delete(assets).run();

  const backedUp = await listBackedUp(deps);
  const indexed = new Set(
    db
      .select({ uuid: assets.uuid })
      .from(assets)
      .all()
      .map((r) => r.uuid),
  );
  const targets = [...backedUp.keys()].filter((uuid) => !indexed.has(uuid)).sort();
  const summary: Summary = {
    backedUp: backedUp.size,
    alreadyIndexed: backedUp.size - targets.length,
    indexed: 0,
    failed: 0,
    schemaChanged,
    saved: false,
  };

  const width = String(targets.length).length;
  let done = 0;
  await forEachConcurrently(targets, CONCURRENCY, async (uuid) => {
    const base = `${deps.prefix}assets/${uuid}/`;
    let label = uuid;
    try {
      const metadata = (await deps.s3.file(`${base}metadata.json`).json()) as Metadata & {
        original_filename?: string;
      };
      if (metadata.original_filename) label += ` ${metadata.original_filename}`;
      const resources = (await deps.s3.file(`${base}resources.json`).json()) as Resource[];
      db.insert(assets)
        .values(toRow(uuid, metadata, resources, backedUp.get(uuid)!))
        .run();
      summary.indexed++;
      log(`${progress()} ${label}: indexed`);
    } catch (error) {
      summary.failed++;
      log(
        `${progress()} ${label}: failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  function progress() {
    return `[${String(++done).padStart(width)}/${targets.length}]`;
  }

  if (summary.schemaChanged || summary.indexed > 0 || options.rebuild) {
    await indexFile.write(sqlite.serialize(), {
      type: "application/vnd.sqlite3",
      storageClass: deps.storageClass,
      retry: 3,
    });
    summary.saved = true;
  }

  log(
    `Done: ${summary.indexed} indexed, ${summary.failed} failed, ${summary.alreadyIndexed} already indexed` +
      (summary.saved ? ` (saved to ${deps.prefix}index.sqlite)` : " (no changes)"),
  );
  return summary;
}

// schema.ts の定義と DB のテーブル構成を比べ、差分があれば適用する（drizzle-kit push 相当）。
// インデックスは S3 上のバックアップから作り直せるので、データが失われる変更もそのまま適用する。
// 消えた行は「未登録」になり、同じ実行の中で登録し直される
async function pushSchema(
  db: BunSQLiteDatabase<typeof schema>,
  log: (line: string) => void,
): Promise<boolean> {
  // pushSQLiteSchema の型は libSQL 用だが、実際に使うのは all() / run() だけなので bun:sqlite でも動く
  const result = await pushSQLiteSchema(
    schema,
    db as unknown as Parameters<typeof pushSQLiteSchema>[1],
  );
  if (result.statementsToExecute.length === 0) return false;

  log("Updating the schema of index.sqlite:");
  for (const statement of result.statementsToExecute) log(`  ${statement.trim()}`);
  for (const warning of result.warnings) log(`  warning: ${warning}`);
  await result.apply();
  return true;
}

// backup.log がある（バックアップが完了している）アセットの UUID と、backup.log の更新日時を集める
async function listBackedUp(deps: CreateIndexDeps): Promise<Map<string, string>> {
  const prefix = `${deps.prefix}assets/`;
  const uuids = new Map<string, string>();
  let continuationToken: string | undefined;
  do {
    const page = await deps.s3.list({ prefix, maxKeys: 1000, continuationToken });
    for (const { key, lastModified } of page.contents ?? []) {
      const uuid = key.slice(prefix.length).match(/^([^/]+)\/backup\.log$/)?.[1];
      if (uuid && lastModified) uuids.set(uuid, lastModified);
    }
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken);
  return uuids;
}

async function forEachConcurrently<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main() {
  let cli: CliOptions;
  try {
    cli = parseCliArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(USAGE);
    process.exit(2);
  }
  if (cli.help) {
    console.log(USAGE);
    return;
  }

  try {
    const config = loadConfig(process.env);
    const summary = await createIndex(
      { s3: new S3Client(), prefix: config.prefix, storageClass: config.storageClass },
      cli,
    );
    if (summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
