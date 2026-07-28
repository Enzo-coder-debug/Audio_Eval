// 对象存储助手。
// 开发环境:本地磁盘(.local-storage)。
// 生产环境:京东云 OSS(S3 兼容),上传走 PutObject,下载走预签名 GET URL。
// 对外 URL 统一为 /manus-storage/{key},前端无需感知后端是哪种存储。

import crypto from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "./_core/env";
import { localStoragePut } from "./_core/localStorage";

// 开发环境下改用本地磁盘存储。
const USE_LOCAL_STORAGE = process.env.NODE_ENV === "development";

let _s3: S3Client | null = null;

function getS3(): { client: S3Client; bucket: string } {
  if (!ENV.ossBucket || !ENV.ossAccessKeyId || !ENV.ossSecretAccessKey) {
    throw new Error(
      "OSS config missing: set OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_SECRET_ACCESS_KEY",
    );
  }
  if (!_s3) {
    _s3 = new S3Client({
      region: ENV.ossRegion,
      // 京东云 OSS 的 S3 兼容 endpoint,如 https://s3-internal.cn-north-1.jdcloud-oss.com(内网)
      endpoint: ENV.ossEndpoint || undefined,
      // 内网 endpoint 下 bucket 子域名(tts-files.s3-internal...)可能无 DNS 解析,
      // 故默认走 path 风格(s3-internal.../tts-files/key),可用 OSS_FORCE_PATH_STYLE=false 关闭。
      forcePathStyle: (process.env.OSS_FORCE_PATH_STYLE ?? "true") !== "false",
      credentials: {
        accessKeyId: ENV.ossAccessKeyId,
        secretAccessKey: ENV.ossSecretAccessKey,
      },
      // 超时保护:避免网络异常时上传请求无限挂起(此前无任何超时配置)。
      // connectionTimeout 建连 5s,requestTimeout 单请求 60s(大音频留足余量)。
      requestHandler: {
        connectionTimeout: 5000,
        requestTimeout: 60000,
      },
      maxAttempts: 3, // 瞬时网络抖动自动重试(默认 3 次含首次)
    });
  }
  return { client: _s3, bucket: ENV.ossBucket };
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

/**
 * 生成带"日期 + 时间戳"子文件夹的对象 key,便于在 bucket 中按上传时间归档,
 * 避免同一前缀(目录)下对象无限堆积,也方便运维按天检索/清理。
 * 结构:audio/<userId>/<YYYYMMDD>/<HHmmss>-<epochMs>-<原文件名>
 * 参考 script/oss_upload.py 的按前缀(prefix)组织对象的思路。
 */
export function buildAudioObjectKey(userId: number | string, fileName: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeName = fileName.replace(/[\\/]+/g, "_");
  return `audio/${userId}/${datePart}/${timePart}-${now.getTime()}-${safeName}`;
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  if (USE_LOCAL_STORAGE) {
    return localStoragePut(relKey, data, contentType);
  }

  const { client, bucket } = getS3();
  const key = appendHashSuffix(normalizeKey(relKey));

  const body =
    typeof data === "string" ? Buffer.from(data) : Buffer.from(data as Uint8Array);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  return { key, url: `/manus-storage/${key}` };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/manus-storage/${key}` };
}

/**
 * 生成对象的公网可直接访问 URL(脱离本站也能播放/下载)。
 * 优先用配置的外网 Bucket 域名 OSS_PUBLIC_BASE_URL(如 https://tts-files.s3.cn-north-1.jdcloud-oss.com);
 * 未配置时回退到 endpoint + bucket 的 path 风格拼接。
 * 注意:该 URL 能否公开访问取决于 Bucket/对象的读权限(需为公共读)。
 */
export function buildPublicUrl(relKey: string): string {
  const key = normalizeKey(relKey);
  const base = ENV.ossPublicBaseUrl?.replace(/\/+$/, "");
  if (base) {
    return `${base}/${key}`;
  }
  // 回退:endpoint + bucket(path 风格)
  const ep = (ENV.ossEndpoint || "").replace(/\/+$/, "");
  if (ep && ENV.ossBucket) {
    return `${ep}/${ENV.ossBucket}/${key}`;
  }
  return `/manus-storage/${key}`;
}

// 生成京东云 OSS 的预签名下载 URL,默认有效期 1 小时。
export async function storageGetSignedUrl(
  relKey: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const { client, bucket } = getS3();
  const key = normalizeKey(relKey);

  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}
