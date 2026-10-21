import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  createConnection: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));

vi.mock("mysql2/promise", () => ({
  default: { createConnection: database.createConnection },
}));

const validColumn = { DATA_TYPE: "json", IS_NULLABLE: "YES" };
const migrationSql =
  "ALTER TABLE `evaluationDimensions` ADD `emotionCategories` json NULL";
const originalArgv = process.argv;
const originalExitCode = process.exitCode;

async function runMigration(...args: string[]) {
  process.argv = ["node", "scripts/apply-0010-migration.mjs", ...args];
  vi.resetModules();
  await import("../scripts/apply-0010-migration.mjs");
}

function mockColumns(...columns: (typeof validColumn | undefined)[]) {
  database.query.mockResolvedValueOnce([[{ db: "migration_test" }]]);
  for (const column of columns) {
    database.query.mockResolvedValueOnce([column ? [column] : []]);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "mysql://test:secret@localhost/migration_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  database.createConnection.mockResolvedValue(database);
  database.end.mockResolvedValue(undefined);
  process.exitCode = 0;
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("情绪准确度数据库迁移", () => {
  it.each([[], ["--check"]])(
    "检查缺列只报错而不修改数据库 %j",
    async (...args) => {
      mockColumns(undefined);

      await runMigration(...args);

      expect(process.exitCode).toBe(2);
      expect(database.query).toHaveBeenCalledTimes(2);
      expect(database.query).not.toHaveBeenCalledWith(migrationSql);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("[missing]")
      );
      expect(database.end).toHaveBeenCalledOnce();
    }
  );

  it.each(["--check", "--apply"])("字段已存在时不重复迁移 %s", async mode => {
    mockColumns(validColumn);

    await runMigration(mode);

    expect(process.exitCode).toBe(0);
    expect(database.query).toHaveBeenCalledTimes(2);
    expect(database.query).not.toHaveBeenCalledWith(migrationSql);
    expect(database.end).toHaveBeenCalledOnce();
  });

  it("显式 apply 仅增加可空 JSON 列，并重新检查结果", async () => {
    mockColumns(undefined);
    database.query.mockResolvedValueOnce([{}]);
    database.query.mockResolvedValueOnce([[validColumn]]);

    await runMigration("--apply");

    expect(process.exitCode).toBe(0);
    expect(database.query).toHaveBeenNthCalledWith(3, migrationSql);
    expect(database.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("information_schema.COLUMNS"),
      ["migration_test", "evaluationDimensions", "emotionCategories"]
    );
    expect(database.end).toHaveBeenCalledOnce();
  });

  it.each([
    { DATA_TYPE: "text", IS_NULLABLE: "YES" },
    { DATA_TYPE: "json", IS_NULLABLE: "NO" },
  ])("不自动修改不匹配的已有字段 %j", async column => {
    mockColumns(column);

    await runMigration("--apply");

    expect(process.exitCode).toBe(1);
    expect(database.query).not.toHaveBeenCalledWith(migrationSql);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[mismatch]")
    );
  });

  it("并发补列只忽略重复字段错误，仍核验最终结构", async () => {
    mockColumns(undefined);
    database.query.mockRejectedValueOnce({ code: "ER_DUP_FIELDNAME" });
    database.query.mockResolvedValueOnce([[validColumn]]);

    await runMigration("--apply");

    expect(process.exitCode).toBe(0);
    expect(database.query).toHaveBeenCalledTimes(4);
    expect(database.end).toHaveBeenCalledOnce();
  });

  it("并发迁移后字段类型不匹配仍失败", async () => {
    mockColumns(undefined);
    database.query.mockRejectedValueOnce({ code: "ER_DUP_FIELDNAME" });
    database.query.mockResolvedValueOnce([
      [{ DATA_TYPE: "text", IS_NULLABLE: "YES" }],
    ]);

    await runMigration("--apply");

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[mismatch]")
    );
  });

  it("DDL 失败不吞错、不泄露连接信息，并关闭连接", async () => {
    mockColumns(undefined);
    database.query.mockRejectedValueOnce({
      code: "ER_TABLEACCESS_DENIED_ERROR",
      message: process.env.DATABASE_URL,
    });

    await runMigration("--apply");

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("ER_TABLEACCESS_DENIED_ERROR")
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "secret"
    );
    expect(database.end).toHaveBeenCalledOnce();
  });

  it("连接失败返回错误，不执行查询", async () => {
    database.createConnection.mockRejectedValueOnce({ code: "ECONNREFUSED" });

    await runMigration("--check");

    expect(process.exitCode).toBe(1);
    expect(database.query).not.toHaveBeenCalled();
    expect(database.end).not.toHaveBeenCalled();
  });

  it("连接未选定数据库时不执行 DDL", async () => {
    database.query.mockResolvedValueOnce([[{ db: null }]]);

    await runMigration("--apply");

    expect(process.exitCode).toBe(1);
    expect(database.query).toHaveBeenCalledTimes(1);
    expect(database.end).toHaveBeenCalledOnce();
  });
});
