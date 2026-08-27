// 对象存储助手。
// 开发环境默认:本地磁盘(.local-storage)。
// 生产环境:京东云 OSS(S3 兼容),上传走 PutObject,下载走预签名 GET URL。
// 对外 URL 统一为 /manus-storage/{key},前端无需感知后端是哪种存储。
//
// 存储后端开关(优先级从高到低):
//   1. STORAGE_BACKEND=oss   → 强制走 OSS(本地开发想联调 OSS 上传时用)
//   2. STORAGE_BACKEND=local → 强制走本地磁盘
//   3. 未设 STORAGE_BACKEND   → NODE_ENV=development 走本地磁盘,其余走 OSS
// 本地想验证 OSS 上传,不需要改 NODE_ENV,只需在 .env / .env.local 加一行:
//   STORAGE_BACKEND=oss
// 并确保 OSS_ENDPOINT 用公网 endpoint(本机不通内网 s3-internal.*)。

import crypto from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "./_core/env";
import { localStoragePut } from "./_core/localStorage";

const STORAGE_BACKEND = (process.env.STORAGE_BACKEND ?? "").toLowerCase();
const USE_LOCAL_STORAGE =
  STORAGE_BACKEND === "oss"
    ? false
    : STORAGE_BACKEND === "local"
      ? true
      : process.env.NODE_ENV === "development";

let _s3: S3Client | null = null;
let _s3Public: S3Client | null = null;

function buildS3Client(endpoint: string | undefined): S3Client {
  return new S3Client({
    region: ENV.ossRegion,
    endpoint: endpoint || undefined,
    forcePathStyle: (process.env.OSS_FORCE_PATH_STYLE ?? "true") !== "false",
    credentials: {
      accessKeyId: ENV.ossAccessKeyId,
      secretAccessKey: ENV.ossSecretAccessKey,
    },
    requestHandler: {
      connectionTimeout: 5000,
      requestTimeout: 60000,
    },
    maxAttempts: 3,
  });
}

function assertOssConfig() {
  if (!ENV.ossBucket || !ENV.ossAccessKeyId || !ENV.ossSecretAccessKey) {
    throw new Error(
      "OSS config missing: set OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_SECRET_ACCESS_KEY",
    );
  }
}

function getS3(): { client: S3Client; bucket: string } {
  assertOssConfig();
  if (!_s3) {
    // 内网 endpoint(如 s3-internal.cn-north-1.jdcloud-oss.com):容器内上传/读取走内网,速度快、免公网流量。
    _s3 = buildS3Client(ENV.ossEndpoint);
  }
  return { client: _s3, bucket: ENV.ossBucket };
}

/**
 * 用「公网 endpoint」构造的 S3Client,专门用于生成可被手机/外部浏览器访问的预签名 URL。
 * 预签名 URL 的 host 由 client 的 endpoint 决定且参与签名,故不能只替换字符串,必须用公网 client 重新签名。
 * 未配置 OSS_PUBLIC_ENDPOINT 时回退到内网 endpoint(仅站内代理可达)。
 */
function getS3Public(): { client: S3Client; bucket: string } {
  assertOssConfig();
  if (!_s3Public) {
    const publicEp = ENV.ossPublicEndpoint || ENV.ossEndpoint;
    _s3Public = buildS3Client(publicEp);
  }
  return { client: _s3Public, bucket: ENV.ossBucket };
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

/**
 * 生成对象 key。bucket 已用独立的 tts-files,顶层再套一层「GSB」一级目录,
 * 内部按「日期 + 问卷名」子文件夹归档,便于运维按问卷检索/清理。
 * 结构:GSB/<YYYYMMDD>-<问卷名>/<HHmmss>-<epochMs>-<原文件名>
 * 若未提供 questionnaireTitle,退化为 GSB/<YYYYMMDD>/<...>。
 * userId 保留在参数签名以兼容既有调用点,不再拼进 key。
 */
export function buildAudioObjectKey(
  _userId: number | string,
  fileName: string,
  questionnaireTitle?: string,
): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // 问卷名需清洗:路径分隔符、控制字符替换为下划线;首尾空白裁剪;长度上限 60,避免 key 过长。
  const safeTitle = (questionnaireTitle ?? "")
    .replace(/[\\/\r\n\t]+/g, "_")
    .trim()
    .slice(0, 60);
  const dirPart = safeTitle ? `${datePart}-${safeTitle}` : datePart;
  const safeName = fileName.replace(/[\\/]+/g, "_");
  return `GSB/${dirPart}/${timePart}-${now.getTime()}-${safeName}`;
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
// 用公网 endpoint 的 client 签名,保证手机/外部浏览器能直接访问(内网 endpoint 公网不可达)。
export async function storageGetSignedUrl(
  relKey: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const { client, bucket } = getS3Public();
  const key = normalizeKey(relKey);

  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}
