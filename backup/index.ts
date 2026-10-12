// macOS PhotoKit Server から写真ライブラリを読み取り、S3 にバックアップする
//
// 使い方: bun ./backup [--id <アセット ID>] [--continue-on-error] [--force] [--min-age-days <N>]

import { parseArgs } from "node:util";

import { S3Client, type S3File, type S3Options } from "bun";

const USAGE = `Usage: bun ./backup [options]

Options:
  --id <id>             指定したアセット（localIdentifier）だけをバックアップする
  --continue-on-error   エラーが起きたアセットを中止して次のアセットに進む（デフォルトは停止）
  --force               バックアップ済み（backup.log がある）アセットもバックアップし直す
  --min-age-days <N>    ライブラリに追加されてから N 日以上たったアセットだけをバックアップする（デフォルト: 90）
  --retries <N>         失敗したアセットを 3 秒待ってから再試行する回数（デフォルト: 1）
  -h, --help            このヘルプを表示する

Environment:
  PHOTOKIT_SERVER_URL    PhotoKit Server の URL（デフォルト: http://host.docker.internal:8080）
  PHOTOKIT_SERVER_TOKEN  PhotoKit Server のトークン（任意）
  S3_PREFIX              保存先のプレフィックス（任意。なければバケットのルート）
  S3_STORAGE_CLASS       保存するオブジェクトのストレージクラス（デフォルト: INTELLIGENT_TIERING）。
                         空にするとストレージクラスを指定しない（対応していない S3 互換ストレージ向け）
  S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION, S3_BUCKET, S3_ENDPOINT
                         S3 の接続情報（Bun の S3Client が読む）`;

// CloudIdentifier の先頭の UUID 部分。S3 のキーに使う
const CLOUD_UUID = /^([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}):/;

// 追加されたばかりのアセットは、削除や編集をする可能性があるので、この日数がたつまでバックアップしない
const DEFAULT_MIN_AGE_DAYS = 90;

// ネットワークの瞬間的な不調で失敗することがあるので、少し待ってからアセット単位で再試行する。
// backup.log は最後に書くので、アセットの処理を最初からやり直しても問題ない
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 3000;

// 再試行しても同じ結果になるエラー（データの不備など）。再試行しない
class PermanentError extends Error {}

export type Asset = {
  id: string;
  cloud_identifier?: string;
  original_filename?: string;
  added_at?: string;
};
export type Resource = { index: number; filename: string; mime_type?: string };

export type StorageClass = NonNullable<S3Options["storageClass"]>;

const STORAGE_CLASSES: readonly StorageClass[] = [
  "STANDARD",
  "DEEP_ARCHIVE",
  "EXPRESS_ONEZONE",
  "GLACIER",
  "GLACIER_IR",
  "INTELLIGENT_TIERING",
  "ONEZONE_IA",
  "OUTPOSTS",
  "REDUCED_REDUNDANCY",
  "SNOW",
  "STANDARD_IA",
];

export type Config = {
  photokitUrl: string;
  photokitToken: string | undefined;
  prefix: string;
  storageClass: StorageClass | undefined;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  let prefix = env.S3_PREFIX ?? "";
  if (prefix && !prefix.endsWith("/")) prefix += "/";

  // 未設定ならデフォルト、空文字列なら指定しない
  const storageClass = env.S3_STORAGE_CLASS ?? "INTELLIGENT_TIERING";
  if (storageClass && !STORAGE_CLASSES.includes(storageClass as StorageClass)) {
    throw new Error(
      `Invalid S3_STORAGE_CLASS: ${storageClass} (expected one of ${STORAGE_CLASSES.join(", ")})`,
    );
  }

  return {
    photokitUrl: (env.PHOTOKIT_SERVER_URL ?? "http://host.docker.internal:8080").replace(
      /\/+$/,
      "",
    ),
    photokitToken: env.PHOTOKIT_SERVER_TOKEN || undefined,
    prefix,
    storageClass: (storageClass as StorageClass) || undefined,
  };
}

export type CliOptions = {
  id: string | undefined;
  continueOnError: boolean;
  force: boolean;
  minAgeDays: number;
  retries: number;
  help: boolean;
};

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      id: { type: "string" },
      "continue-on-error": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "min-age-days": { type: "string", default: String(DEFAULT_MIN_AGE_DAYS) },
      retries: { type: "string", default: String(DEFAULT_RETRIES) },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  return {
    id: values.id,
    continueOnError: values["continue-on-error"],
    force: values.force,
    minAgeDays: nonNegativeInteger("--min-age-days", values["min-age-days"]),
    retries: nonNegativeInteger("--retries", values.retries),
    help: values.help,
  };
}

function nonNegativeInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer: ${value}`);
  return Number(value);
}

export class PhotoKitClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  async *listAssets(): AsyncGenerator<Asset> {
    const params = new URLSearchParams({ hidden: "include", sort: "created_at", limit: "1000" });
    while (true) {
      const page = (await (await this.get(`/assets?${params}`)).json()) as {
        items: Asset[];
        next_cursor?: string;
      };
      yield* page.items;
      if (!page.next_cursor) return;
      params.set("cursor", page.next_cursor);
    }
  }

  async asset(id: string): Promise<Asset> {
    return (await this.get(`/assets/${encodeURIComponent(id)}`)).json() as Promise<Asset>;
  }

  async resources(id: string): Promise<Resource[]> {
    return (await this.get(`/assets/${encodeURIComponent(id)}/resources`)).json() as Promise<
      Resource[]
    >;
  }

  resource(id: string, index: number): Promise<Response> {
    return this.get(`/assets/${encodeURIComponent(id)}/resources/${index}`);
  }

  thumbnail(id: string): Promise<Response> {
    return this.get(`/assets/${encodeURIComponent(id)}/thumbnail`);
  }

  private async get(path: string): Promise<Response> {
    const headers: Record<string, string> = this.token
      ? { Authorization: `Bearer ${this.token}` }
      : {};
    const response = await fetch(this.baseUrl + path, { headers });
    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try {
        message = (JSON.parse(body) as { error: { message: string } }).error.message;
      } catch {}
      throw new Error(`GET ${path} failed with ${response.status}: ${message}`);
    }
    return response;
  }
}

export type BackupDeps = {
  photokit: PhotoKitClient;
  s3: S3Client;
  prefix: string;
  // undefined ならストレージクラスを指定しない
  storageClass?: StorageClass;
  log?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export type BackupOptions = {
  id?: string;
  continueOnError?: boolean;
  force?: boolean;
  // ライブラリに追加されてからこの日数以上たったアセットだけをバックアップする（デフォルト: 90）
  minAgeDays?: number;
  // 失敗したアセットを再試行する回数（デフォルト: 1）
  retries?: number;
};

export type Summary = {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  stopped: boolean;
};

export async function backup(deps: BackupDeps, options: BackupOptions): Promise<Summary> {
  const log = deps.log ?? console.log;

  // 全体の件数を出すため、先に一覧をすべて取得する
  const listed = options.id
    ? [await deps.photokit.asset(options.id)]
    : await Array.fromAsync(deps.photokit.listAssets());

  // 追加から日が浅いアセットを除く。added_at がないアセットは経過日数が分からないのでバックアップする
  const minAgeDays = options.minAgeDays ?? DEFAULT_MIN_AGE_DAYS;
  const cutoff = new Date((deps.now ?? (() => new Date()))().getTime() - minAgeDays * 86400_000);
  const assets = listed.filter((a) => !a.added_at || new Date(a.added_at) <= cutoff);
  if (assets.length < listed.length) {
    const since = cutoff.toISOString().replace(/\.\d{3}Z$/, "Z");
    log(
      `${listed.length - assets.length} assets added after ${since} are excluded (--min-age-days ${minAgeDays})`,
    );
  }

  // 全件の実行では、アセットごとに HEAD する代わりに、一覧取得でバックアップ済みのアセットをまとめて調べる
  const backedUp = options.id ? undefined : await listBackedUp(deps);
  const summary: Summary = {
    total: assets.length,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    stopped: false,
  };
  const width = String(assets.length).length;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));

  for (const [i, asset] of assets.entries()) {
    const progress = `[${String(i + 1).padStart(width)}/${assets.length}]`;
    const label = `${cloudUuid(asset) ?? asset.id} ${asset.original_filename ?? ""}`.trimEnd();
    try {
      const result = await withRetries(
        retries,
        () => backupAsset(deps, asset, options.force ?? false, backedUp),
        async (error, attempt) => {
          log(
            `${progress} ${label}: failed: ${errorMessage(error)}, ` +
              `retrying in ${RETRY_DELAY_MS / 1000}s (${attempt}/${retries})`,
          );
          await sleep(RETRY_DELAY_MS);
        },
      );
      if (result.skipped) {
        summary.skipped++;
        log(`${progress} ${label}: skipped (already backed up)`);
      } else {
        summary.uploaded++;
        log(`${progress} ${label}: uploaded ${result.files} files (${formatBytes(result.bytes)})`);
      }
    } catch (error) {
      summary.failed++;
      log(`${progress} ${label}: failed: ${errorMessage(error)}`);
      if (!options.continueOnError) {
        summary.stopped = true;
        break;
      }
    }
  }

  log(
    `Done: ${summary.uploaded} uploaded, ${summary.skipped} skipped, ${summary.failed} failed` +
      (summary.stopped ? " (stopped on error)" : ""),
  );
  return summary;
}

// fn が失敗したら、retries 回まで beforeRetry を呼んでからやり直す。PermanentError はやり直さない
async function withRetries<T>(
  retries: number,
  fn: () => Promise<T>,
  beforeRetry: (error: unknown, attempt: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt > retries || error instanceof PermanentError) throw error;
      await beforeRetry(error, attempt);
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// backup.log がある（バックアップが完了している）アセットの UUID を集める
async function listBackedUp(deps: BackupDeps): Promise<Set<string>> {
  const prefix = `${deps.prefix}assets/`;
  const uuids = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const page = await deps.s3.list({ prefix, maxKeys: 1000, continuationToken });
    for (const { key } of page.contents ?? []) {
      const uuid = key.slice(prefix.length).match(/^([^/]+)\/backup\.log$/)?.[1];
      if (uuid) uuids.add(uuid);
    }
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken);
  return uuids;
}

// backedUp がなければ、backup.log があるかを HEAD で確かめる
async function backupAsset(deps: BackupDeps, asset: Asset, force: boolean, backedUp?: Set<string>) {
  const uuid = cloudUuid(asset);
  if (!uuid) {
    throw new PermanentError(
      `Invalid cloud_identifier: ${JSON.stringify(asset.cloud_identifier ?? null)}`,
    );
  }
  const base = `${deps.prefix}assets/${uuid}/`;

  const logFile = deps.s3.file(`${base}backup.log`);
  const done = backedUp ? backedUp.has(uuid) : await logFile.exists();
  if (done && !force) return { skipped: true } as const;
  const previousLog = done ? await logFile.text() : undefined;

  const resources = await deps.photokit.resources(asset.id);
  for (const resource of resources) {
    if (!isSafeFilename(resource.filename)) {
      throw new PermanentError(`Invalid resource filename: ${JSON.stringify(resource.filename)}`);
    }
  }

  // Response を渡すと、ボディをストリームのまま S3 に書き込む。大きいファイルはマルチパートアップロードになり、
  // ダウンロードが途中で失敗すると中止される。
  // file.writer() は使わない: Bun 1.4.3 では end(error) でも中止されず、途中までの内容で完了してしまう
  const write = (file: S3File, data: string | Response, type: string) =>
    file.write(data, { type, storageClass: deps.storageClass, retry: 3 });
  const responseType = (response: Response, type?: string) =>
    type ?? response.headers.get("content-type") ?? "application/octet-stream";

  let bytes = 0;
  for (const resource of resources) {
    const response = await deps.photokit.resource(asset.id, resource.index);
    bytes += await write(
      deps.s3.file(`${base}resources/${resource.filename}`),
      response,
      responseType(response, resource.mime_type),
    );
  }
  bytes += await write(
    deps.s3.file(`${base}thumbnail.jpeg`),
    await deps.photokit.thumbnail(asset.id),
    "image/jpeg",
  );
  bytes += await write(
    deps.s3.file(`${base}metadata.json`),
    JSON.stringify(asset, null, 2),
    "application/json",
  );
  bytes += await write(
    deps.s3.file(`${base}resources.json`),
    JSON.stringify(resources, null, 2),
    "application/json",
  );

  // すべてのファイルを保存し終えてから、完了の印として書く
  const timestamp = (deps.now ?? (() => new Date()))().toISOString();
  const previous =
    previousLog && !previousLog.endsWith("\n") ? `${previousLog}\n` : (previousLog ?? "");
  await write(logFile, `${previous}${timestamp}\n`, "text/plain");

  return { skipped: false, files: resources.length + 4, bytes } as const;
}

function cloudUuid(asset: Asset): string | undefined {
  return asset.cloud_identifier?.match(CLOUD_UUID)?.[1];
}

function isSafeFilename(filename: string) {
  return filename !== "" && filename !== "." && filename !== ".." && !/[/\\]/.test(filename);
}

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
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
    const summary = await backup(
      {
        photokit: new PhotoKitClient(config.photokitUrl, config.photokitToken),
        s3: new S3Client(),
        prefix: config.prefix,
        storageClass: config.storageClass,
      },
      cli,
    );
    if (summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    // 設定の誤りや、アセット一覧の取得など、アセット単位ではないところで失敗した場合
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
