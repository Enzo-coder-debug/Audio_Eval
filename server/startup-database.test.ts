import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { prepareDatabase } from "../scripts/prepare-database.mjs";

function fixture(flag?: string) {
  return {
    environment: {
      DATABASE_URL: "mysql://test:redacted@localhost/isolated_test",
      ...(flag === undefined ? {} : { DB_MIGRATE_ON_START: flag }),
    },
    run: vi.fn().mockReturnValue({ status: 0 }),
    checkAccess: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
  };
}

describe("无 WebShell 的启动前数据库准备", () => {
  it("未配置可选后置脚本时，启动脚本尾部正常退出", () => {
    const start = readFileSync(new URL("../start.sh", import.meta.url), "utf8");
    const hook = start.slice(
      start.lastIndexOf('if [ -f "/home/admin/start_after.sh" ]')
    );
    expect(hook).toContain('if [ -f "/home/admin/start_after.sh" ]');
    const result = spawnSync(
      "bash",
      [
        "-c",
        hook.replaceAll(
          "/home/admin/start_after.sh",
          "/dev/null/nonexistent-start-after.sh"
        ),
      ],
      { encoding: "utf8" }
    );
    expect(result.status).toBe(0);
  });
  it.each([undefined, "", "0"])("未显式开启只检查，不执行 DDL：%s", flag => {
    const dependencies = fixture(flag);
    dependencies.run.mockReturnValue({ status: 2 });
    expect(prepareDatabase(dependencies)).toBe(2);
    expect(dependencies.run).toHaveBeenCalledTimes(3);
    expect(
      dependencies.run.mock.calls.every(([, args]) => args[1] === "--check")
    ).toBe(true);
    expect(dependencies.error).toHaveBeenCalledWith(
      expect.stringContaining("DB_MIGRATE_ON_START=1")
    );
  });

  it.each(["true", "yes", " 1", "2"])("拒绝歧义或错误开关：%s", flag => {
    const dependencies = fixture(flag);
    expect(prepareDatabase(dependencies)).toBe(1);
    expect(dependencies.run).not.toHaveBeenCalled();
  });

  it("未配置数据库不执行子进程", () => {
    const dependencies = fixture("1");
    dependencies.environment.DATABASE_URL = "";
    expect(prepareDatabase(dependencies)).toBe(1);
    expect(dependencies.run).not.toHaveBeenCalled();
  });

  it("在所有脚本检查可读之后才执行，缺包不会引起部分补列", () => {
    const dependencies = fixture("1");
    dependencies.checkAccess
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("EACCES");
      });
    expect(prepareDatabase(dependencies)).toBe(1);
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(dependencies.error).toHaveBeenCalledWith(
      expect.stringContaining("0011")
    );
  });

  it("所有列已存在时即便开关为 1 也不执行 DDL", () => {
    const dependencies = fixture("1");
    expect(prepareDatabase(dependencies)).toBe(0);
    expect(dependencies.run).toHaveBeenCalledTimes(3);
    expect(
      dependencies.run.mock.calls.every(([, args]) => args[1] === "--check")
    ).toBe(true);
  });

  it("先检查全部，再仅补缺失的 0011/0012，最后完整复核", () => {
    const dependencies = fixture("1");
    dependencies.run
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 2 })
      .mockReturnValueOnce({ status: 2 });
    expect(prepareDatabase(dependencies)).toBe(0);
    expect(
      dependencies.run.mock.calls.map(([, args]) => [
        args[0].match(/apply-(\d+)-/)[1],
        args[1],
      ])
    ).toEqual([
      ["0010", "--check"],
      ["0011", "--check"],
      ["0012", "--check"],
      ["0011", "--apply"],
      ["0012", "--apply"],
      ["0010", "--check"],
      ["0011", "--check"],
      ["0012", "--check"],
    ]);
    expect(dependencies.run.mock.calls[0][0]).toBe(process.execPath);
    expect(dependencies.run.mock.calls[0][2]).toMatchObject({
      stdio: "inherit",
      timeout: 120_000,
      env: dependencies.environment,
    });
  });

  it("后续检查发现类型不符或无权限时不补任何列", () => {
    const dependencies = fixture("1");
    dependencies.run
      .mockReturnValueOnce({ status: 2 })
      .mockReturnValueOnce({ status: 1 });
    expect(prepareDatabase(dependencies)).toBe(1);
    expect(
      dependencies.run.mock.calls.every(([, args]) => args[1] === "--check")
    ).toBe(true);
  });

  it("补列失败即停止，不继续后续迁移", () => {
    const dependencies = fixture("1");
    dependencies.run
      .mockReturnValueOnce({ status: 2 })
      .mockReturnValueOnce({ status: 2 })
      .mockReturnValueOnce({ status: 2 })
      .mockReturnValueOnce({ status: 1 });
    expect(prepareDatabase(dependencies)).toBe(1);
    expect(dependencies.run).toHaveBeenCalledTimes(4);
  });

  it("补列后复核仍不通过，不允许启动服务", () => {
    const dependencies = fixture("1");
    dependencies.run
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 2 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1 });
    expect(prepareDatabase(dependencies)).toBe(1);
    expect(dependencies.run).toHaveBeenCalledTimes(5);
  });

  it.each([
    { status: null, error: { code: "ETIMEDOUT", message: "mysql://secret" } },
    { status: null, signal: "SIGTERM" },
  ])("子进程超时或中断不误报成功，不打印凭据", result => {
    const dependencies = fixture("1");
    dependencies.run.mockReturnValue(result);
    expect(prepareDatabase(dependencies)).toBe(1);
    expect(JSON.stringify(dependencies.error.mock.calls)).not.toContain(
      "secret"
    );
    expect(dependencies.run).toHaveBeenCalledTimes(1);
  });

  it("执行异常不打印可能包含密码的错误对象", () => {
    const dependencies = fixture("1");
    dependencies.run.mockImplementation(() => {
      throw new Error("mysql://secret");
    });
    expect(prepareDatabase(dependencies)).toBe(1);
    expect(JSON.stringify(dependencies.error.mock.calls)).not.toContain(
      "secret"
    );
  });

  it("CLI 缺少环境变量时输出明确错误，不进入数据库连接", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/prepare-database.mjs"],
      {
        env: {
          ...process.env,
          DATABASE_URL: "",
          DB_MIGRATE_ON_START: "0",
          NODE_OPTIONS: "",
        },
        encoding: "utf8",
      }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("缺少 DATABASE_URL");
  });

  it("CLI 不允许用未知参数意外开启 DDL", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/prepare-database.mjs", "--apply"],
      {
        env: { ...process.env, DATABASE_URL: "", NODE_OPTIONS: "" },
        encoding: "utf8",
      }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("此入口不接受参数");
  });

  it("两种启动入口统一；开关跨用户透传；日志到控制台且管道保留失败状态", () => {
    const start = readFileSync(new URL("../start.sh", import.meta.url), "utf8");
    const container = readFileSync(
      new URL("../start_container.sh", import.meta.url),
      "utf8"
    );
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    );
    expect(start).toContain("set -o pipefail;");
    expect(start).toContain(
      'scripts/prepare-database.mjs 2>&1 | tee -a "$LOG_DIR/app.log"'
    );
    expect(container).toContain(
      "for KEY in DATABASE_URL DB_MIGRATE_ON_START JWT_SECRET"
    );
    expect(manifest.scripts.start).toContain("scripts/prepare-database.mjs &&");
  });
});
