import { afterEach, describe, expect, test } from "bun:test";

import { backup, loadConfig, parseCliArgs, PhotoKitClient, type StorageClass } from "./index.ts";
import {
  cloudUuid,
  makeAsset,
  photo,
  startFakePhotoKit,
  type FakeAsset,
} from "./test/fake-photokit.ts";
import { startFakeS3 } from "./test/fake-s3.ts";

const NOW = new Date("2026-10-12T01:02:03.000Z");
const MiB = 1024 * 1024;

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((stop) => stop());
  cleanups = [];
});

async function waitFor(condition: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(10);
  }
}

function setup(
  assets: FakeAsset[],
  options: {
    pageSize?: number;
    prefix?: string;
    token?: string;
    storageClass?: StorageClass;
    s3MaxKeys?: number;
  } = {},
) {
  const photokit = startFakePhotoKit(assets, options);
  const s3 = startFakeS3({ maxKeys: options.s3MaxKeys });
  cleanups.push(photokit.stop, s3.stop);
  const logs: string[] = [];
  const run = (opts: Parameters<typeof backup>[1] = {}) =>
    backup(
      {
        photokit: new PhotoKitClient(photokit.url, options.token),
        s3: s3.client,
        prefix: options.prefix ?? "",
        storageClass: options.storageClass,
        log: (line) => logs.push(line),
        now: () => NOW,
      },
      opts,
    );
  return { photokit, s3, logs, run };
}

describe("backup", () => {
  test("アセットごとに metadata.json / resources.json / thumbnail.jpeg / resources/* / backup.log を保存する", async () => {
    const asset = makeAsset({}, [
      photo(0, "IMG_2235.HEIC", "original"),
      {
        meta: {
          index: 1,
          type: "adjustment_data",
          filename: "Adjustments.plist",
          content_type: "com.apple.property-list",
          data_size: 5,
        },
        body: new TextEncoder().encode("plist"),
      },
      photo(2, "FullSizeRender.heic", "rendered"),
    ]);
    const { s3, run } = setup([asset]);

    const summary = await run();

    const base = `assets/${cloudUuid(asset)}/`;
    expect(JSON.parse(s3.text(`${base}metadata.json`)!)).toEqual(asset.metadata);
    expect(JSON.parse(s3.text(`${base}resources.json`)!)).toEqual(
      asset.resources.map((r) => r.meta),
    );
    expect(s3.text(`${base}thumbnail.jpeg`)).toBe(new TextDecoder().decode(asset.thumbnail));
    expect(s3.text(`${base}resources/IMG_2235.HEIC`)).toBe("original");
    expect(s3.text(`${base}resources/Adjustments.plist`)).toBe("plist");
    expect(s3.text(`${base}resources/FullSizeRender.heic`)).toBe("rendered");
    expect(s3.text(`${base}backup.log`)).toBe("2026-10-12T01:02:03.000Z\n");
    expect(summary).toEqual({ total: 1, uploaded: 1, skipped: 0, failed: 0, stopped: false });
  });

  test("Content-Type を設定して保存する", async () => {
    const asset = makeAsset();
    const { s3, run } = setup([asset]);

    await run();

    const base = `assets/${cloudUuid(asset)}/`;
    expect(s3.objects.get(`${base}resources/${asset.resources[0]!.meta.filename}`)!.type).toBe(
      "image/heic",
    );
    expect(s3.objects.get(`${base}thumbnail.jpeg`)!.type).toBe("image/jpeg");
    expect(s3.objects.get(`${base}metadata.json`)!.type).toStartWith("application/json");
  });

  test("ストレージクラスを指定すると、すべてのオブジェクトをそのクラスで保存する", async () => {
    const big = new Uint8Array(6 * MiB);
    const asset = makeAsset({}, [
      photo(0, "IMG_0001.HEIC", "small"),
      photo(1, "IMG_0001.MOV", big),
    ]);
    const { s3, run } = setup([asset], { storageClass: "INTELLIGENT_TIERING" });

    await run();

    // 小さいファイル（1 回の PUT）と大きいファイル（マルチパート）の両方を含む
    expect(s3.objects.size).toBe(6);
    for (const [key, object] of s3.objects)
      expect([key, object.storageClass]).toEqual([key, "INTELLIGENT_TIERING"]);
  });

  test("ストレージクラスを指定しなければ、ストレージクラスを送らない", async () => {
    const asset = makeAsset();
    const { s3, run } = setup([asset]);

    await run();

    expect(s3.objects.size).toBe(5);
    for (const [key, object] of s3.objects) expect([key, object.storageClass]).toEqual([key, null]);
  });

  test("backup.log はすべてのファイルの保存が終わってから最後に書く", async () => {
    const asset = makeAsset();
    const { s3, run } = setup([asset]);

    await run();

    const writes = s3.requests.filter(
      (r) => r.method === "PUT" || (r.method === "POST" && r.query.includes("uploadId")),
    );
    expect(writes.at(-1)!.key).toBe(`assets/${cloudUuid(asset)}/backup.log`);
  });

  test("S3_PREFIX があればその下に保存する", async () => {
    const asset = makeAsset();
    const { s3, run } = setup([asset], { prefix: "apple-photo/" });

    await run();

    expect(s3.text(`apple-photo/assets/${cloudUuid(asset)}/backup.log`)).toBeDefined();
    expect([...s3.objects.keys()].every((key) => key.startsWith("apple-photo/assets/"))).toBe(true);
  });

  test("一覧のページをすべてたどり、非表示のアセットも含めて取得する", async () => {
    const assets = [makeAsset(), makeAsset(), makeAsset(), makeAsset(), makeAsset()];
    const { photokit, s3, run } = setup(assets, { pageSize: 2 });

    const summary = await run();

    expect(summary.uploaded).toBe(5);
    for (const asset of assets)
      expect(s3.text(`assets/${cloudUuid(asset)}/backup.log`)).toBeDefined();
    const listRequests = photokit.requests.filter((r) => r.startsWith("/assets?"));
    expect(listRequests).toHaveLength(3);
    expect(
      listRequests.every((r) => new URLSearchParams(r.split("?")[1]).get("hidden") === "include"),
    ).toBe(true);
  });

  test("PhotoKit Server のトークンを指定できる", async () => {
    const asset = makeAsset();
    const { run } = setup([asset], { token: "secret" });

    expect((await run()).uploaded).toBe(1);
  });

  describe("バックアップ済みかどうかの確認", () => {
    const isList = (r: { method: string; query: string[] }) =>
      r.method === "GET" && r.query.includes("list-type");

    test("全件の実行では、アセットごとに HEAD せず、一覧取得でまとめて確認する", async () => {
      const assets = [makeAsset(), makeAsset(), makeAsset(), makeAsset(), makeAsset()];
      const { s3, run } = setup(assets, { prefix: "apple-photo/", s3MaxKeys: 2 });
      for (const asset of assets.slice(0, 3)) {
        await s3.client.write(
          `apple-photo/assets/${cloudUuid(asset)}/backup.log`,
          "2026-01-01T00:00:00.000Z\n",
        );
      }
      await s3.client.write(`apple-photo/assets/${cloudUuid(assets[3]!)}/metadata.json`, "{}");
      s3.requests.length = 0;

      const summary = await run();

      expect(summary).toEqual({ total: 5, uploaded: 2, skipped: 3, failed: 0, stopped: false });
      expect(s3.requests.filter((r) => r.method === "HEAD")).toEqual([]);
      // 1 ページ 2 件なので、既存の 4 オブジェクトを 2 ページに分けて取得する
      const lists = s3.requests.filter(isList);
      expect(lists).toHaveLength(2);
      expect(lists.every((r) => r.key === "")).toBe(true);
    });

    test("一覧取得は S3_PREFIX/assets/ の下だけを対象にする", async () => {
      const asset = makeAsset();
      const { s3, run } = setup([asset], { prefix: "apple-photo/" });
      await s3.client.write(
        `other-app/assets/${cloudUuid(asset)}/backup.log`,
        "2026-01-01T00:00:00.000Z\n",
      );

      const summary = await run();

      expect(summary.uploaded).toBe(1);
    });

    test("resources/ の下にある backup.log という名前のファイルは完了の印とみなさない", async () => {
      const asset = makeAsset({}, [photo(0, "backup.log", "a resource named backup.log")]);
      const { s3, run } = setup([asset]);
      await s3.client.write(`assets/${cloudUuid(asset)}/resources/backup.log`, "partial");

      const summary = await run();

      expect(summary.uploaded).toBe(1);
      expect(s3.text(`assets/${cloudUuid(asset)}/backup.log`)).toBe("2026-10-12T01:02:03.000Z\n");
    });

    test("ID を指定したときは一覧取得せず、そのアセットだけを確認する", async () => {
      const asset = makeAsset();
      const { s3, run } = setup([asset]);
      await s3.client.write(`assets/${cloudUuid(asset)}/backup.log`, "2026-01-01T00:00:00.000Z\n");

      const summary = await run({ id: asset.metadata.id });

      expect(summary.skipped).toBe(1);
      expect(s3.requests.filter(isList)).toEqual([]);
    });

    test("force のときは、バックアップ済みのアセットの backup.log だけを読む", async () => {
      const [done, notDone] = [makeAsset(), makeAsset()];
      const { s3, run } = setup([done!, notDone!]);
      await s3.client.write(`assets/${cloudUuid(done!)}/backup.log`, "2026-01-01T00:00:00.000Z\n");
      s3.requests.length = 0;

      await run({ force: true });

      const reads = s3.requests.filter(
        (r) => (r.method === "GET" && !isList(r)) || r.method === "HEAD",
      );
      expect(reads.map((r) => r.key)).toEqual([`assets/${cloudUuid(done!)}/backup.log`]);
      expect(s3.text(`assets/${cloudUuid(done!)}/backup.log`)).toBe(
        "2026-01-01T00:00:00.000Z\n2026-10-12T01:02:03.000Z\n",
      );
      expect(s3.text(`assets/${cloudUuid(notDone!)}/backup.log`)).toBe(
        "2026-10-12T01:02:03.000Z\n",
      );
    });
  });

  test("backup.log があるアセットはスキップする", async () => {
    const [done, notDone] = [makeAsset(), makeAsset()];
    const { s3, photokit, run } = setup([done!, notDone!]);
    await s3.client.write(`assets/${cloudUuid(done!)}/backup.log`, "2026-01-01T00:00:00.000Z\n");

    const summary = await run();

    expect(summary).toEqual({ total: 2, uploaded: 1, skipped: 1, failed: 0, stopped: false });
    expect(s3.text(`assets/${cloudUuid(done!)}/backup.log`)).toBe("2026-01-01T00:00:00.000Z\n");
    expect(s3.objects.has(`assets/${cloudUuid(done!)}/metadata.json`)).toBe(false);
    expect(photokit.requests.some((r) => r.includes(encodeURIComponent(done!.metadata.id)))).toBe(
      false,
    );
  });

  test("backup.log がないアセットは、途中まで保存されたファイルがあっても最初から保存し直す", async () => {
    const asset = makeAsset();
    const { s3, run } = setup([asset]);
    const base = `assets/${cloudUuid(asset)}/`;
    await s3.client.write(`${base}resources/${asset.resources[0]!.meta.filename}`, "partial");

    await run();

    expect(s3.text(`${base}resources/${asset.resources[0]!.meta.filename}`)).toBe(
      new TextDecoder().decode(asset.resources[0]!.body),
    );
    expect(s3.text(`${base}backup.log`)).toBe("2026-10-12T01:02:03.000Z\n");
  });

  test("force を指定すると backup.log があっても保存し直し、タイムスタンプを追記する", async () => {
    const asset = makeAsset();
    const { s3, run } = setup([asset]);
    await s3.client.write(`assets/${cloudUuid(asset)}/backup.log`, "2026-01-01T00:00:00.000Z\n");

    const summary = await run({ force: true });

    expect(summary.uploaded).toBe(1);
    expect(s3.text(`assets/${cloudUuid(asset)}/backup.log`)).toBe(
      "2026-01-01T00:00:00.000Z\n2026-10-12T01:02:03.000Z\n",
    );
    expect(s3.objects.has(`assets/${cloudUuid(asset)}/metadata.json`)).toBe(true);
  });

  test("ID を指定するとそのアセットだけを保存する", async () => {
    const [a, b, c] = [makeAsset(), makeAsset(), makeAsset()];
    const { s3, photokit, run } = setup([a!, b!, c!]);

    const summary = await run({ id: b!.metadata.id });

    expect(summary).toEqual({ total: 1, uploaded: 1, skipped: 0, failed: 0, stopped: false });
    expect(s3.text(`assets/${cloudUuid(b!)}/backup.log`)).toBeDefined();
    expect(s3.objects.has(`assets/${cloudUuid(a!)}/backup.log`)).toBe(false);
    expect(s3.objects.has(`assets/${cloudUuid(c!)}/backup.log`)).toBe(false);
    expect(photokit.requests.some((r) => r.startsWith("/assets?"))).toBe(false);
  });

  test("大きいファイルはマルチパートアップロードで保存する", async () => {
    const big = new Uint8Array(12 * MiB).map((_, i) => i % 251);
    const asset = makeAsset({}, [photo(0, "IMG_0001.MOV", big)]);
    const { s3, run } = setup([asset]);

    await run();

    const key = `assets/${cloudUuid(asset)}/resources/IMG_0001.MOV`;
    expect(
      s3.requests.some((r) => r.key === key && r.method === "POST" && r.query.includes("uploads")),
    ).toBe(true);
    expect(s3.objects.get(key)!.body).toEqual(big);
  });

  test("1アセットごとに処理済み件数と全体の件数をログに出す", async () => {
    const [a, b] = [makeAsset(), makeAsset()];
    const { s3, logs, run } = setup([a!, b!]);
    await s3.client.write(`assets/${cloudUuid(b!)}/backup.log`, "2026-01-01T00:00:00.000Z\n");

    await run();

    expect(logs).toHaveLength(3);
    expect(logs[0]).toStartWith("[1/2]");
    expect(logs[0]).toContain(cloudUuid(a!));
    expect(logs[0]).toContain("uploaded");
    expect(logs[1]).toStartWith("[2/2]");
    expect(logs[1]).toContain("skipped");
    expect(logs[2]).toContain("1 uploaded, 1 skipped, 0 failed");
  });
});

describe("エラー", () => {
  function failingAssets() {
    const failing = makeAsset({}, [{ ...photo(0, "IMG_0002.HEIC", "x"), status: 500 }]);
    return [makeAsset(), failing, makeAsset()] as const;
  }

  test("デフォルトではエラーが起きたら停止する", async () => {
    const [first, failing, last] = failingAssets();
    const { s3, logs, run } = setup([first, failing, last]);

    const summary = await run();

    expect(summary).toEqual({ total: 3, uploaded: 1, skipped: 0, failed: 1, stopped: true });
    expect(s3.objects.has(`assets/${cloudUuid(failing)}/backup.log`)).toBe(false);
    expect(s3.objects.has(`assets/${cloudUuid(last)}/backup.log`)).toBe(false);
    expect(logs[1]).toStartWith("[2/3]");
    expect(logs[1]).toContain("failed");
    expect(logs[1]).toContain("Could not read IMG_0002.HEIC");
  });

  test("continueOnError を指定するとそのアセットだけを中止して続行する", async () => {
    const [first, failing, last] = failingAssets();
    const { s3, run } = setup([first, failing, last]);

    const summary = await run({ continueOnError: true });

    expect(summary).toEqual({ total: 3, uploaded: 2, skipped: 0, failed: 1, stopped: false });
    expect(s3.objects.has(`assets/${cloudUuid(failing)}/backup.log`)).toBe(false);
    expect(s3.objects.has(`assets/${cloudUuid(last)}/backup.log`)).toBe(true);
  });

  test("ダウンロードが途中で失敗したらマルチパートアップロードを中止する", async () => {
    const stream = () =>
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          controller.enqueue(new Uint8Array(6 * MiB));
          await Bun.sleep(10);
          controller.error(new Error("connection lost"));
        },
      });
    const asset = makeAsset({}, [{ ...photo(0, "IMG_0003.MOV", ""), stream }]);
    const { s3, run } = setup([asset]);

    const summary = await run();

    expect(summary.failed).toBe(1);
    const key = `assets/${cloudUuid(asset)}/resources/IMG_0003.MOV`;
    expect(s3.objects.has(key)).toBe(false);
    expect(s3.objects.has(`assets/${cloudUuid(asset)}/backup.log`)).toBe(false);
    // 中止のリクエストは write() が失敗を返したあとに非同期で送られる
    await waitFor(() => s3.uploads.size === 0);
    expect(
      s3.requests.some(
        (r) => r.key === key && r.method === "DELETE" && r.query.includes("uploadId"),
      ),
    ).toBe(true);
  });

  test("cloud_identifier がない、または書式が違うアセットはエラーにする", async () => {
    const missing = makeAsset({ cloud_identifier: undefined });
    const malformed = makeAsset({ cloud_identifier: "not-a-cloud-identifier" });
    const { s3, logs, run } = setup([missing, malformed]);

    const summary = await run({ continueOnError: true });

    expect(summary.failed).toBe(2);
    expect(s3.objects.size).toBe(0);
    expect(logs[0]).toContain(missing.metadata.id);
    expect(logs[0]).toContain("cloud_identifier");
  });

  test("filename にパス区切りが含まれるリソースはエラーにする", async () => {
    const asset = makeAsset({}, [photo(0, "../escape.HEIC", "x")]);
    const { s3, run } = setup([asset]);

    const summary = await run();

    expect(summary.failed).toBe(1);
    expect(s3.objects.size).toBe(0);
  });

  test("一覧の取得に失敗したら例外を投げる", async () => {
    const { photokit, s3 } = setup([]);
    photokit.stop();

    await expect(
      backup(
        { photokit: new PhotoKitClient(photokit.url), s3: s3.client, prefix: "", log: () => {} },
        {},
      ),
    ).rejects.toThrow();
  });
});

describe("parseCliArgs", () => {
  test("デフォルト", () => {
    expect(parseCliArgs([])).toEqual({
      id: undefined,
      continueOnError: false,
      force: false,
      help: false,
    });
  });

  test("すべてのオプション", () => {
    expect(parseCliArgs(["--id", "ABC/L0/001", "--continue-on-error", "--force"])).toEqual({
      id: "ABC/L0/001",
      continueOnError: true,
      force: true,
      help: false,
    });
  });

  test("未知のオプションはエラー", () => {
    expect(() => parseCliArgs(["--unknown"])).toThrow();
  });
});

describe("loadConfig", () => {
  test("デフォルト", () => {
    expect(loadConfig({})).toEqual({
      photokitUrl: "http://host.docker.internal:8080",
      photokitToken: undefined,
      prefix: "",
      storageClass: "INTELLIGENT_TIERING",
    });
  });

  test("環境変数から読む", () => {
    expect(
      loadConfig({
        PHOTOKIT_SERVER_URL: "http://localhost:9000/",
        PHOTOKIT_SERVER_TOKEN: "t",
        S3_PREFIX: "apple-photo/",
        S3_STORAGE_CLASS: "STANDARD_IA",
      }),
    ).toEqual({
      photokitUrl: "http://localhost:9000",
      photokitToken: "t",
      prefix: "apple-photo/",
      storageClass: "STANDARD_IA",
    });
  });

  test("S3_STORAGE_CLASS が空ならストレージクラスを指定しない（S3 互換ストレージ向け）", () => {
    expect(loadConfig({ S3_STORAGE_CLASS: "" }).storageClass).toBeUndefined();
  });

  test("S3_STORAGE_CLASS が不正な値ならエラー", () => {
    expect(() => loadConfig({ S3_STORAGE_CLASS: "intelligent-tiering" })).toThrow(
      "S3_STORAGE_CLASS",
    );
  });

  test("S3_PREFIX の末尾に / がなければ補う", () => {
    expect(loadConfig({ S3_PREFIX: "apple-photo" }).prefix).toBe("apple-photo/");
  });
});
