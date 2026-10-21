import mysql from "mysql2/promise";

const args = process.argv.slice(2);
if (
  args.length > 1 ||
  args.some(argument => !["--check", "--apply"].includes(argument))
) {
  console.error(
    "用法: node scripts/apply-0011-migration.mjs [--check|--apply]"
  );
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("缺少 DATABASE_URL，请使用目标部署环境的数据库配置。");
  process.exit(1);
}
const columns = [
  { table: "questionnaires", column: "subQuestionnairePlan", type: "json" },
  { table: "responses", column: "subQuestionnaireIndex", type: "int" },
];
let connection;
try {
  connection = await mysql.createConnection(process.env.DATABASE_URL);
  const [databases] = await connection.query("SELECT DATABASE() AS db");
  const database = databases[0].db;
  if (!database) throw new Error("未指定数据库");
  for (const specification of columns) {
    const readColumn = async () => {
      const [rows] = await connection.query(
        "SELECT DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?",
        [database, specification.table, specification.column]
      );
      return rows[0];
    };
    let column = await readColumn();
    if (!column && args.includes("--apply")) {
      try {
        await connection.query(
          `ALTER TABLE \`${specification.table}\` ADD \`${specification.column}\` ${specification.type} NULL`
        );
        console.log(
          `[done] 已补齐 ${specification.table}.${specification.column}`
        );
      } catch (error) {
        if (error.code !== "ER_DUP_FIELDNAME") throw error;
      }
      column = await readColumn();
    }
    if (!column) {
      console.error(
        `[missing] ${specification.table}.${specification.column} 不存在；需执行 --apply。`
      );
      process.exitCode = process.exitCode || 2;
    } else if (
      column.DATA_TYPE !== specification.type ||
      column.IS_NULLABLE !== "YES"
    ) {
      console.error(
        `[mismatch] ${specification.table}.${specification.column} 类型不符；请人工核查。`
      );
      process.exitCode = 1;
    } else {
      console.log(
        `[ok] ${specification.table}.${specification.column} 结构正确。`
      );
    }
  }
} catch (error) {
  console.error(
    `[failed] 子问卷数据库检查/迁移失败 (${error.code || "UNKNOWN"})；请核查连接、DDL 权限与日志。`
  );
  process.exitCode = 1;
} finally {
  if (connection) await connection.end();
}
