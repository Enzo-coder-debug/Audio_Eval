// 一次性对生产 RDS(经隧道 13306)执行 0008 迁移:
// - evaluationDimensions 增加 dimensionType / referenceAudioFileId / targetGroupLabels
// - 兜底 responses.visitorToken(若线上曾漏做 0007)
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

// 0008: evaluationDimensions 三列
for (const [col, ddl] of [
  ["dimensionType", "ALTER TABLE `evaluationDimensions` ADD `dimensionType` varchar(32) NOT NULL DEFAULT 'normal'"],
  ["referenceAudioFileId", "ALTER TABLE `evaluationDimensions` ADD `referenceAudioFileId` int NULL"],
  ["targetGroupLabels", "ALTER TABLE `evaluationDimensions` ADD `targetGroupLabels` text NULL"],
]) {
  if (await hasColumn("evaluationDimensions", col)) {
    console.log(`[skip] evaluationDimensions.${col} 已存在`);
  } else {
    await conn.query(ddl);
    console.log(`[done] 已添加 evaluationDimensions.${col}`);
  }
}

// 兜底 0007: responses.visitorToken
if (await hasColumn("responses", "visitorToken")) {
  console.log("[skip] responses.visitorToken 已存在");
} else {
  await conn.query("ALTER TABLE `responses` ADD `visitorToken` varchar(64) NULL");
  console.log("[done] 已添加 responses.visitorToken");
}

const [after] = await conn.query(
  "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND ((TABLE_NAME='evaluationDimensions' AND COLUMN_NAME IN ('dimensionType','referenceAudioFileId','targetGroupLabels')) OR (TABLE_NAME='responses' AND COLUMN_NAME='visitorToken'))",
  [dbName]
);
console.log("迁移后字段:", after);

await conn.end();
console.log("完成。");