import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  createConnection: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));
vi.mock("mysql2/promise", () => ({
  default: { createConnection: database.createConnection },
}));
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const column = (type: string) => [[{ DATA_TYPE: type, IS_NULLABLE: "YES" }]];
async function runMigration(...args: string[]) {
  process.argv = ["node", "scripts/apply-0011-migration.mjs", ...args];
  vi.resetModules();
  await import("../scripts/apply-0011-migration.mjs");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "mysql://test:secret@localhost/migration_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  database.createConnection.mockResolvedValue(database);
  database.query.mockResolvedValueOnce([[{ db: "migration_test" }]]);
  process.exitCode = 0;
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("子问卷增量迁移", () => {
  it.each([[], ["--check"]])("缺列检查不执行DDL %j", async (...args) => {
    database.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
    await runMigration(...args);
    expect(process.exitCode).toBe(2);
    expect(database.query).toHaveBeenCalledTimes(3);
    expect(
      database.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))
    ).toBe(true);
    expect(database.end).toHaveBeenCalledOnce();
  });

  it.each(["--check", "--apply"])("已有两列时幂等 %s", async mode => {
    database.query
      .mockResolvedValueOnce(column("json"))
      .mockResolvedValueOnce(column("int"));
    await runMigration(mode);
    expect(process.exitCode).toBe(0);
    expect(database.query).toHaveBeenCalledTimes(3);
  });

  it("显式apply补齐两列且重新验证，不更新历史数据", async () => {
    database.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce(column("json"));
    database.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce(column("int"));
    await runMigration("--apply");
    expect(process.exitCode).toBe(0);
    expect(database.query).toHaveBeenCalledWith(
      "ALTER TABLE `questionnaires` ADD `subQuestionnairePlan` json NULL"
    );
    expect(database.query).toHaveBeenCalledWith(
      "ALTER TABLE `responses` ADD `subQuestionnaireIndex` int NULL"
    );
    expect(
      database.query.mock.calls.some(([sql]) => /UPDATE|DELETE|DROP/.test(sql))
    ).toBe(false);
  });

  it("中途失败后可续跑，只补缺失列", async () => {
    database.query
      .mockResolvedValueOnce(column("json"))
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce(column("int"));
    await runMigration("--apply");
    expect(process.exitCode).toBe(0);
    expect(
      database.query.mock.calls.filter(([sql]) => sql.startsWith("ALTER"))
    ).toHaveLength(1);
  });

  it("字段类型不匹配时失败且不自动改类型", async () => {
    database.query
      .mockResolvedValueOnce(column("text"))
      .mockResolvedValueOnce(column("int"));
    await runMigration("--apply");
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[mismatch]")
    );
    expect(database.query).toHaveBeenCalledTimes(3);
  });

  it("并发加列仅忽略重复列错误并核验结构", async () => {
    database.query
      .mockResolvedValueOnce([[]])
      .mockRejectedValueOnce({ code: "ER_DUP_FIELDNAME" })
      .mockResolvedValueOnce(column("json"))
      .mockResolvedValueOnce(column("int"));
    await runMigration("--apply");
    expect(process.exitCode).toBe(0);
  });

  it("连接失败不泄露凭据", async () => {
    database.createConnection.mockRejectedValue({
      code: "ECONNREFUSED",
      message: "mysql://test:secret@localhost/migration_test",
    });
    await runMigration("--check");
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("ECONNREFUSED")
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "secret"
    );
  });
});
