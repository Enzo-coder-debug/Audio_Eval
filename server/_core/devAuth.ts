import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { sdk } from "./sdk";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * 仅在开发环境启用的 mock 登录路由,用于本地脱离 Manus OAuth 体验完整登录态。
 *
 * 用法:
 *   GET /api/dev/login            -> 以 owner(admin) 身份登录
 *   GET /api/dev/login?role=admin -> 以 admin 身份登录
 *   GET /api/dev/login?role=user  -> 以普通用户身份登录
 *
 * 安全:该路由必须由 NODE_ENV 严格门控,生产环境绝不注册。
 */
export function registerDevAuthRoutes(app: Express) {
  if (process.env.NODE_ENV !== "development") {
    return;
  }

  app.get("/api/dev/login", async (req: Request, res: Response) => {
    try {
      const role = getQueryParam(req, "role") === "user" ? "user" : "admin";

      // admin 角色复用 OWNER_OPEN_ID,upsertUser 会据此自动赋予 admin 权限;
      // user 角色用一个独立的固定 openId。
      const ownerOpenId = process.env.OWNER_OPEN_ID || "local-owner";
      const openId = role === "admin" ? ownerOpenId : "local-dev-user";
      const name = role === "admin" ? process.env.OWNER_NAME || "Local Owner" : "Local User";

      await db.upsertUser({
        openId,
        name,
        email: `${openId}@local.dev`,
        loginMethod: "dev-mock",
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(openId, {
        name,
        expiresInMs: ONE_YEAR_MS,
      });

      // 本地 http 环境下不能用 sameSite=none + secure=false(浏览器会丢弃 cookie),
      // 改用 lax 保证 mock 登录在本地可用。
      res.cookie(COOKIE_NAME, sessionToken, {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: false,
        maxAge: ONE_YEAR_MS,
      });

      res.redirect(302, "/");
    } catch (error) {
      console.error("[DevAuth] Mock login failed", error);
      res.status(500).json({ error: "Dev mock login failed" });
    }
  });
}