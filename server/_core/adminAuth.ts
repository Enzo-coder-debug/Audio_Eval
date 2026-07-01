import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { ENV } from "./env";
import { sdk } from "./sdk";
import { getSessionCookieOptions } from "./cookies";

/**
 * 脱离 Manus OAuth 后的管理员登录(账号密码)。
 *
 * 设计:
 *   - 答卷人走免登录分享链接(/q/:shareToken),无需账号。
 *   - 仅管理端(adminProcedure)需要登录态,这里提供一个内置账号密码入口。
 *   - 账号密码来自环境变量 ADMIN_USERNAME / ADMIN_PASSWORD。
 *   - 登录成功后复用现有 JWT cookie 机制(sdk.createSessionToken),
 *     并把该管理员 upsert 为 role=admin。
 *
 * 接口:
 *   POST /api/admin/login  body: { username, password }
 */
export function registerAdminAuthRoutes(app: Express) {
  app.post("/api/admin/login", async (req: Request, res: Response) => {
    try {
      const { username, password } = (req.body ?? {}) as {
        username?: string;
        password?: string;
      };

      if (!ENV.adminUsername || !ENV.adminPassword) {
        res
          .status(500)
          .json({ error: "管理员登录未配置:请设置 ADMIN_USERNAME / ADMIN_PASSWORD" });
        return;
      }

      if (
        !username ||
        !password ||
        username !== ENV.adminUsername ||
        password !== ENV.adminPassword
      ) {
        res.status(401).json({ error: "用户名或密码错误" });
        return;
      }

      const openId = ENV.adminOpenId || "admin";

      // 显式赋予 admin 角色(upsertUser 支持传入 role)。
      await db.upsertUser({
        openId,
        name: username,
        email: `${openId}@admin.local`,
        loginMethod: "admin-password",
        role: "admin",
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(openId, {
        name: username,
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, {
        ...cookieOptions,
        maxAge: ONE_YEAR_MS,
      });

      res.json({ ok: true });
    } catch (error) {
      console.error("[AdminAuth] login failed", error);
      res.status(500).json({ error: "登录失败" });
    }
  });
}