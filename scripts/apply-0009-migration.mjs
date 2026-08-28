// 一次性对生产 RDS(经隧道 13306)执行 0009 迁移:
// - questionnaires 增加 sampleSize (int, nullable) —— 问卷抽样发放组数
// - responses 增加 sampledGroupLabels (json, nullable) —— 每份答卷抽中的组别子集
// 幂等:字段已存在则跳过。用 mysql2(支持 mysql_native_password)。
import mysql from "mysql2/promise";

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.error("请先 export DATABASE_URL");
  process.exit(1);
}

const conn = await mysql.createConnection(URL);
const [dbRow] = await conn.query("SELECT DATABASE() AS db");
const dbName = dbRow[0].db;
console.log("已连接数据库:", dbName);

async function hasColumn(table, col) {
  const [rows] = await conn.query(
    "SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?",
    [dbName, table, col]
  );
  return rows[0].c > 0;
}

for (const [table, col, ddl] of [
  ["questionnaires", "sampleSize", "ALTER TABLE `questionnaires` ADD `sampleSize` int NULL"],
  ["responses", "sampledGroupLabels", "ALTER TABLE `responses` ADD `sampledGroupLabels` json NULL"],
]) {
  if (await hasColumn(table, col)) {
    console.log(`[skip] ${table}.${col} 已存在`);
  } else {
    await conn.query(ddl);
    console.log(`[done] 已添加 ${table}.${col}`);
  }
}

const [after] = await conn.query(
  "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND ((TABLE_NAME='questionnaires' AND COLUMN_NAME='sampleSize') OR (TABLE_NAME='responses' AND COLUMN_NAME='sampledGroupLabels'))",
  [dbName]
);
console.log("迁移后字段:", after);

await conn.end();
console.log("完成。");