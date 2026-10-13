import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { startFakeS3 } from "../backup/test/fake-s3.ts";
import { createIndex, parseCliArgs, toRow } from "./index.ts";
import { assets } from "./schema.ts";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((stop) => stop());
  cleanups = [];
});

let counter = 0;

function makeMetadata(overrides: Record<string, unknown> = {}) {
  const n = ++counter;
  const hex = n.toString(16).toUpperCase().padStart(12, "0");
  return {
    id: `00000000-0000-0000-0000-${hex}/L0/001`,
    cloud_identifier: `11111111-2222-3333-4444-${hex}:001:AQtnuRB+2TvmDX0tcsNo3/U6vQfn`,
    media_type: "image",
    media_subtypes: [],
    playback_style: "image",
    content_type: "public.heic",
    pixel_width: 4032,
    pixel_height: 3024,
    created_at: "2026-10-11T13:04:45Z",
    added_at: "2026-10-11T13:04:45Z",
    is_favorite: false,
    is_hidden: false,
    keywords: [],
    original_filename: `IMG_${n}.HEIC`,
    represents_burst: false,
    source_type: "user_library",
    has_adjustments: false,
    ...overrides,
  };
}

type Metadata = ReturnType<typeof makeMetadata>;

const uuidOf = (metadata: Metadata) => metadata.cloud_identifier.slice(0, 36);

function setup(options: { prefix?: string } = {}) {
  const s3 = startFakeS3();
  cleanups.push(s3.stop);
  const prefix = options.prefix ?? "";
  const logs: string[] = [];

  // backup スクリプトが保存するのと同じ形でアセットを置く
  async function putAsset(
    metadata: Metadata,
    options: { resources?: { data_size?: number }[]; done?: boolean } = {},
  ) {
    const base = `${prefix}assets/${uuidOf(metadata)}/`;
    const resources = options.resources ?? [{ data_size: 100 }];
    await s3.client.write(`${base}metadata.json`, JSON.stringify(metadata));
    await s3.client.write(`${base}resources.json`, JSON.stringify(resources));
    if (options.done ?? true)
      await s3.client.write(`${base}backup.log`, "2026-10-12T00:00:00.000Z\n");
  }

  function savedIndex() {
    const object = s3.objects.get(`${prefix}index.sqlite`);
    if (!object) return undefined;
    const sqlite = Database.deserialize(object.body);
    return drizzle({ client: sqlite });
  }

  const run = (opts: Parameters<typeof createIndex>[1] = {}) =>
    createIndex(
      {
        s3: s3.client,
        prefix,
        storageClass: "INTELLIGENT_TIERING",
        log: (line) => logs.push(line),
      },
      opts,
    );

  return { s3, prefix, logs, putAsset, savedIndex, run };
}

describe("toRow", () => {
  test("メタデータとリソース一覧を 1 行に変換する", () => {
    const metadata = makeMetadata({
      media_subtypes: ["hdr", "live_photo"],
      is_favorite: true,
      has_adjustments: true,
      pixel_width: 3828,
      pixel_height: 2871,
      location: { latitude: 35.25631666666666, longitude: 136.82061666666667, altitude: 9.96 },
    });
    const resources = [{ data_size: 1250786 }, { data_size: 1086 }, { data_size: 1043458 }];

    expect(toRow(uuidOf(metadata), metadata, resources, "2026-10-12T09:02:23.000Z")).toEqual({
      uuid: uuidOf(metadata),
      mediaType: "image",
      mediaSubtypes: ["hdr", "live_photo"],
      createdAt: "2026-10-11T13:04:45Z",
      addedAt: "2026-10-11T13:04:45Z",
      isFavorite: true,
      isHidden: false,
      hasAdjustments: true,
      pixelWidth: 3828,
      pixelHeight: 2871,
      duration: null,
      latitude: 35.25631666666666,
      longitude: 136.82061666666667,
      contentType: "public.heic",
      originalFilename: metadata.original_filename,
      totalSize: 1250786 + 1086 + 1043458,
      backedUpAt: "2026-10-12T09:02:23Z",
    });
  });

  test("ない項目は null にする", () => {
    const metadata: Partial<Metadata> = makeMetadata({ media_type: "video", duration: 12.5 });
    delete metadata.created_at;
    delete metadata.added_at;
    delete metadata.original_filename;

    const row = toRow(
      uuidOf(metadata as Metadata),
      metadata as Metadata,
      [{}],
      "2026-10-12T09:02:23.000Z",
    );

    expect(row).toMatchObject({
      mediaType: "video",
      duration: 12.5,
      createdAt: null,
      addedAt: null,
      originalFilename: null,
      latitude: null,
      longitude: null,
      totalSize: 0,
    });
  });

  test("日時の書式が想定と違えばエラーにする（TEXT の並び順が崩れるため）", () => {
    const metadata = makeMetadata({ created_at: "2026-10-11T22:04:45+09:00" });

    expect(() => toRow(uuidOf(metadata), metadata, [], "2026-10-12T09:02:23.000Z")).toThrow(
      "created_at",
    );
  });
});

describe("createIndex", () => {
  test("index.sqlite がなければ作成し、バックアップが完了したアセットを登録して S3 に保存する", async () => {
    const { s3, putAsset, savedIndex, run } = setup({ prefix: "apple-photo/" });
    const [a, b, incomplete] = [makeMetadata(), makeMetadata(), makeMetadata()];
    await putAsset(a);
    await putAsset(b);
    await putAsset(incomplete, { done: false });

    const summary = await run();

    expect(summary).toEqual({
      backedUp: 2,
      alreadyIndexed: 0,
      indexed: 2,
      failed: 0,
      schemaChanged: true,
      saved: true,
    });
    const rows = await savedIndex()!.select().from(assets).orderBy(asc(assets.uuid));
    expect(rows.map((r) => r.uuid)).toEqual([uuidOf(a), uuidOf(b)].sort());
    const object = s3.objects.get("apple-photo/index.sqlite")!;
    expect(object.storageClass).toBe("INTELLIGENT_TIERING");
    expect(object.type).toBe("application/vnd.sqlite3");
  });

  test("backed_up_at には backup.log の更新日時を秒単位で入れる", async () => {
    const { s3, putAsset, savedIndex, run } = setup();
    const metadata = makeMetadata();
    await putAsset(metadata);
    s3.objects.get(`assets/${uuidOf(metadata)}/backup.log`)!.lastModified = new Date(
      "2026-10-12T09:02:23.456Z",
    );

    await run();

    const [row] = await savedIndex()!.select().from(assets);
    expect(row!.backedUpAt).toBe("2026-10-12T09:02:23Z");
  });

  test("登録済みの UUID は読み込まず、未登録の UUID だけを登録する", async () => {
    const { s3, putAsset, savedIndex, run } = setup();
    const [old, added] = [makeMetadata(), makeMetadata()];
    await putAsset(old);
    await run();
    await putAsset(added);
    s3.requests.length = 0;

    const summary = await run();

    expect(summary).toMatchObject({
      backedUp: 2,
      alreadyIndexed: 1,
      indexed: 1,
      schemaChanged: false,
      saved: true,
    });
    const reads = s3.requests.filter((r) => r.method === "GET" && r.key.startsWith("assets/"));
    expect(reads.map((r) => r.key).sort()).toEqual(
      [`assets/${uuidOf(added)}/metadata.json`, `assets/${uuidOf(added)}/resources.json`].sort(),
    );
    expect((await savedIndex()!.select().from(assets)).length).toBe(2);
  });

  test("スキーマにもデータにも変更がなければ S3 に保存しない", async () => {
    const { s3, putAsset, logs, run } = setup();
    await putAsset(makeMetadata());
    await run();
    s3.requests.length = 0;
    logs.length = 0;

    const summary = await run();

    expect(summary).toMatchObject({ indexed: 0, schemaChanged: false, saved: false });
    expect(s3.requests.filter((r) => r.method === "PUT" || r.method === "POST")).toEqual([]);
    expect(logs.at(-1)).toContain("no changes");
  });

  test("既存の index.sqlite のスキーマが古ければ更新し、消えた行は登録し直す", async () => {
    const { s3, putAsset, savedIndex, run } = setup();
    const metadata = makeMetadata();
    await putAsset(metadata);
    // 列が足りない古いスキーマで 1 行登録済みの index.sqlite
    const old = new Database(":memory:");
    old.run("CREATE TABLE assets (uuid TEXT PRIMARY KEY NOT NULL, media_type TEXT NOT NULL)");
    old.run("INSERT INTO assets VALUES (?, 'image')", [uuidOf(metadata)]);
    await s3.client.write("index.sqlite", old.serialize());

    const summary = await run();

    expect(summary.schemaChanged).toBe(true);
    const [row] = await savedIndex()!.select().from(assets);
    expect(row).toMatchObject({
      uuid: uuidOf(metadata),
      pixelWidth: 4032,
      backedUpAt: expect.any(String),
    });
  });

  test("rebuild を指定すると登録済みの行も登録し直す", async () => {
    const { s3, putAsset, savedIndex, run } = setup();
    const metadata = makeMetadata();
    await putAsset(metadata);
    await run();
    await s3.client.write(
      `assets/${uuidOf(metadata)}/metadata.json`,
      JSON.stringify({ ...metadata, is_favorite: true }),
    );

    const summary = await run({ rebuild: true });

    expect(summary).toMatchObject({ alreadyIndexed: 0, indexed: 1, saved: true });
    const [row] = await savedIndex()!.select().from(assets);
    expect(row!.isFavorite).toBe(true);
  });

  test("登録に失敗したアセットは飛ばして続行し、それ以外は保存する", async () => {
    const { s3, putAsset, savedIndex, logs, run } = setup();
    const [ok, broken] = [makeMetadata(), makeMetadata()];
    await putAsset(ok);
    await putAsset(broken);
    await s3.client.write(`assets/${uuidOf(broken)}/metadata.json`, "{ not json");

    const summary = await run();

    expect(summary).toMatchObject({ indexed: 1, failed: 1, saved: true });
    expect((await savedIndex()!.select().from(assets)).map((r) => r.uuid)).toEqual([uuidOf(ok)]);
    expect(logs.some((line) => line.includes(uuidOf(broken)) && line.includes("failed"))).toBe(
      true,
    );

    // 失敗したアセットは未登録のままなので、次の実行で登録し直される
    await s3.client.write(`assets/${uuidOf(broken)}/metadata.json`, JSON.stringify(broken));
    expect(await run()).toMatchObject({ alreadyIndexed: 1, indexed: 1, failed: 0 });
  });

  test("1 アセットごとに処理済み件数と全体の件数をログに出す", async () => {
    const { putAsset, logs, run } = setup();
    await putAsset(makeMetadata());
    await putAsset(makeMetadata());

    await run();

    const progress = logs.filter((line) => /^\[\d+\/2\]/.test(line));
    expect(progress).toHaveLength(2);
    expect(progress.every((line) => line.includes("indexed"))).toBe(true);
    expect(logs.at(-1)).toContain("2 indexed, 0 failed");
  });
});

describe("parseCliArgs", () => {
  test("デフォルト", () => {
    expect(parseCliArgs([])).toEqual({ rebuild: false, help: false });
  });

  test("--rebuild", () => {
    expect(parseCliArgs(["--rebuild"])).toEqual({ rebuild: true, help: false });
  });

  test("未知のオプションはエラー", () => {
    expect(() => parseCliArgs(["--unknown"])).toThrow();
  });
});
