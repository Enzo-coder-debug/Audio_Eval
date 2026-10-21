import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const testUrl = process.env.STARTUP_TEST_DATABASE_URL;

describe.skipIf(!testUrl)("隔离 MySQL 无 WebShell 启动前迁移", () => {
  let connection: Connection;
  const run = (flag?: string) =>
    spawnSync(process.execPath, ["scripts/prepare-database.mjs"], {
      env: {
        ...process.env,
        DATABASE_URL: testUrl!,
        DB_MIGRATE_ON_START: flag ?? "0",
        NODE_OPTIONS: "",
      },
      encoding: "utf8",
      timeout: 30000,
    });

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !/^\/startup_test_[a-z0-9_]+$/.test(url.pathname)
    )
      throw new Error("只允许本地 startup_test_ 前缀的空测试库");
    connection = await mysql.createConnection(testUrl!);
    const [tables] = await connection.query<any[]>("SHOW TABLES");
    if (tables.length) throw new Error("测试数据库必须为空");
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8"
      )
    );
    for (const entry of journal.entries.filter(
      (entry: { idx: number }) => entry.idx < 10
    )) {
      const sql = await readFile(
        new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
        "utf8"
      );
      for (const statement of sql
        .split("--> statement-breakpoint")
        .map(value => value.trim())
        .filter(Boolean))
        await connection.query(statement);
    }
    await connection.execute(
      "INSERT INTO questionnaires (id,creatorId,title,status) VALUES (1,51,'历史问卷','draft')"
    );
    await connection.execute(
      "INSERT INTO evaluationDimensions (id,questionnaireId,dimensionName,orderIndex) VALUES (1,1,'历史维度',0)"
    );
    await connection.execute(
      "INSERT INTO responses (id,questionnaireId,visitorName,status) VALUES (1,1,'历史答卷','submitted')"
    );
    await connection.execute(
      "INSERT INTO answers (id,responseId,evaluationDimensionId,blindTestChoice) VALUES (1,1,1,'same')"
    );
  }, 30000);

  afterAll(async () => {
    if (connection) await connection.end();
  });

  it("默认只检查；后续类型冲突不会提前执行任何自动补列", async () => {
    const checked = run();
    expect(checked.status, checked.stderr).toBe(2);
    expect(checked.stdout).toContain("0010 --check");
    expect(checked.stdout).toContain("0011 --check");
    expect(checked.stdout).toContain("0012 --check");
    expect(checked.stdout).not.toContain("--apply");
    await connection.query(
      "ALTER TABLE evaluationDimensions ADD scoringConfig TEXT NULL"
    );
    const failed = run("1");
    expect(failed.status).toBe(1);
    expect(failed.stdout).not.toContain("--apply");
    const [columns] = await connection.query<any[]>(
      "SHOW COLUMNS FROM evaluationDimensions LIKE 'emotionCategories'"
    );
    expect(columns).toEqual([]);
    await connection.query(
      "ALTER TABLE evaluationDimensions DROP COLUMN scoringConfig"
    );
  });

  it("开关为 1 时补齐 0010/0011/0012，保留旧答卷，重跑不再执行 DDL", async () => {
    const migrated = run("1");
    expect(migrated.status, migrated.stderr).toBe(0);
    for (const id of ["0010", "0011", "0012"])
      expect(migrated.stdout).toContain(`${id} --apply`);
    expect(migrated.stdout).toContain("0010/0011/0012 全部通过");
    const [dimensions] = await connection.query<any[]>(
      "SELECT dimensionName,emotionCategories,scoringConfig FROM evaluationDimensions WHERE id=1"
    );
    expect(dimensions).toEqual([
      {
        dimensionName: "历史维度",
        emotionCategories: null,
        scoringConfig: null,
      },
    ]);
    const [saved] = await connection.query<any[]>(
      "SELECT blindTestChoice,audioEvaluation FROM answers WHERE id=1"
    );
    expect(saved).toEqual([{ blindTestChoice: "same", audioEvaluation: null }]);
    const [responses] = await connection.query<any[]>(
      "SELECT status,subQuestionnaireIndex FROM responses WHERE id=1"
    );
    expect(responses).toEqual([
      { status: "submitted", subQuestionnaireIndex: null },
    ]);
    const [questionnaires] = await connection.query<any[]>(
      "SELECT subQuestionnairePlan FROM questionnaires WHERE id=1"
    );
    expect(questionnaires).toEqual([{ subQuestionnairePlan: null }]);
    for (const flag of ["0", "1"]) {
      const repeated = run(flag);
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(repeated.stdout).not.toContain("--apply");
    }
  }, 30000);
});
