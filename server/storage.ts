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
