import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerDevAuthRoutes } from "./devAuth";
import { registerAdminAuthRoutes } from "./adminAuth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  registerDevAuthRoutes(app);
  registerAdminAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const isProduction = process.env.NODE_ENV === "production";
  // 生产（京东云 DevCloud）：必须固定监听 8080 且绑定 0.0.0.0，端口不可漂移。
  // DevCloud 的 K8s ingress 只路由容器 8080 端口，且外部只能访问 0.0.0.0 上的监听。
  const preferredPort = parseInt(process.env.PORT || (isProduction ? "8080" : "3000"));
  const port = isProduction ? preferredPort : await findAvailablePort(preferredPort);

  if (!isProduction && port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, "0.0.0.0", () => {
    // 启动诊断日志：部署后可在容器/WebShell 日志中快速定位配置问题
    console.log("========== [Startup] audio_evaluation_platform ==========");
    console.log(`[Startup] time          : ${new Date().toISOString()}`);
    console.log(`[Startup] node          : ${process.version}`);
    console.log(`[Startup] NODE_ENV      : ${process.env.NODE_ENV || "(unset)"}`);
    console.log(`[Startup] listening     : http://0.0.0.0:${port}/`);
    console.log(`[Startup] PORT(env)     : ${process.env.PORT || "(unset)"}`);
    console.log(
      `[Startup] DATABASE_URL  : ${process.env.DATABASE_URL ? "set" : "MISSING"}`
    );
    console.log(
      `[Startup] JWT_SECRET    : ${process.env.JWT_SECRET ? "set" : "MISSING"}`
    );
    console.log(
      `[Startup] ADMIN_USERNAME: ${process.env.ADMIN_USERNAME ? "set" : "MISSING"}`
    );
    console.log(
      `[Startup] OSS_BUCKET    : ${process.env.OSS_BUCKET || "(unset)"}`
    );
    console.log("=========================================================");
  });

  // 全局异常兜底日志，避免进程静默退出难以排查
  server.on("error", err => {
    console.error("[Server] listen error:", err);
  });
  process.on("uncaughtException", err => {
    console.error("[Process] uncaughtException:", err);
  });
  process.on("unhandledRejection", reason => {
    console.error("[Process] unhandledRejection:", reason);
  });
}

startServer().catch(console.error);
