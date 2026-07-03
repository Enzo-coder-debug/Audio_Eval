// 一次性对生产 RDS(经隧道 13306)执行 0006 迁移:给 audioFiles 加 questionnaireId + groupLabel。
// 幂等:先查字段是否存在,不存在才 ADD COLUMN。用 mysql2(支持 mysql_native_password)。
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

async function hasColumn(col) {
  const [rows] = await conn.query(
    "SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='audioFiles' AND COLUMN_NAME=?",
    [dbName, col]
  );
  return rows[0].c > 0;
}

for (const [col, ddl] of [
  ["questionnaireId", "ALTER TABLE `audioFiles` ADD `questionnaireId` int"],
  ["groupLabel", "ALTER TABLE `audioFiles` ADD `groupLabel` varchar(255)"],
]) {
  if (await hasColumn(col)) {
    console.log(`[skip] 字段已存在: ${col}`);
  } else {
    await conn.query(ddl);
    console.log(`[done] 已添加字段: ${col}`);
  }
}

const [after] = await conn.query(
  "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='audioFiles' AND COLUMN_NAME IN ('questionnaireId','groupLabel')",
  [dbName]
);
console.log("迁移后字段:", after);

await conn.end();
console.log("完成。");