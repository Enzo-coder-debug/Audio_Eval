import type { Express } from "express";
import { localStorageServe } from "./localStorage";
import { storageGetSignedUrl } from "../storage";

const USE_LOCAL_STORAGE = process.env.NODE_ENV === "development";

export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }

    // 开发环境:直接从本地磁盘提供文件。
    if (USE_LOCAL_STORAGE) {
      const served = await localStorageServe(key, res, req);
      if (!served) {
        res.status(404).send("File not found");
      }
      return;
    }

    // 生产环境:生成京东云 OSS 预签名 URL 并 307 重定向。
    try {
      const url = await storageGetSignedUrl(key);
      if (!url) {
        res.status(502).send("Empty signed URL from storage");
        return;
      }
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}
