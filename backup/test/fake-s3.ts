// テスト用の S3 互換サーバ（Bun の S3Client が使う範囲だけを実装したもの）
import { S3Client } from "bun";

export type StoredObject = { body: Uint8Array; type: string | null; storageClass: string | null };
export type RecordedRequest = { method: string; key: string; query: string[] };

// maxKeys: ListObjectsV2 の 1 ページあたりの件数の上限（ページ送りのテスト用）
export function startFakeS3(options: { maxKeys?: number } = {}) {
  const bucket = "test-bucket";
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<
    string,
    {
      key: string;
      type: string | null;
      storageClass: string | null;
      parts: Map<number, Uint8Array>;
    }
  >();
  const requests: RecordedRequest[] = [];
  let nextUploadId = 1;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const [, bucketName, ...rest] = url.pathname.split("/");
      if (bucketName !== bucket) return new Response("NoSuchBucket", { status: 404 });
      const key = rest.map(decodeURIComponent).join("/");
      const query = url.searchParams;
      requests.push({ method: req.method, key, query: [...query.keys()] });

      if (req.method === "GET" && key === "" && query.get("list-type") === "2") {
        const prefix = query.get("prefix") ?? "";
        const maxKeys = Math.min(Number(query.get("max-keys") ?? 1000), options.maxKeys ?? 1000);
        // 継続トークンには、前のページの最後のキーをそのまま使う
        const after = query.get("continuation-token") ?? "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = keys.slice(0, maxKeys);
        const truncated = keys.length > page.length;
        const contents = page
          .map(
            (k) =>
              `<Contents><Key>${escapeXml(k)}</Key><Size>${objects.get(k)!.body.length}</Size></Contents>`,
          )
          .join("");
        return xml(
          `<ListBucketResult><Name>${bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
            `<MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
            (truncated
              ? `<NextContinuationToken>${escapeXml(page.at(-1)!)}</NextContinuationToken>`
              : "") +
            `${contents}</ListBucketResult>`,
        );
      }

      if (req.method === "POST" && query.has("uploads")) {
        const uploadId = `upload-${nextUploadId++}`;
        uploads.set(uploadId, {
          key,
          type: req.headers.get("content-type"),
          storageClass: req.headers.get("x-amz-storage-class"),
          parts: new Map(),
        });
        return xml(
          `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      if (req.method === "PUT" && query.has("uploadId")) {
        const upload = uploads.get(query.get("uploadId")!);
        if (!upload) return new Response("NoSuchUpload", { status: 404 });
        const partNumber = Number(query.get("partNumber"));
        upload.parts.set(partNumber, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { headers: { ETag: `"part-${partNumber}"` } });
      }
      if (req.method === "POST" && query.has("uploadId")) {
        const uploadId = query.get("uploadId")!;
        const upload = uploads.get(uploadId);
        if (!upload) return new Response("NoSuchUpload", { status: 404 });
        const parts = [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, body]) => body);
        objects.set(key, {
          body: concat(parts),
          type: upload.type,
          storageClass: upload.storageClass,
        });
        uploads.delete(uploadId);
        return xml(
          `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`,
        );
      }
      if (req.method === "DELETE" && query.has("uploadId")) {
        uploads.delete(query.get("uploadId")!);
        return new Response(null, { status: 204 });
      }
      if (req.method === "PUT") {
        objects.set(key, {
          body: new Uint8Array(await req.arrayBuffer()),
          type: req.headers.get("content-type"),
          storageClass: req.headers.get("x-amz-storage-class"),
        });
        return new Response(null, { headers: { ETag: '"object"' } });
      }

      const object = objects.get(key);
      if (req.method === "HEAD") {
        return object
          ? new Response(null, { headers: { "Content-Length": String(object.body.length) } })
          : new Response(null, { status: 404 });
      }
      if (req.method === "GET") {
        return object
          ? new Response(object.body, {
              headers: { "Content-Type": object.type ?? "application/octet-stream" },
            })
          : xml(
              "<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>",
              404,
            );
      }
      return new Response("MethodNotAllowed", { status: 405 });
    },
  });

  const client = new S3Client({
    endpoint: server.url.origin,
    bucket,
    region: "us-east-1",
    accessKeyId: "test",
    secretAccessKey: "test",
  });

  return {
    url: server.url.origin,
    bucket,
    client,
    objects,
    uploads,
    requests,
    text: (key: string) => {
      const object = objects.get(key);
      return object && new TextDecoder().decode(object.body);
    },
    stop: () => server.stop(true),
  };
}

function xml(body: string, status = 200) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

function escapeXml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function concat(chunks: Uint8Array[]) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
