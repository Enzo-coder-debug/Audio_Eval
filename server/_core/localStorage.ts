import crypto from "crypto";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import type { Request, Response } from "express";

// 根据扩展名推断音频 Content-Type,确保浏览器 <audio> 能正确解析时长。
function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}

// 本地开发用的磁盘存储,替代 Manus Forge 对象存储。
// 文件存放在项目根的 .local-storage/ 目录下,key 保持与线上一致(audio/...)。
const STORAGE_ROOT = path.resolve(process.cwd(), ".local-storage");

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

// 防止路径穿越:解析后必须仍在 STORAGE_ROOT 内。
function resolveSafe(key: string): string {
  const target = path.resolve(STORAGE_ROOT, normalizeKey(key));
  if (target !== STORAGE_ROOT && !target.startsWith(STORAGE_ROOT + path.sep)) {
    throw new Error("Invalid storage key (path traversal)");
  }
  return target;
}

export async function localStoragePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  _contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const key = appendHashSuffix(normalizeKey(relKey));
  const filePath = resolveSafe(key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data as Uint8Array);
  await fs.writeFile(filePath, buf);
  return { key, url: `/manus-storage/${key}` };
}

// 把本地文件以流的形式写入响应,支持 HTTP Range 请求(音频 seek/时长必需);找不到返回 false。
export async function localStorageServe(
  key: string,
  res: Response,
  req?: Request,
): Promise<boolean> {
  let filePath: string;
  try {
    filePath = resolveSafe(key);
  } catch {
    return false;
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return false;
  }

  const total = stat.size;
  const contentType = guessContentType(filePath);
  res.set("Cache-Control", "no-store");
  res.set("Content-Type", contentType);
  res.set("Accept-Ranges", "bytes");

  const range = req?.headers?.range;
  if (range) {
    // 形如 "bytes=START-END"
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      if (start >= total || end >= total || start > end) {
        res.status(416).set("Content-Range", `bytes */${total}`).end();
        return true;
      }
      res.status(206);
      res.set("Content-Range", `bytes ${start}-${end}/${total}`);
      res.set("Content-Length", String(end - start + 1));
      createReadStream(filePath, { start, end }).pipe(res);
      return true;
    }
  }

  res.set("Content-Length", String(total));
  createReadStream(filePath).pipe(res);
  return true;
}