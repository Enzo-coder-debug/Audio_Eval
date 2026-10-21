import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql, { type Connection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { appRouter } from "./routers";
import * as db from "./db";
import {
  allocateSubQuestionnaire,
  configureSubQuestionnaires,
  getSubQuestionnaireDistribution,
  saveSubQuestionnaireAnswers,
} from "./subQuestionnaires";
import type { TrpcContext } from "./_core/context";

const testUrl = process.env.SUBQUESTIONNAIRE_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("隔离 MySQL 子问卷发放集成", () => {
  let connection: Connection;
  let questionnaireId: number;
  let dimensionId: number;
  const ownerId = 41;
  const caller = appRouter.createCaller({
    user: null,
    req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    res: {},
  } as TrpcContext);
  const identity = (index: number) => ({
    questionnaireId,
    visitorToken: `sub-questionnaire-visitor-${index}`,
    visitorName: `测试答卷人${index}`,
    visitorIp: "127.0.0.1",
  });
  let firstAssignment: Awaited<ReturnType<typeof allocateSubQuestionnaire>>;

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      !/^\/sub_questionnaire_test_[a-z0-9_]+$/.test(url.pathname)
    )
      throw new Error(
        "测试仅允许本地 sub_questionnaire_test_ 前缀的隔离数据库"
      );
    connection = await mysql.createConnection(testUrl!);
    const [existing] = await connection.query<any[]>("SHOW TABLES");
    if (existing.length)
      throw new Error("测试数据库必须为空，避免覆盖已有数据");
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8"
      )
    );
    for (const entry of journal.entries) {
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
    vi.stubEnv("DATABASE_URL", testUrl!);
    const [created] = await connection.execute<mysql.ResultSetHeader>(
      "INSERT INTO questionnaires (creatorId, title, status, shareToken) VALUES (?, ?, 'draft', ?)",
      [ownerId, "400组固定子问卷验证", "distribution-test-share"]
    );
    questionnaireId = created.insertId;
    const [dimension] = await connection.execute<mysql.ResultSetHeader>(
      "INSERT INTO evaluationDimensions (questionnaireId, dimensionName, dimensionType, orderIndex) VALUES (?, '自然度', 'normal', 0)",
      [questionnaireId]
    );
    dimensionId = dimension.insertId;
    const audios = Array.from({ length: 800 }, (_, index) => [
      ownerId,
      `分组_${Math.floor(index / 2) + 1}.wav`,
      `test/${index}.wav`,
      `/test/${index}.wav`,
      "audio/wav",
      0,
      index % 2 ? "B" : "A",
      questionnaireId,
      `组别-${String(Math.floor(index / 2) + 1).padStart(4, "0")}`,
    ]);
    await connection.query(
      "INSERT INTO audioFiles (uploaderId, fileName, fileKey, fileUrl, mimeType, fileSizeBytes, modelName, questionnaireId, groupLabel) VALUES ?",
      [audios]
    );
    const pairs = Array.from({ length: 400 }, (_, index) => [
      questionnaireId,
      index * 2 + 1,
      index * 2 + 2,
      index,
    ]);
    await connection.query(
      "INSERT INTO blindTestPairs (questionnaireId, leftAudioFileId, rightAudioFileId, pairIndex) VALUES ?",
      [pairs]
    );
  }, 30000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (connection) await connection.end();
  });

  it("只有所属管理员可配置；400 组生成 8 × 50，不覆盖音频", async () => {
    const input = {
      questionnaireId,
      groupsPerForm: 50,
      quota: 20,
      enabled: true,
    };
    await expect(
      configureSubQuestionnaires(input, ownerId + 1)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(configureSubQuestionnaires(input, ownerId)).resolves.toEqual({
      success: true,
    });
    const report = await getSubQuestionnaireDistribution(
      questionnaireId,
      ownerId
    );
    expect(report.forms).toHaveLength(8);
    expect(
      report.forms.every(
        form =>
          form.groupLabels.length === 50 &&
          form.quota === 20 &&
          form.remaining === 20
      )
    ).toBe(true);
    const [rows] = await connection.query<any[]>(
      "SELECT COUNT(*) AS count FROM audioFiles"
    );
    expect(rows[0].count).toBe(800);
  });

  it("可停用未发放方案并重建；配置已发布问卷被拒绝", async () => {
    await configureSubQuestionnaires(
      { questionnaireId, groupsPerForm: 50, quota: 20, enabled: false },
      ownerId
    );
    expect(
      (await getSubQuestionnaireDistribution(questionnaireId, ownerId)).enabled
    ).toBe(false);
    await configureSubQuestionnaires(
      { questionnaireId, groupsPerForm: 50, quota: 20, enabled: true },
      ownerId
    );
    await connection.execute(
      "UPDATE questionnaires SET status='published' WHERE id=?",
      [questionnaireId]
    );
    await expect(
      configureSubQuestionnaires(
        { questionnaireId, groupsPerForm: 50, quota: 20, enabled: true },
        ownerId
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("领取前不暴露题目和全部子问卷分组", async () => {
    const result = await caller.questionnaire.getByShareToken({
      shareToken: "distribution-test-share",
    });
    expect(result.blindTestPairs).toEqual([]);
    expect(result.subQuestionnairePlan).toBeUndefined();
    expect(result.distribution).toEqual({
      formCount: 8,
      minGroups: 50,
      maxGroups: 50,
    });
  });

  it("同一访客并发开始只占一份，断点续答不重抽", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => allocateSubQuestionnaire(identity(0)))
    );
    firstAssignment = results[0];
    expect(new Set(results.map(result => result.responseId)).size).toBe(1);
    expect(new Set(results.map(result => result.form.index)).size).toBe(1);
    expect(
      (
        await getSubQuestionnaireDistribution(questionnaireId, ownerId)
      ).forms.reduce((total, form) => total + form.assigned, 0)
    ).toBe(1);
  });

  it("并发 170 人仅新增 159 份，8 张各不超过 20 份", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 170 }, (_, index) =>
        allocateSubQuestionnaire(identity(index + 1))
      )
    );
    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(159);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(
      11
    );
    const report = await getSubQuestionnaireDistribution(
      questionnaireId,
      ownerId
    );
    expect(
      report.forms.every(
        form =>
          form.assigned === 20 && form.remaining === 0 && form.inProgress === 20
      )
    ).toBe(true);
  }, 60000);

  it("满额仍可续答，只返回所领 50 组；他人 token 无权读取", async () => {
    const resumed = await caller.response.startPublic(identity(0));
    expect(resumed.responseId).toBe(firstAssignment.responseId);
    expect(resumed.sampledGroupLabels).toEqual(
      firstAssignment.form.groupLabels
    );
    const result = await caller.questionnaire.getByShareToken({
      shareToken: "distribution-test-share",
      responseId: firstAssignment.responseId,
      visitorToken: identity(0).visitorToken,
    });
    expect(result.blindTestPairs).toHaveLength(50);
    expect(
      result.blindTestPairs.every(pair =>
        firstAssignment.form.pairIds.includes(pair.id)
      )
    ).toBe(true);
    await expect(
      caller.questionnaire.getByShareToken({
        shareToken: "distribution-test-share",
        responseId: firstAssignment.responseId,
        visitorToken: identity(999).visitorToken,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("拒绝越界/重复/缺失评分，正确保存与提交，提交后防止延迟进度覆盖", async () => {
    const base = {
      responseId: firstAssignment.responseId,
      visitorToken: identity(0).visitorToken,
    };
    const answer = (pairId: number) => ({
      blindTestPairId: pairId,
      evaluationDimensionId: dimensionId,
      blindTestChoice: "same" as const,
    });
    const outside = Array.from({ length: 400 }, (_, index) => index + 1).find(
      pairId => !firstAssignment.form.pairIds.includes(pairId)
    )!;
    await expect(
      saveSubQuestionnaireAnswers(
        { ...base, answers: [answer(outside)] },
        false
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const one = answer(firstAssignment.form.pairIds[0]);
    await expect(
      saveSubQuestionnaireAnswers({ ...base, answers: [one, one] }, false)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      saveSubQuestionnaireAnswers({ ...base, answers: [one] }, true)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      saveSubQuestionnaireAnswers(
        { ...base, visitorToken: identity(999).visitorToken, answers: [one] },
        false
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await saveSubQuestionnaireAnswers({ ...base, answers: [one] }, false);
    expect(
      (await caller.response.startPublic(identity(0))).savedAnswers
    ).toHaveLength(1);
    await caller.response.submitPublic({
      ...base,
      answers: firstAssignment.form.pairIds.map(answer),
    });
    await expect(
      caller.response.saveProgressPublic({ ...base, answers: [one] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(allocateSubQuestionnaire(identity(0))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const [rows] = await connection.execute<any[]>(
      "SELECT COUNT(*) AS count FROM answers WHERE responseId=?",
      [firstAssignment.responseId]
    );
    expect(rows[0].count).toBe(50);
    const report = await getSubQuestionnaireDistribution(
      questionnaireId,
      ownerId
    );
    expect(
      report.forms.find(form => form.index === firstAssignment.form.index)
    ).toMatchObject({
      assigned: 20,
      completed: 1,
      inProgress: 19,
      remaining: 0,
    });
  });

  it("方案启用时数据库写保护不允许绕过分配或修改题库", async () => {
    await expect(
      db.updateAudioGroupLabels(questionnaireId, [
        { audioFileId: 1, groupLabel: "改名" },
      ])
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(db.deleteAudioFile(1)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      db.deleteBlindTestPairsByQuestionnaire(questionnaireId)
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      db.deleteResponsesByQuestionnaire(questionnaireId)
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      db.createAnonymousResponse({
        questionnaireId,
        visitorName: "绕过",
        status: "in_progress",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      db.updateQuestionnaire(questionnaireId, { sampleSize: 1 })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await connection.execute(
      "UPDATE questionnaires SET status='offline' WHERE id=?",
      [questionnaireId]
    );
    await expect(
      configureSubQuestionnaires(
        { questionnaireId, groupsPerForm: 50, quota: 20, enabled: false },
        ownerId
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await connection.execute(
      "UPDATE questionnaires SET status='published' WHERE id=?",
      [questionnaireId]
    );
    expect(
      (await getSubQuestionnaireDistribution(questionnaireId, ownerId))
        .responseCount
    ).toBe(160);
  });
});
