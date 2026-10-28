import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mysql, { type Connection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import { MAX_RESPONSE_DELETE_BATCH } from "../shared/responseDeletion";
import {
  allocateSubQuestionnaire,
  configureSubQuestionnaires,
  getSubQuestionnaireDistribution,
  saveSubQuestionnaireAnswers,
} from "./subQuestionnaires";

const testUrl = process.env.RESPONSE_DELETE_TEST_DATABASE_URL;

describe.skipIf(!testUrl)("隔离 MySQL 删除答卷与名额回收", () => {
  let connection: Connection;
  let questionnaireId: number;
  let ordinaryQuestionnaireId: number;
  let dimensionId: number;
  const ownerId = 41;
  const makeCaller = (user: { id: number; role: string } | null) =>
    appRouter.createCaller({
      user,
      req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
      res: {},
    } as TrpcContext);
  const owner = makeCaller({ id: ownerId, role: "admin" });
  const visitor = makeCaller(null);
  const identity = (index: number) => ({
    questionnaireId,
    visitorToken: `response-delete-visitor-${index}`,
    visitorName: `测试答题人${index}`,
    visitorIp: "127.0.0.1",
  });
  const remove = (
    responseId: number,
    targetQuestionnaireId = questionnaireId
  ) =>
    owner.response.delete({
      questionnaireId: targetQuestionnaireId,
      responseId,
    });
  const count = async (
    table: "responses" | "answers",
    column: "id" | "responseId",
    responseId: number
  ) => {
    const [rows] = await connection.query<any[]>(
      `SELECT COUNT(*) AS total FROM \`${table}\` WHERE \`${column}\`=?`,
      [responseId]
    );
    return Number(rows[0].total);
  };

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !/^\/response_delete_test_[a-z0-9_]+$/.test(url.pathname)
    ) {
      throw new Error("测试仅允许本地 response_delete_test_ 前缀的隔离数据库");
    }
    connection = await mysql.createConnection(testUrl!);
    const [existing] = await connection.query<any[]>("SHOW TABLES");
    if (existing.length)
      throw new Error("测试数据库必须为空，禁止覆盖已有数据");
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8"
      )
    );
    for (const entry of journal.entries) {
      const source = await readFile(
        new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
        "utf8"
      );
      for (const statement of source
        .split("--> statement-breakpoint")
        .map((value: string) => value.trim())
        .filter(Boolean)) {
        await connection.query(statement);
      }
    }
    vi.stubEnv("DATABASE_URL", testUrl!);
  });

  afterAll(async () => {
    await connection?.end();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    for (const table of [
      "answers",
      "responses",
      "questionnaireStats",
      "blindTestPairs",
      "audioFiles",
      "evaluationDimensions",
      "questions",
      "questionnaires",
    ]) {
      await connection.query(`DELETE FROM \`${table}\``);
    }
    const [questionnaire] = await connection.execute<mysql.ResultSetHeader>(
      "INSERT INTO questionnaires (creatorId,title,status,shareToken) VALUES (?, '删除与名额测试', 'draft', 'response-deletion-share')",
      [ownerId]
    );
    questionnaireId = questionnaire.insertId;
    const [ordinary] = await connection.execute<mysql.ResultSetHeader>(
      "INSERT INTO questionnaires (creatorId,title,status,shareToken) VALUES (?, '普通问卷删除测试', 'published', 'ordinary-response-deletion-share')",
      [ownerId]
    );
    ordinaryQuestionnaireId = ordinary.insertId;
    const [dimension] = await connection.execute<mysql.ResultSetHeader>(
      "INSERT INTO evaluationDimensions (questionnaireId, dimensionName, dimensionType, orderIndex) VALUES (?, '自然度', 'normal', 0)",
      [questionnaireId]
    );
    dimensionId = dimension.insertId;
    for (let group = 1; group <= 2; group++) {
      const audioIds: number[] = [];
      for (const model of ["A", "B"]) {
        const [audio] = await connection.execute<mysql.ResultSetHeader>(
          "INSERT INTO audioFiles (uploaderId,questionnaireId,fileName,fileKey,fileUrl,mimeType,fileSizeBytes,modelName,groupLabel) VALUES (?,?,?,?,?,'audio/wav',0,?,?)",
          [
            ownerId,
            questionnaireId,
            `group-${group}-${model}.wav`,
            `test/${group}-${model}`,
            `/test/${group}-${model}`,
            model,
            `group-${group}`,
          ]
        );
        audioIds.push(audio.insertId);
      }
      await connection.execute(
        "INSERT INTO blindTestPairs (questionnaireId,leftAudioFileId,rightAudioFileId,pairIndex) VALUES (?,?,?,?)",
        [questionnaireId, ...audioIds, group]
      );
    }
    await configureSubQuestionnaires(
      { questionnaireId, enabled: true, groupsPerForm: 1, quota: 1 },
      ownerId
    );
    await connection.execute(
      "UPDATE questionnaires SET status='published' WHERE id=?",
      [questionnaireId]
    );
  });

  async function seedAnswers(responseId: number, pairId: number) {
    await connection.execute(
      "INSERT INTO answers (responseId,blindTestPairId,evaluationDimensionId,blindTestChoice) VALUES (?,?,?,'same')",
      [responseId, pairId, dimensionId]
    );
    await connection.execute(
      "INSERT INTO answers (responseId,audioEvaluation,answerContent,score,feedback) VALUES (?,?,'legacy answer',5,'legacy feedback')",
      [
        responseId,
        JSON.stringify({
          left: { score: 2, text: "测试" },
          right: { score: 3, text: "错填" },
        }),
      ]
    );
  }

  async function ordinaryResponse(userId: number | null = null) {
    const [created] = await connection.execute<mysql.ResultSetHeader>(
      "INSERT INTO responses (questionnaireId,userId,visitorToken,visitorName,visitorIp,status) VALUES (?,?,?,?,?,'in_progress')",
      [
        ordinaryQuestionnaireId,
        userId,
        identity(1).visitorToken,
        identity(1).visitorName,
        "127.0.0.1",
      ]
    );
    return created.insertId;
  }

  it.each(["in_progress", "submitted", "graded"])(
    "删除 %s 答卷后回收名额、重算统计，原答题人可重新领取",
    async status => {
      const target = await allocateSubQuestionnaire(identity(1));
      const other = await allocateSubQuestionnaire(identity(2));
      await seedAnswers(target.responseId, target.form.pairIds[0]);
      await seedAnswers(other.responseId, other.form.pairIds[0]);
      await connection.execute(
        "UPDATE responses SET status=?,totalScore=10 WHERE id=?",
        [status, target.responseId]
      );
      await connection.execute(
        "UPDATE responses SET status='graded',totalScore=6 WHERE id=?",
        [other.responseId]
      );
      const before = await db.getQuestionnaireById(questionnaireId);
      await db.getOrCreateStats(questionnaireId);
      await expect(visitor.response.startPublic(identity(3))).rejects.toThrow(
        "全部领满"
      );

      const deleted = await remove(target.responseId);
      expect(deleted).toMatchObject({
        success: true,
        releasedQuota: 1,
        stats: {
          totalResponses: 1,
          averageScore: "6.00",
          highestScore: "6.00",
          lowestScore: "6.00",
          completionRate: "100.00",
        },
      });
      expect(await count("responses", "id", target.responseId)).toBe(0);
      expect(await count("answers", "responseId", target.responseId)).toBe(0);
      expect(await count("answers", "responseId", other.responseId)).toBe(2);
      expect(
        (await db.getQuestionnaireById(questionnaireId))?.subQuestionnairePlan
      ).toEqual(before?.subQuestionnairePlan);
      const distribution = await getSubQuestionnaireDistribution(
        questionnaireId,
        ownerId
      );
      expect(
        distribution.forms.find(form => form.index === target.form.index)
      ).toMatchObject({
        assigned: 0,
        completed: 0,
        inProgress: 0,
        remaining: 1,
        quota: 1,
      });
      expect(
        distribution.forms.find(form => form.index === other.form.index)
      ).toMatchObject({ assigned: 1, completed: 1, remaining: 0, quota: 1 });
      const replacement = await visitor.response.startPublic(identity(1));
      expect(replacement.responseId).not.toBe(target.responseId);
      expect(replacement.savedAnswers).toEqual([]);
      await expect(remove(target.responseId)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(
        (
          await getSubQuestionnaireDistribution(questionnaireId, ownerId)
        ).forms.every(form => form.remaining === 0)
      ).toBe(true);
      const responses = await owner.response.listQuestionnaire({
        questionnaireId,
      });
      expect(responses.responses.map(response => response.id)).not.toContain(
        target.responseId
      );
      expect(
        responses.responses.find(response => response.id === other.responseId)
          ?.answers
      ).toHaveLength(2);
      expect(
        (await owner.stats.aggregate({ questionnaireId })).responseSamples.map(
          response => response.id
        )
      ).toEqual([other.responseId]);
    }
  );

  it("删除最后一份答卷清空旧分数统计，保留音频和问卷", async () => {
    const target = await allocateSubQuestionnaire(identity(1));
    await connection.execute(
      "UPDATE responses SET status='graded',totalScore=8 WHERE id=?",
      [target.responseId]
    );
    await db.getOrCreateStats(questionnaireId);
    const result = await remove(target.responseId);
    expect(result.stats).toMatchObject({
      totalResponses: 0,
      completionRate: "0.00",
      averageScore: null,
      highestScore: null,
      lowestScore: null,
    });
    const [stored] = await connection.query<any[]>(
      "SELECT * FROM questionnaireStats WHERE questionnaireId=?",
      [questionnaireId]
    );
    expect(stored[0]).toMatchObject({
      totalResponses: 0,
      completionRate: "0.00",
      averageScore: null,
    });
    expect(await db.getAudioFilesByQuestionnaire(questionnaireId)).toHaveLength(
      4
    );
    expect(
      await db.getBlindTestPairsByQuestionnaire(questionnaireId)
    ).toHaveLength(2);
    expect(
      await db.getEvaluationDimensionsByQuestionnaire(questionnaireId)
    ).toHaveLength(1);
    expect((await db.getQuestionnaireById(questionnaireId))?.status).toBe(
      "published"
    );
  });

  it("只统计有效剩余答卷，submitted 也计入完成率", async () => {
    const target = await allocateSubQuestionnaire(identity(1));
    const other = await allocateSubQuestionnaire(identity(2));
    await connection.execute(
      "UPDATE responses SET status='submitted' WHERE id=?",
      [other.responseId]
    );
    expect((await db.getOrCreateStats(questionnaireId)).completionRate).toBe(
      "50.00"
    );
    expect((await remove(target.responseId)).stats).toMatchObject({
      totalResponses: 1,
      completionRate: "100.00",
      averageScore: null,
    });
  });

  it("其他管理员、普通用户和跨问卷请求不能删除记录", async () => {
    const target = await allocateSubQuestionnaire(identity(1));
    await expect(
      makeCaller({ id: 42, role: "admin" }).response.delete({
        questionnaireId,
        responseId: target.responseId,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      makeCaller({ id: ownerId, role: "user" }).response.delete({
        questionnaireId,
        responseId: target.responseId,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      remove(target.responseId, ordinaryQuestionnaireId)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await count("responses", "id", target.responseId)).toBe(1);
  });

  it("统计写入失败时，答卷、答案和名额一起回滚", async () => {
    const target = await allocateSubQuestionnaire(identity(1));
    await seedAnswers(target.responseId, target.form.pairIds[0]);
    await connection.query(
      "CREATE TRIGGER fail_response_delete_stats BEFORE INSERT ON questionnaireStats FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test_stats_failure'"
    );
    try {
      await expect(remove(target.responseId)).rejects.toThrow();
    } finally {
      await connection.query("DROP TRIGGER fail_response_delete_stats");
    }
    expect(await count("responses", "id", target.responseId)).toBe(1);
    expect(await count("answers", "responseId", target.responseId)).toBe(2);
    expect(
      (
        await getSubQuestionnaireDistribution(questionnaireId, ownerId)
      ).forms.find(form => form.index === target.form.index)?.remaining
    ).toBe(0);
  });

  it("旧答卷 ID 无法在删除后继续保存或提交", async () => {
    const target = await allocateSubQuestionnaire(identity(1));
    await remove(target.responseId);
    const payload = {
      responseId: target.responseId,
      visitorToken: identity(1).visitorToken,
      answers: [],
    };
    await expect(
      visitor.response.saveProgressPublic(payload)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(visitor.response.submitPublic(payload)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      saveSubQuestionnaireAnswers(payload, false)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await count("answers", "responseId", target.responseId)).toBe(0);
  });

  it("并发删除与多次领取不会超过子问卷发放上限", async () => {
    const target = await allocateSubQuestionnaire(identity(1));
    await allocateSubQuestionnaire(identity(2));
    const results = await Promise.allSettled([
      remove(target.responseId),
      visitor.response.startPublic(identity(3)),
      visitor.response.startPublic(identity(4)),
    ]);
    expect(results[0].status).toBe("fulfilled");
    const allocated = results
      .slice(1)
      .filter(result => result.status === "fulfilled");
    expect(allocated.length).toBeLessThanOrEqual(1);
    if (allocated.length === 0) await visitor.response.startPublic(identity(5));
    const distribution = await getSubQuestionnaireDistribution(
      questionnaireId,
      ownerId
    );
    expect(distribution.responseCount).toBe(2);
    expect(
      distribution.forms.every(
        form => form.assigned === 1 && form.remaining === 0 && form.quota === 1
      )
    ).toBe(true);
  });

  it("普通问卷删除后也可用原姓名重填，不产生子问卷名额变动", async () => {
    const responseId = await ordinaryResponse();
    expect(
      (await remove(responseId, ordinaryQuestionnaireId)).releasedQuota
    ).toBe(0);
    const replacement = await visitor.response.startPublic({
      ...identity(1),
      questionnaireId: ordinaryQuestionnaireId,
    });
    expect(replacement.responseId).not.toBe(responseId);
    expect(
      (await db.getQuestionnaireResponses(ordinaryQuestionnaireId)).length
    ).toBe(1);
  });

  it("不同问卷并发删除时分别更新统计，不互相扣减", async () => {
    const assigned = await allocateSubQuestionnaire(identity(1));
    const ordinaryId = await ordinaryResponse();
    const results = await Promise.all([
      remove(assigned.responseId),
      remove(ordinaryId, ordinaryQuestionnaireId),
    ]);
    expect(results.map(result => result.stats.totalResponses)).toEqual([0, 0]);
    expect(results.map(result => result.releasedQuota)).toEqual([1, 0]);
  });

  it("登录答题人正常提交保留答案，重复提交和删除后的旧 ID 都不能写入", async () => {
    const responseId = await ordinaryResponse(71);
    const [question] = await connection.execute<mysql.ResultSetHeader>(
      "INSERT INTO questions (questionnaireId,questionType,questionText,orderIndex) VALUES (?,'subjective','测试题目',0)",
      [ordinaryQuestionnaireId]
    );
    const answers = [
      { questionId: question.insertId, answerContent: "测试答案" },
    ];
    await expect(
      db.submitAuthenticatedAnswers(responseId, 72, answers)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.submitAuthenticatedAnswers(responseId, 71, answers);
    expect((await db.getResponseById(responseId))?.status).toBe("submitted");
    expect(await db.getAnswersByResponse(responseId)).toMatchObject([
      { answerContent: "测试答案" },
    ]);
    await expect(
      db.submitAuthenticatedAnswers(responseId, 71, answers)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await remove(responseId, ordinaryQuestionnaireId);
    await expect(
      db.submitAuthenticatedAnswers(responseId, 71, answers)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await count("answers", "responseId", responseId)).toBe(0);
  });

  it("跨子问卷批量删除混合状态答卷，仅回收所选记录名额并保留其他答卷", async () => {
    await connection.execute(
      "UPDATE questionnaires SET status='draft' WHERE id=?",
      [questionnaireId]
    );
    await configureSubQuestionnaires(
      { questionnaireId, enabled: true, groupsPerForm: 1, quota: 2 },
      ownerId
    );
    await connection.execute(
      "UPDATE questionnaires SET status='published' WHERE id=?",
      [questionnaireId]
    );
    const assignments = [];
    for (let index = 0; index < 4; index++) {
      const assignment = await allocateSubQuestionnaire(identity(index + 20));
      assignments.push(assignment);
      await seedAnswers(assignment.responseId, assignment.form.pairIds[0]);
      await connection.execute(
        "UPDATE responses SET status='graded',totalScore=6 WHERE id=?",
        [assignment.responseId]
      );
    }
    const targets = [1, 2].map(
      formIndex =>
        assignments.find(assignment => assignment.form.index === formIndex)!
    );
    const targetIds = targets.map(target => target.responseId);
    await connection.execute(
      "UPDATE responses SET status='in_progress',totalScore=NULL WHERE id=?",
      [targetIds[0]]
    );
    await connection.execute(
      "UPDATE responses SET status='submitted',totalScore=NULL WHERE id=?",
      [targetIds[1]]
    );
    const previousPlan = (await db.getQuestionnaireById(questionnaireId))
      ?.subQuestionnairePlan;
    const result = await owner.response.deleteBatch({
      questionnaireId,
      responseIds: targetIds,
    });
    expect(result).toMatchObject({
      deletedCount: 2,
      releasedQuota: 2,
      stats: {
        totalResponses: 2,
        completionRate: "100.00",
        averageScore: "6.00",
      },
    });
    expect(result.responseIds).toEqual(
      [...targetIds].sort((left, right) => left - right)
    );
    for (const assignment of assignments) {
      const removed = targetIds.includes(assignment.responseId);
      expect(await count("responses", "id", assignment.responseId)).toBe(
        removed ? 0 : 1
      );
      expect(await count("answers", "responseId", assignment.responseId)).toBe(
        removed ? 0 : 2
      );
    }
    const distribution = await getSubQuestionnaireDistribution(
      questionnaireId,
      ownerId
    );
    expect(
      distribution.forms.every(
        form => form.assigned === 1 && form.remaining === 1 && form.quota === 2
      )
    ).toBe(true);
    expect(
      (await db.getQuestionnaireById(questionnaireId))?.subQuestionnairePlan
    ).toEqual(previousPlan);
    expect(
      (await owner.response.listQuestionnaire({ questionnaireId })).responses
    ).toHaveLength(2);
    const samples = (await owner.stats.aggregate({ questionnaireId }))
      .responseSamples;
    expect(samples).toHaveLength(2);
    expect(samples.every(sample => !targetIds.includes(sample.id))).toBe(true);
    const originalIndex = assignments.findIndex(
      assignment => assignment.responseId === targetIds[0]
    );
    const replacement = await visitor.response.startPublic(
      identity(originalIndex + 20)
    );
    expect(targetIds).not.toContain(replacement.responseId);
    expect(replacement.savedAnswers).toEqual([]);
  });

  it("批量删空后统计归零，重复请求不能重复释放名额", async () => {
    const first = await allocateSubQuestionnaire(identity(1));
    const second = await allocateSubQuestionnaire(identity(2));
    const input = {
      questionnaireId,
      responseIds: [first.responseId, second.responseId],
    };
    const result = await owner.response.deleteBatch(input);
    expect(result).toMatchObject({
      deletedCount: 2,
      releasedQuota: 2,
      stats: { totalResponses: 0, completionRate: "0.00", averageScore: null },
    });
    await expect(owner.response.deleteBatch(input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      (
        await getSubQuestionnaireDistribution(questionnaireId, ownerId)
      ).forms.every(form => form.assigned === 0 && form.remaining === 1)
    ).toBe(true);
  });

  it("批次混入其他问卷或已经失效的答卷时整批不删除", async () => {
    const target = await allocateSubQuestionnaire(identity(1));
    const other = await allocateSubQuestionnaire(identity(2));
    const foreignId = await ordinaryResponse();
    await seedAnswers(target.responseId, target.form.pairIds[0]);
    await expect(
      owner.response.deleteBatch({
        questionnaireId,
        responseIds: [target.responseId, foreignId],
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await count("responses", "id", foreignId)).toBe(1);
    expect(await count("responses", "id", target.responseId)).toBe(1);
    await remove(other.responseId);
    await expect(
      owner.response.deleteBatch({
        questionnaireId,
        responseIds: [target.responseId, other.responseId],
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await count("responses", "id", target.responseId)).toBe(1);
    expect(await count("answers", "responseId", target.responseId)).toBe(2);
    expect((await db.getOrCreateStats(questionnaireId)).totalResponses).toBe(1);
  });

  it("批量删除拒绝越权和重复 ID，不触碰已选记录", async () => {
    const target = await allocateSubQuestionnaire(identity(1));
    await expect(
      makeCaller({ id: 42, role: "admin" }).response.deleteBatch({
        questionnaireId,
        responseIds: [target.responseId],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      db.deleteQuestionnaireResponses(
        questionnaireId,
        [target.responseId, target.responseId],
        ownerId
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await count("responses", "id", target.responseId)).toBe(1);
  });

  it("批量统计写入失败时，两份答卷、全部答案与名额均回滚", async () => {
    const first = await allocateSubQuestionnaire(identity(1));
    const second = await allocateSubQuestionnaire(identity(2));
    for (const target of [first, second])
      await seedAnswers(target.responseId, target.form.pairIds[0]);
    await db.getOrCreateStats(questionnaireId);
    await connection.query(
      "CREATE TRIGGER fail_batch_response_delete_stats BEFORE INSERT ON questionnaireStats FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test_batch_stats_failure'"
    );
    try {
      await expect(
        owner.response.deleteBatch({
          questionnaireId,
          responseIds: [first.responseId, second.responseId],
        })
      ).rejects.toThrow();
    } finally {
      await connection.query("DROP TRIGGER fail_batch_response_delete_stats");
    }
    for (const target of [first, second]) {
      expect(await count("responses", "id", target.responseId)).toBe(1);
      expect(await count("answers", "responseId", target.responseId)).toBe(2);
    }
    expect(
      (
        await getSubQuestionnaireDistribution(questionnaireId, ownerId)
      ).forms.every(form => form.remaining === 0)
    ).toBe(true);
    expect((await db.getOrCreateStats(questionnaireId)).totalResponses).toBe(2);
  });

  it("并发重叠批次只有一批成功，另一批不部分删除剩余记录", async () => {
    const responseIds = [
      await ordinaryResponse(),
      await ordinaryResponse(),
      await ordinaryResponse(),
    ];
    const results = await Promise.allSettled([
      owner.response.deleteBatch({
        questionnaireId: ordinaryQuestionnaireId,
        responseIds: responseIds.slice(0, 2),
      }),
      owner.response.deleteBatch({
        questionnaireId: ordinaryQuestionnaireId,
        responseIds: responseIds.slice(1),
      }),
    ]);
    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({
      reason: { code: "NOT_FOUND" },
    });
    const remaining = await db.getQuestionnaireResponses(
      ordinaryQuestionnaireId
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).not.toBe(responseIds[1]);
    expect(
      (await db.getOrCreateStats(ordinaryQuestionnaireId)).totalResponses
    ).toBe(1);
  });

  it("批量删除与多人领取并发时仍不超发", async () => {
    const first = await allocateSubQuestionnaire(identity(1));
    const second = await allocateSubQuestionnaire(identity(2));
    const results = await Promise.allSettled([
      owner.response.deleteBatch({
        questionnaireId,
        responseIds: [first.responseId, second.responseId],
      }),
      visitor.response.startPublic(identity(3)),
      visitor.response.startPublic(identity(4)),
      visitor.response.startPublic(identity(5)),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(
      results.slice(1).filter(result => result.status === "fulfilled").length
    ).toBeLessThanOrEqual(2);
    const distribution = await getSubQuestionnaireDistribution(
      questionnaireId,
      ownerId
    );
    expect(distribution.responseCount).toBeLessThanOrEqual(2);
    expect(
      distribution.forms.every(
        form => form.assigned <= form.quota && form.remaining >= 0
      )
    ).toBe(true);
  });

  it("支持上限批次一次删除，统计只保留未选答卷", async () => {
    const values = Array.from(
      { length: MAX_RESPONSE_DELETE_BATCH + 1 },
      (_, index) => [ordinaryQuestionnaireId, `批量测试${index}`, "submitted"]
    );
    await connection.query(
      "INSERT INTO responses (questionnaireId,visitorName,status) VALUES ?",
      [values]
    );
    const rows = await db.getQuestionnaireResponses(ordinaryQuestionnaireId);
    const targetIds = rows
      .slice(0, MAX_RESPONSE_DELETE_BATCH)
      .map(response => response.id);
    const result = await owner.response.deleteBatch({
      questionnaireId: ordinaryQuestionnaireId,
      responseIds: targetIds,
    });
    expect(result).toMatchObject({
      deletedCount: MAX_RESPONSE_DELETE_BATCH,
      releasedQuota: 0,
      stats: { totalResponses: 1, completionRate: "100.00" },
    });
    expect(result.responseIds).toHaveLength(MAX_RESPONSE_DELETE_BATCH);
    expect(
      (await db.getQuestionnaireResponses(ordinaryQuestionnaireId)).map(
        response => response.id
      )
    ).toEqual([rows[MAX_RESPONSE_DELETE_BATCH].id]);
  });

  it.each(["public", "authenticated"])(
    "并发删除与 %s 保存/提交不会产生孤立答案",
    async mode => {
      const responseId = await ordinaryResponse(
        mode === "authenticated" ? 71 : null
      );
      const results = await Promise.allSettled([
        remove(responseId, ordinaryQuestionnaireId),
        mode === "authenticated"
          ? db.submitAuthenticatedAnswers(responseId, 71, [
              { questionId: 1, answerContent: "测试答案" },
            ])
          : db.savePublicAnswerSnapshot(
              responseId,
              identity(1).visitorToken,
              [{ responseId, answerContent: "测试答案" }],
              false
            ),
      ]);
      expect(results[0].status).toBe("fulfilled");
      expect(await count("responses", "id", responseId)).toBe(0);
      expect(await count("answers", "responseId", responseId)).toBe(0);
      expect(
        (await db.getOrCreateStats(ordinaryQuestionnaireId)).totalResponses
      ).toBe(0);
    }
  );
});
