import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql, { type Connection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { appRouter } from "./routers";
import * as db from "./db";
import type { TrpcContext } from "./_core/context";
import { isDimensionApplicable } from "../shared/evaluationDimensions";
import {
  getScoringConfig,
  type EvaluationAnswerInput,
  type NumericScoringConfig,
} from "../shared/scoring";

const testUrl = process.env.SCORING_TEST_DATABASE_URL;
const numeric: NumericScoringConfig = {
  mode: "numeric",
  min: 0,
  max: 1,
  step: 0.5,
  rules: [
    { score: 0, description: "未达到要求" },
    { score: 0.5, description: "基本符合" },
    { score: 1, description: "完全符合" },
  ],
};

describe.skipIf(!testUrl)("隔离 MySQL 量化评分全流程", () => {
  let connection: Connection;
  const ownerId = 51;
  const publicCaller = appRouter.createCaller({
    user: null,
    req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    res: {},
  } as TrpcContext);
  const admin = appRouter.createCaller({
    user: { id: ownerId, role: "admin" },
    req: { headers: {} },
    res: {},
  } as TrpcContext);
  const stranger = appRouter.createCaller({
    user: { id: 999, role: "admin" },
    req: { headers: {} },
    res: {},
  } as TrpcContext);
  const identity = (questionnaireId: number, name: string) => ({
    questionnaireId,
    visitorName: name,
    visitorToken: `scoring-test-browser-${name}`,
  });

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !/^\/scoring_test_[a-z0-9_]+$/.test(url.pathname)
    )
      throw new Error("只允许本地 scoring_test_ 前缀的隔离数据库");
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
      (entry: { idx: number }) => entry.idx < 12
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
      "INSERT INTO questionnaires (id,creatorId,title,status) VALUES (1,51,'历史 GSB','draft')"
    );
    await connection.execute(
      "INSERT INTO evaluationDimensions (id,questionnaireId,dimensionName,orderIndex) VALUES (1,1,'历史音质',0)"
    );
    await connection.execute(
      "INSERT INTO responses (id,questionnaireId,visitorName,status) VALUES (1,1,'历史答卷','submitted')"
    );
    await connection.execute(
      "INSERT INTO answers (id,responseId,evaluationDimensionId,blindTestChoice) VALUES (1,1,1,'same')"
    );
    const run = (mode: string) =>
      spawnSync(process.execPath, ["scripts/apply-0012-migration.mjs", mode], {
        env: { ...process.env, DATABASE_URL: testUrl! },
        encoding: "utf8",
      });
    expect(run("--check").status).toBe(2);
    for (const mode of ["--apply", "--apply", "--check"]) {
      const result = run(mode);
      expect(result.status, result.stderr).toBe(0);
    }
    vi.stubEnv("DATABASE_URL", testUrl!);
  }, 30000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (connection) await connection.end();
  });

  async function fixture(subQuestionnaire: boolean, sampled = false) {
    const { questionnaireId } = await admin.audio.createQuestionnaire({
      title: subQuestionnaire ? "量化子问卷验证" : "量化整卷验证",
      evaluationCopywriting: "分别评价两个音频，每档分值有判定规则。",
    });
    const audioIds: number[] = [];
    for (let index = 0; index < 4; index++) {
      const [result] = await connection.execute<mysql.ResultSetHeader>(
        "INSERT INTO audioFiles (uploaderId,fileName,fileKey,fileUrl,mimeType,fileSizeBytes,modelName,questionnaireId,groupLabel) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          ownerId,
          `原始_音频_${index}.wav`,
          `scoring/${questionnaireId}/${index}.wav`,
          `/test-audio-${index}.wav`,
          "audio/wav",
          0,
          index % 2 ? "模型B" : "模型A",
          questionnaireId,
          index < 2 ? "开心组" : "中性组",
        ]
      );
      audioIds.push(result.insertId);
    }
    await db.createBlindTestPairs([
      {
        questionnaireId,
        leftAudioFileId: audioIds[0],
        rightAudioFileId: audioIds[1],
        pairIndex: 0,
      },
      {
        questionnaireId,
        leftAudioFileId: audioIds[3],
        rightAudioFileId: audioIds[2],
        pairIndex: 1,
      },
    ]);
    const defaults = await admin.dimension.list({ questionnaireId });
    await admin.dimension.update({
      id: defaults[0].id,
      dimensionName: "自然度",
      scoringConfig: numeric,
    });
    await admin.dimension.update({
      id: defaults[2].id,
      dimensionName: "情绪准确度",
      dimensionType: "emotion_accuracy",
      emotionCategories: [{ name: "开心", groupLabels: ["开心组"] }],
      scoringConfig: numeric,
    });
    await admin.dimension.create({
      questionnaireId,
      dimensionName: "其他",
      dimensionType: "other",
      orderIndex: 4,
      scoringConfig: { mode: "text", prompt: "记录观察", required: true },
    });
    if (subQuestionnaire)
      await admin.questionnaire.configureDistribution({
        questionnaireId,
        enabled: true,
        groupsPerForm: 1,
        quota: 2,
      });
    if (sampled)
      await admin.questionnaire.update({ id: questionnaireId, sampleSize: 1 });
    await admin.questionnaire.update({
      id: questionnaireId,
      status: "published",
    });
    const questionnaire = await db.getQuestionnaireById(questionnaireId);
    return {
      questionnaireId,
      shareToken: questionnaire!.shareToken!,
      dimensions: await admin.dimension.list({ questionnaireId }),
    };
  }

  async function start(
    test: Awaited<ReturnType<typeof fixture>>,
    name: string
  ) {
    const visitor = identity(test.questionnaireId, name);
    const response = await publicCaller.response.startPublic(visitor);
    const result = await publicCaller.questionnaire.getByShareToken({
      shareToken: test.shareToken,
      responseId: response.responseId,
      visitorToken: visitor.visitorToken,
    });
    const labels = response.sampledGroupLabels;
    const pairs = result.blindTestPairs.filter(
      pair => !labels || labels.includes(pair.groupLabel)
    );
    const answers: EvaluationAnswerInput[] = pairs.flatMap(pair =>
      test.dimensions
        .filter(dimension => isDimensionApplicable(dimension, pair.groupLabel))
        .map(dimension => {
          const config = getScoringConfig(dimension);
          return {
            blindTestPairId: pair.id,
            evaluationDimensionId: dimension.id,
            ...(config.mode === "gsb"
              ? { blindTestChoice: "same" as const }
              : {
                  audioEvaluation:
                    config.mode === "numeric"
                      ? { leftScore: 0, rightScore: 1 }
                      : { leftText: "句尾停顿较长", rightText: "语气自然" },
                }),
          };
        })
    );
    return {
      visitor,
      response,
      pairs,
      input: {
        responseId: response.responseId,
        visitorToken: visitor.visitorToken,
        answers,
      },
    };
  }

  it("增量迁移幂等且不改历史 GSB 数据", async () => {
    expect((await db.getEvaluationDimensionById(1))?.scoringConfig).toBeNull();
    expect((await db.getAnswersByResponse(1))[0]).toMatchObject({
      blindTestChoice: "same",
      audioEvaluation: null,
    });
  });

  it.each([false, true])(
    "维度排序只改展示顺序，公开页及副本保持一致，历史作答可续填（子问卷=%s）",
    async subQuestionnaire => {
      const test = await fixture(subQuestionnaire);
      const session = await start(test, `reorder-${subQuestionnaire}`);
      await publicCaller.response.saveProgressPublic(session.input);
      const savedAnswers = await db.getAnswersByResponse(
        session.response.responseId
      );
      const savedQuestionnaire = await db.getQuestionnaireById(
        test.questionnaireId
      );
      const expectedDimensionIds = test.dimensions.map(
        dimension => dimension.id
      );
      const orderedDimensionIds = [...expectedDimensionIds].reverse();
      await admin.dimension.reorder({
        questionnaireId: test.questionnaireId,
        expectedDimensionIds,
        orderedDimensionIds,
      });
      const reordered = await admin.dimension.list({
        questionnaireId: test.questionnaireId,
      });
      expect(reordered.map(dimension => dimension.id)).toEqual(
        orderedDimensionIds
      );
      expect(reordered.map(dimension => dimension.orderIndex)).toEqual([
        0, 1, 2, 3,
      ]);
      const unchangedFields = (dimensions: typeof reordered) =>
        dimensions
          .map(({ orderIndex, updatedAt, ...dimension }) => dimension)
          .sort((left, right) => left.id - right.id);
      expect(unchangedFields(reordered)).toEqual(
        unchangedFields(test.dimensions)
      );
      expect(await db.getQuestionnaireById(test.questionnaireId)).toEqual(
        savedQuestionnaire
      );
      expect(
        await db.getAnswersByResponse(session.response.responseId)
      ).toEqual(savedAnswers);
      const publicQuestionnaire =
        await publicCaller.questionnaire.getByShareToken({
          shareToken: test.shareToken,
          responseId: session.response.responseId,
          visitorToken: session.visitor.visitorToken,
        });
      expect(
        publicQuestionnaire.dimensions.map(dimension => dimension.id)
      ).toEqual(orderedDimensionIds);
      await publicCaller.response.submitPublic(session.input);
      const copied = await admin.questionnaire.duplicate({
        id: test.questionnaireId,
      });
      const copiedDimensions = await admin.dimension.list({
        questionnaireId: copied.questionnaireId,
      });
      expect(
        copiedDimensions.map(dimension => dimension.dimensionName)
      ).toEqual(reordered.map(dimension => dimension.dimensionName));
      expect(
        copiedDimensions.map(dimension => dimension.scoringConfig)
      ).toEqual(reordered.map(dimension => dimension.scoringConfig));
      const submittedAnswers = await db.getAnswersByResponse(
        session.response.responseId
      );
      await admin.dimension.reorder({
        questionnaireId: test.questionnaireId,
        expectedDimensionIds: orderedDimensionIds,
        orderedDimensionIds: expectedDimensionIds,
      });
      expect(
        await db.getAnswersByResponse(session.response.responseId)
      ).toEqual(submittedAnswers);
      await expect(
        admin.dimension.update({
          id: expectedDimensionIds[0],
          dimensionName: "不可修改规则",
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  );

  it("重复历史序号按 ID 稳定排序，重排后序号连续", async () => {
    const { questionnaireId } = await admin.audio.createQuestionnaire({
      title: "旧维度排序",
      evaluationCopywriting: "测试",
    });
    await connection.execute(
      "UPDATE evaluationDimensions SET orderIndex=9 WHERE questionnaireId=?",
      [questionnaireId]
    );
    const dimensions = await admin.dimension.list({ questionnaireId });
    const expectedDimensionIds = dimensions.map(dimension => dimension.id);
    expect(expectedDimensionIds).toEqual(
      [...expectedDimensionIds].sort((left, right) => left - right)
    );
    const orderedDimensionIds = [...expectedDimensionIds].reverse();
    await admin.dimension.reorder({
      questionnaireId,
      expectedDimensionIds,
      orderedDimensionIds,
    });
    expect(
      (await admin.dimension.list({ questionnaireId })).map(dimension => [
        dimension.id,
        dimension.orderIndex,
      ])
    ).toEqual(
      orderedDimensionIds.map((dimensionId, index) => [dimensionId, index])
    );
  });

  it("其他管理员、遗漏维度和跨问卷 ID 不能排序，全部保持原状", async () => {
    const test = await fixture(false);
    const foreign = await fixture(false);
    const expectedDimensionIds = test.dimensions.map(dimension => dimension.id);
    const input = {
      questionnaireId: test.questionnaireId,
      expectedDimensionIds,
      orderedDimensionIds: [...expectedDimensionIds].reverse(),
    };
    await expect(stranger.dimension.reorder(input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      admin.dimension.reorder({ ...input, questionnaireId: 2147483647 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const incomplete = expectedDimensionIds.slice(1);
    const crossQuestionnaire = [
      ...expectedDimensionIds.slice(1),
      foreign.dimensions[0].id,
    ];
    for (const ids of [incomplete, crossQuestionnaire]) {
      await expect(
        admin.dimension.reorder({
          ...input,
          expectedDimensionIds: ids,
          orderedDimensionIds: [...ids].reverse(),
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(
      await admin.dimension.list({ questionnaireId: test.questionnaireId })
    ).toEqual(test.dimensions);
    expect(
      await admin.dimension.list({ questionnaireId: foreign.questionnaireId })
    ).toEqual(foreign.dimensions);
  });

  it("保存期间新增维度或顺序已变更时拒绝过期列表", async () => {
    const { questionnaireId } = await admin.audio.createQuestionnaire({
      title: "并发新增维度",
      evaluationCopywriting: "测试",
    });
    const expectedDimensionIds = (
      await admin.dimension.list({ questionnaireId })
    ).map(dimension => dimension.id);
    await admin.dimension.create({
      questionnaireId,
      dimensionName: "新增维度",
      orderIndex: 10,
    });
    const before = await admin.dimension.list({ questionnaireId });
    await expect(
      admin.dimension.reorder({
        questionnaireId,
        expectedDimensionIds,
        orderedDimensionIds: [...expectedDimensionIds].reverse(),
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await admin.dimension.list({ questionnaireId })).toEqual(before);
    const currentIds = before.map(dimension => dimension.id);
    await admin.dimension.reorder({
      questionnaireId,
      expectedDimensionIds: currentIds,
      orderedDimensionIds: [...currentIds].reverse(),
    });
    await expect(
      admin.dimension.reorder({
        questionnaireId,
        expectedDimensionIds: currentIds,
        orderedDimensionIds: currentIds,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("两个并发排序只允许一个保存，不覆盖较新的顺序", async () => {
    const test = await fixture(false);
    const expectedDimensionIds = test.dimensions.map(dimension => dimension.id);
    const proposals = [
      [...expectedDimensionIds].reverse(),
      [...expectedDimensionIds.slice(1), expectedDimensionIds[0]],
    ];
    const results = await Promise.allSettled(
      proposals.map(orderedDimensionIds =>
        admin.dimension.reorder({
          questionnaireId: test.questionnaireId,
          expectedDimensionIds,
          orderedDimensionIds,
        })
      )
    );
    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(
      1
    );
    const failed = results.find(result => result.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason.code).toBe(
      "CONFLICT"
    );
    const winnerIndex = results.findIndex(
      result => result.status === "fulfilled"
    );
    expect(
      (
        await admin.dimension.list({ questionnaireId: test.questionnaireId })
      ).map(dimension => dimension.id)
    ).toEqual(proposals[winnerIndex]);
  });

  it("中途数据库错误回滚全部顺序", async () => {
    const test = await fixture(false);
    const expectedDimensionIds = test.dimensions.map(dimension => dimension.id);
    const orderedDimensionIds = [...expectedDimensionIds].reverse();
    await connection.query(
      `CREATE TRIGGER fail_dimension_reorder BEFORE UPDATE ON evaluationDimensions FOR EACH ROW BEGIN IF OLD.id = ${orderedDimensionIds[1]} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dimension reorder rollback test'; END IF; END`
    );
    try {
      await expect(
        admin.dimension.reorder({
          questionnaireId: test.questionnaireId,
          expectedDimensionIds,
          orderedDimensionIds,
        })
      ).rejects.toThrow();
      expect(
        await admin.dimension.list({ questionnaireId: test.questionnaireId })
      ).toEqual(test.dimensions);
    } finally {
      await connection.query("DROP TRIGGER IF EXISTS fail_dimension_reorder");
    }
  });

  it.each([false, true])(
    "整卷/子问卷：零分、部分保存、续答、完整提交和提交后保护（子问卷=%s）",
    async subQuestionnaire => {
      const test = await fixture(subQuestionnaire);
      const session = await start(test, subQuestionnaire ? "sub" : "whole");
      const { input } = session;
      const first = input.answers.find(
        answer => answer.audioEvaluation?.leftScore !== undefined
      )!;
      const partial = { ...first, audioEvaluation: { leftScore: 0 } };
      await publicCaller.response.saveProgressPublic({
        ...input,
        answers: [partial],
      });
      const resumed = await publicCaller.response.startPublic(session.visitor);
      expect(resumed.savedAnswers[0]).toMatchObject({
        audioEvaluation: { leftScore: 0 },
      });
      await expect(
        publicCaller.response.submitPublic({ ...input, answers: [partial] })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        publicCaller.response.saveProgressPublic({
          ...input,
          visitorToken: "wrong-browser-token",
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        publicCaller.response.submitPublic({
          ...input,
          answers: [...input.answers, first],
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        publicCaller.response.submitPublic({
          ...input,
          answers: input.answers.map(answer =>
            answer === first
              ? {
                  ...answer,
                  audioEvaluation: { leftScore: 0.1, rightScore: 1 },
                }
              : answer
          ),
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        publicCaller.response.submitPublic({
          ...input,
          answers: input.answers.map(answer =>
            answer.audioEvaluation?.leftText
              ? {
                  ...answer,
                  audioEvaluation: { leftText: " ", rightText: " " },
                }
              : answer
          ),
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await publicCaller.response.submitPublic(input);
      const saved = await db.getAnswersByResponse(input.responseId);
      expect(saved).toHaveLength(input.answers.length);
      expect(
        saved.find(
          answer => answer.evaluationDimensionId === first.evaluationDimensionId
        )
      ).toMatchObject({
        audioEvaluation: { leftScore: 0, rightScore: 1 },
        blindTestChoice: null,
      });
      expect(
        saved.some(
          answer => answer.audioEvaluation?.leftText === "句尾停顿较长"
        )
      ).toBe(true);
      await expect(
        publicCaller.response.saveProgressPublic({
          ...input,
          answers: [partial],
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        publicCaller.response.submitPublic(input)
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect((await db.getResponseById(input.responseId))?.status).toBe(
        "submitted"
      );
      const stats = await admin.stats.aggregate({
        questionnaireId: test.questionnaireId,
      });
      expect(stats.totalJudgments).toBe(session.pairs.length);
      expect(stats.numericScoreCount).toBe(
        input.answers.filter(
          answer => answer.audioEvaluation?.leftScore !== undefined
        ).length * 2
      );
      expect(stats.textCommentCount).toBe(session.pairs.length * 2);
      expect(stats.comparisons).toHaveLength(1);
      const details = await admin.response.listQuestionnaire({
        questionnaireId: test.questionnaireId,
      });
      expect(details.pairsInfo[0].leftFileName).toContain("原始_音频_");
      expect(
        details.responses.find(response => response.id === input.responseId)
          ?.answers
      ).toHaveLength(saved.length);
      const excluded = await admin.stats.aggregate({
        questionnaireId: test.questionnaireId,
        includeResponseIds: [-1],
      });
      expect(excluded.numericSummaries).toEqual([]);
      expect(excluded.textCommentCount).toBe(0);
      await admin.questionnaire.update({
        id: test.questionnaireId,
        status: "offline",
      });
      await expect(
        admin.dimension.update({
          id: test.dimensions[0].id,
          scoringConfig: { mode: "gsb" },
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        admin.dimension.delete({ id: test.dimensions[0].id })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const copied = await admin.questionnaire.duplicate({
        id: test.questionnaireId,
      });
      expect(
        (
          await admin.dimension.list({
            questionnaireId: copied.questionnaireId,
          })
        ).map(dimension => dimension.scoringConfig)
      ).toEqual(test.dimensions.map(dimension => dimension.scoringConfig));
    }
  );

  it("旧随机抽样模式兼容量化且拒绝未抽中题目", async () => {
    const test = await fixture(false, true);
    const session = await start(test, "sampled");
    expect(session.pairs).toHaveLength(1);
    const allPairs = await db.getBlindTestPairsByQuestionnaire(
      test.questionnaireId
    );
    const outside = allPairs.find(pair => pair.id !== session.pairs[0].id)!;
    await expect(
      publicCaller.response.saveProgressPublic({
        ...session.input,
        answers: [{ ...session.input.answers[0], blindTestPairId: outside.id }],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await publicCaller.response.submitPublic(session.input);
  });

  it("发布前校验完整规则与类型、发布后锁定；其他管理员不可修改", async () => {
    const { questionnaireId } = await admin.audio.createQuestionnaire({
      title: "配置校验",
      evaluationCopywriting: "测试",
    });
    const dimension = (await admin.dimension.list({ questionnaireId }))[0];
    await expect(
      admin.dimension.update({
        id: dimension.id,
        scoringConfig: { ...numeric, rules: [] },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      admin.dimension.update({ id: dimension.id, dimensionType: "other" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      stranger.dimension.update({ id: dimension.id, scoringConfig: numeric })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const boundary = await admin.dimension.create({
      questionnaireId,
      dimensionName: "边界量表",
      orderIndex: 10,
      scoringConfig: {
        mode: "numeric",
        min: -999.99,
        max: 999.99,
        step: 999.99,
        rules: [-999.99, 0, 999.99].map(score => ({
          score,
          description: `${score} 分的判定规则`,
        })),
      },
    });
    expect(
      (await db.getEvaluationDimensionById(boundary.dimensionId))?.maxScore
    ).toBe("999.99");
    await admin.dimension.update({ id: dimension.id, scoringConfig: numeric });
    await admin.questionnaire.update({
      id: questionnaireId,
      status: "published",
    });
    await expect(
      admin.dimension.update({
        id: dimension.id,
        scoringConfig: { mode: "gsb" },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      admin.dimension.create({
        questionnaireId,
        dimensionName: "新增",
        orderIndex: 9,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
