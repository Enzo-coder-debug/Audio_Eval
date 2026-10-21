import { parseArgs } from "node:util";
import mysql from "mysql2/promise";
import { buildFilenameGroupUpdates } from "../shared/audioGroupLabels.ts";

let connection;
let inTransaction = false;
try {
  const { values } = parseArgs({
    options: {
      title: { type: "string" },
      "expected-count": { type: "string" },
      apply: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const expectedCount = Number(values["expected-count"]);
  if (
    !values.title?.trim() ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount <= 0
  ) {
    console.error(
      '用法: node --import tsx scripts/backfill-audio-group-labels.mjs --title "问卷完整名称" --expected-count 800 [--apply]'
    );
    process.exitCode = 1;
  } else if (!process.env.DATABASE_URL) {
    console.error(
      "缺少 DATABASE_URL，请显式使用目标环境的配置；本脚本不自动加载 .env。"
    );
    process.exitCode = 1;
  } else {
    connection = await mysql.createConnection({
      uri: process.env.DATABASE_URL,
      connectTimeout: 5000,
    });
    if (values.apply) {
      await connection.beginTransaction();
      inTransaction = true;
    }
    const [questionnaires] = await connection.query(
      "SELECT id, title, status FROM questionnaires WHERE title = ?" +
        (values.apply ? " FOR UPDATE" : ""),
      [values.title]
    );
    if (
      questionnaires.length !== 1 ||
      questionnaires[0].title !== values.title
    ) {
      console.error("[stop] 未找到唯一且名称完全匹配的问卷；未修改数据。");
      process.exitCode = 1;
    } else {
      const questionnaire = questionnaires[0];
      const [audios] = await connection.query(
        "SELECT id, fileName, modelName, groupLabel FROM audioFiles WHERE questionnaireId = ? ORDER BY id" +
          (values.apply ? " FOR UPDATE" : ""),
        [questionnaire.id]
      );
      const normalAudios = audios.filter(
        audio => audio.modelName !== "__reference__"
      );
      console.table([{ ...questionnaire, audioCount: normalAudios.length }]);
      if (normalAudios.length !== expectedCount) {
        console.error(
          `[stop] 预期 ${expectedCount} 个测评音频，实际 ${normalAudios.length} 个；未修改数据。`
        );
        process.exitCode = 1;
      } else {
        const items = buildFilenameGroupUpdates(audios);
        const namesById = new Map(
          audios.map(audio => [audio.id, audio.fileName])
        );
        console.log(
          `[preview] 待补齐 ${items.length} 个；保留 ${normalAudios.length - items.length} 个已有组别；跳过 ${audios.length - normalAudios.length} 个参考音频。`
        );
        console.table(
          items.slice(0, 10).map(item => ({
            ...item,
            fileName: namesById.get(item.audioFileId),
          }))
        );
        console.log(
          "规则：文件名去掉最后一个扩展名；不识别音频内容，不自动合并带不同模型前后缀的文件名。"
        );
        if (values.apply) {
          let updatedCount = 0;
          for (const item of items) {
            const [result] = await connection.query(
              "UPDATE audioFiles SET groupLabel = ? WHERE id = ? AND questionnaireId = ?",
              [item.groupLabel, item.audioFileId, questionnaire.id]
            );
            updatedCount += result.affectedRows;
          }
          if (updatedCount !== items.length)
            throw Object.assign(new Error(), { code: "ROW_COUNT_MISMATCH" });
          await connection.commit();
          inTransaction = false;
          console.log(
            `[done] 已补齐 ${updatedCount} 个组别；未更改配对、答卷、评分维度或音频文件。`
          );
        } else {
          console.log(
            "[check] 仅预览，未修改数据库。核对目标问卷和样例后，加 --apply 执行。"
          );
        }
      }
    }
  }
} catch (error) {
  console.error(
    `[failed] 检查或补齐失败 (${error.code || "VALIDATION_OR_DATABASE_ERROR"})；未提交的修改将回滚，请核查文件名、权限与数据库日志。`
  );
  process.exitCode = 1;
} finally {
  if (connection) {
    try {
      if (inTransaction) await connection.rollback();
    } finally {
      await connection.end();
    }
  }
}
