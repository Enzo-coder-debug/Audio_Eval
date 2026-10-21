import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migrations = ["0010", "0011", "0012"];

export function prepareDatabase({
  environment = process.env,
  run = spawnSync,
  checkAccess = accessSync,
  log = console.log,
  error = console.error,
} = {}) {
  const flag = environment.DB_MIGRATE_ON_START ?? "0";
  if (!["", "0", "1"].includes(flag)) {
    error(
      "[database] DB_MIGRATE_ON_START 仅支持 0（只检查）或 1（补齐缺失字段）。"
    );
    return 1;
  }
  if (!environment.DATABASE_URL) {
    error(
      "[database] 缺少 DATABASE_URL，请在部署平台配置目标数据库连接，不要将连接串发到聊天或日志中。"
    );
    return 1;
  }

  const scripts = migrations.map(id => ({
    id,
    path: fileURLToPath(
      new URL(`./apply-${id}-migration.mjs`, import.meta.url)
    ),
  }));
  for (const script of scripts) {
    try {
      checkAccess(script.path, constants.R_OK);
    } catch {
      error(
        `[database] 迁移 ${script.id} 脚本缺失或不可读，请重新构建包含 scripts 目录的镜像。`
      );
      return 1;
    }
  }

  const execute = (script, mode) => {
    log(`[database] ${script.id} ${mode} 开始（单步最多等待 120 秒）`);
    let result;
    try {
      result = run(process.execPath, [script.path, mode], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: environment,
        stdio: "inherit",
        timeout: 120_000,
      });
    } catch {
      error(`[database] ${script.id} ${mode} 无法执行，停止启动。`);
      return 1;
    }
    if (result.error || result.signal || result.status == null) {
      error(
        `[database] ${script.id} ${mode} 执行异常或超时，停止启动；检查网络、权限及数据库锁。若已开始补列，请由数据库管理员确认执行状态后重试。`
      );
      return 1;
    }
    if (result.status !== 0)
      log(`[database] ${script.id} ${mode} 退出码：${result.status}`);
    return result.status;
  };

  log(
    `[database] 启动前检查；DB_MIGRATE_ON_START=${flag === "1" ? "1（允许补字段）" : "0（只检查）"}`
  );
  const missing = [];
  for (const script of scripts) {
    const status = execute(script, "--check");
    if (status === 2) missing.push(script);
    else if (status !== 0) {
      error(
        "[database] 数据库检查失败，尚未执行自动补字段；请查看前面的错误，不能跳过检查启动。"
      );
      return status;
    }
  }

  if (missing.length && flag !== "1") {
    error(
      `[database] 缺少迁移：${missing.map(script => script.id).join("、")}。默认不会修改数据库。`
    );
    error(
      "[database] 无法进入 WebShell 时：确认目标库和备份，在部署平台显式设置 DB_MIGRATE_ON_START=1 后重新发布本镜像；成功后改回 0。"
    );
    return 2;
  }
  if (missing.length) {
    log(
      "[database] 已显式启用启动前补字段；仅补齐 0010/0011/0012 的缺失列，不删除或改写历史答卷。"
    );
    for (const script of missing) {
      const status = execute(script, "--apply");
      if (status !== 0) {
        error(
          "[database] 补字段失败，停止启动；已完成的补列保留，确认原因后可重试，不自动回滚或删列。"
        );
        return status;
      }
    }
    for (const script of scripts) {
      const status = execute(script, "--check");
      if (status !== 0) {
        error("[database] 补字段后复核失败，停止启动。");
        return status;
      }
    }
  }
  log("[database] 0010/0011/0012 全部通过，可以启动应用。");
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length > 2) {
    console.error(
      "[database] 此入口不接受参数；默认只检查，仅 DB_MIGRATE_ON_START=1 允许补字段。"
    );
    process.exitCode = 1;
  } else {
    process.exitCode = prepareDatabase();
  }
}
