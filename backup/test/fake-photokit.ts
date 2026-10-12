// テスト用の macOS PhotoKit Server（バックアップで使うエンドポイントだけを実装したもの）

export type FakeResource = {
  meta: {
    index: number;
    type: string;
    filename: string;
    content_type: string;
    mime_type?: string;
    data_size: number;
  };
  // body の代わりに stream を指定すると、そのストリームをレスポンスボディにする（途中で失敗させる用）
  body?: Uint8Array;
  stream?: () => ReadableStream<Uint8Array>;
  status?: number;
  // 最初の failTimes 回だけ 500 を返す（一時的なエラーの再現用）
  failTimes?: number;
};

export type FakeAsset = {
  metadata: {
    id: string;
    cloud_identifier?: string;
    original_filename?: string;
    [key: string]: unknown;
  };
  resources: FakeResource[];
  thumbnail?: Uint8Array;
};

export function startFakePhotoKit(
  assets: FakeAsset[],
  options: { pageSize?: number; token?: string } = {},
) {
  const pageSize = options.pageSize ?? 1000;
  const requests: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname + url.search);
      if (options.token && req.headers.get("authorization") !== `Bearer ${options.token}`) {
        return error(401, "unauthorized", "Missing or invalid token");
      }

      const segments = url.pathname.split("/").slice(1).map(decodeURIComponent);
      if (segments[0] !== "assets") return error(404, "not_found", "No such route");

      if (segments.length === 1) {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), pageSize);
        const offset = Number(url.searchParams.get("cursor") ?? 0);
        const items = assets.slice(offset, offset + limit).map((a) => a.metadata);
        const next = offset + limit < assets.length ? { next_cursor: String(offset + limit) } : {};
        return Response.json({ items, ...next });
      }

      const asset = assets.find((a) => a.metadata.id === segments[1]);
      if (!asset) return error(404, "not_found", "The asset was not found");

      if (segments.length === 2) return Response.json(asset.metadata);
      if (segments[2] === "thumbnail") {
        return new Response(asset.thumbnail ?? new Uint8Array([0xff, 0xd8, 0xff]), {
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      if (segments[2] === "resources" && segments.length === 3) {
        return Response.json(asset.resources.map((r) => r.meta));
      }
      if (segments[2] === "resources" && segments.length === 4) {
        const resource = asset.resources.find((r) => r.meta.index === Number(segments[3]));
        if (!resource) return error(404, "not_found", "The resource was not found");
        if (resource.status)
          return error(resource.status, "failed", `Could not read ${resource.meta.filename}`);
        if (resource.failTimes) {
          resource.failTimes--;
          return error(500, "failed", `Temporarily could not read ${resource.meta.filename}`);
        }
        return new Response(resource.stream ? resource.stream() : resource.body, {
          headers: { "Content-Type": resource.meta.mime_type ?? "application/octet-stream" },
        });
      }
      return error(404, "not_found", "No such route");
    },
  });

  return { url: server.url.origin, requests, stop: () => server.stop(true) };
}

function error(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

// テストデータを作るためのヘルパー
let counter = 0;

export function makeAsset(
  overrides: Partial<FakeAsset["metadata"]> = {},
  resources?: FakeResource[],
): FakeAsset {
  const n = ++counter;
  const hex = n.toString(16).toUpperCase().padStart(12, "0");
  const metadata = {
    id: `00000000-0000-0000-0000-${hex}/L0/001`,
    cloud_identifier: `11111111-2222-3333-4444-${hex}:001:AQtnuRB+2TvmDX0tcsNo3/U6vQfn`,
    original_filename: `IMG_${n}.HEIC`,
    media_type: "image",
    ...overrides,
  };
  return {
    metadata,
    resources: resources ?? [photo(0, `IMG_${n}.HEIC`, `photo-${n}`)],
    thumbnail: new TextEncoder().encode(`thumbnail-${n}`),
  };
}

export function photo(index: number, filename: string, content: string | Uint8Array): FakeResource {
  const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    meta: {
      index,
      type: "photo",
      filename,
      content_type: "public.heic",
      mime_type: "image/heic",
      data_size: body.length,
    },
    body,
  };
}

export function cloudUuid(asset: FakeAsset) {
  return asset.metadata.cloud_identifier!.slice(0, 36);
}
