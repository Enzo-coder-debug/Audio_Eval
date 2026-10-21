// 检查或补齐情绪准确度字段；默认只读，--apply 才修改数据库。
// 使用部署环境注入的 DATABASE_URL，不自动读取本地环境文件。
import mysql from "mysql2/promise";

const args = process.argv.slice(2);
if (args.some(arg => !["--check", "--apply"].includes(arg)) || args.length > 1) {
  console.error("用法: node scripts/apply-0010-migration.mjs [--check|--apply]");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("缺少 DATABASE_URL，请使用目标部署环境的数据库配置。");
  process.exit(1);
}

let conn;
try {
  conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [databases] = await conn.query("SELECT DATABASE() AS db");
  const dbName = databases[0].db;
  if (!dbName) throw new Error("连接未指定数据库");

  async function readColumn() {
    const [rows] = await conn.query(
      "SELECT DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?",
      [dbName, "evaluationDimensions", "emotionCategories"]
    );
    return rows[0];
  }

  let column = await readColumn();
  if (!column && args.includes("--apply")) {
    try {
      await conn.query("ALTER TABLE `evaluationDimensions` ADD `emotionCategories` json NULL");
      console.log("[done] 已补齐情绪配置字段，原有数据保持不变。");
    } catch (error) {
      // 多个执行者同时补字段时，只忽略重复字段错误，并继续核验。
      if (error.code !== "ER_DUP_FIELDNAME") throw error;
    }
    column = await readColumn();
  }
  if (!column) {
    console.error("[missing] evaluationDimensions.emotionCategories 不存在；需执行 --apply。");
    process.exitCode = 2;
  } else if (column.DATA_TYPE !== "json" || column.IS_NULLABLE !== "YES") {
    console.error("[mismatch] 字段存在但不是可空 JSON；请人工核查，不自动更改类型。");
    process.exitCode = 1;
  } else {
    console.log("[ok] evaluationDimensions.emotionCategories 为可空 JSON，无需重复迁移。");
  }
} catch (error) {
  // 不输出连接配置、SQL 参数或可能包含凭据的完整错误对象。
  console.error(`[failed] 数据库检查/迁移失败 (${error.code || "UNKNOWN"})；请核查连接、DDL 权限与数据库日志。`);
  process.exitCode = 1;
} finally {
  if (conn) await conn.end();
}