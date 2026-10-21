import { describe, expect, it } from "vitest";
import {
  audioEvaluationSchema,
  evaluationAnswersError,
  formatAudioEvaluation,
  getScoreValues,
  getScoringConfig,
  isScoringAnswerComplete,
  scoringAnswerError,
  scoringConfigSchema,
  type ScoringConfig,
} from "../shared/scoring";
import { aggregateAudioEvaluations } from "../shared/scoringAnalytics";

const numeric: ScoringConfig = {
  mode: "numeric",
  min: 0,
  max: 1,
  step: 0.5,
  rules: [
    { score: 0, description: "不符合" },
    { score: 0.5, description: "基本符合" },
    { score: 1, description: "完全符合" },
  ],
};
const dimension = { id: 1, dimensionName: "自然度", scoringConfig: numeric };
const textDimension = {
  id: 2,
  dimensionName: "其他",
  scoringConfig: { mode: "text", prompt: "请记录观察", required: false },
};
const value = { audioEvaluation: { leftScore: 0, rightScore: 1 } };

describe("量化分值和每档判定规则", () => {
  it("旧配置默认 GSB，零分和小数按步长精确枚举", () => {
    expect(getScoringConfig({})).toEqual({ mode: "gsb" });
    expect(getScoringConfig({ scoringConfig: null })).toEqual({ mode: "gsb" });
    expect(getScoreValues(-0.1, 0.2, 0.1)).toEqual([-0.1, 0, 0.1, 0.2]);
    expect(scoringConfigSchema.parse(numeric)).toEqual(numeric);
  });
  it.each([
    [1, 1, 1],
    [1, 0, 1],
    [0, 1, 0],
    [0, 1, -1],
    [0, 1, 0.3],
    [0, 1000, 1],
    [0, 1000, 10],
    [0, 1, 0.001],
    [-1001, 1, 1],
    [0, Infinity, 1],
    [NaN, 1, 1],
  ])("拒绝无效范围 %j", (min, max, step) => {
    expect(getScoreValues(min, max, step)).toEqual([]);
  });
  it.each([
    { ...numeric, rules: [] },
    { ...numeric, rules: numeric.rules.slice(0, 2) },
    { ...numeric, rules: numeric.rules.map(rule => ({ ...rule, score: 0 })) },
    {
      ...numeric,
      rules: numeric.rules.map(rule => ({ ...rule, description: " " })),
    },
    {
      ...numeric,
      rules: [...numeric.rules.slice(0, 2), { score: 2, description: "越界" }],
    },
    { mode: "text", prompt: " ", required: false },
    { mode: "unknown" },
  ])("缺规则、重复档位、空文本引导或未知模式不可保存", config => {
    expect(scoringConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("每个音频独立评分及文本", () => {
  it("零分有效、允许同分、必须两侧完成；部分评分可暂存", () => {
    expect(isScoringAnswerComplete(dimension, value)).toBe(true);
    expect(
      isScoringAnswerComplete(dimension, {
        audioEvaluation: { leftScore: 0, rightScore: 0 },
      })
    ).toBe(true);
    expect(
      isScoringAnswerComplete(dimension, { audioEvaluation: { leftScore: 0 } })
    ).toBe(false);
    expect(
      scoringAnswerError(
        dimension,
        { audioEvaluation: { leftScore: 0 } },
        false
      )
    ).toBeUndefined();
    expect(formatAudioEvaluation(value.audioEvaluation)).toContain(
      "音频 A：0 分"
    );
  });
  it.each([-1, 0.1, 2, Infinity, NaN])("拒绝不属于分值集合的 %s", leftScore => {
    expect(
      scoringAnswerError(
        dimension,
        { audioEvaluation: { leftScore, rightScore: 1 } },
        false
      )
    ).toBeTruthy();
  });
  it("拒绝混合评分类型以及额外数据字段", () => {
    expect(
      scoringAnswerError(dimension, { ...value, blindTestChoice: "same" }, true)
    ).toBeTruthy();
    expect(
      scoringAnswerError(
        dimension,
        { audioEvaluation: { leftText: "错误" } },
        false
      )
    ).toBeTruthy();
    expect(scoringAnswerError({}, value, false)).toBeTruthy();
    expect(scoringAnswerError(textDimension, value, false)).toBeTruthy();
    expect(
      audioEvaluationSchema.safeParse({
        leftScore: 1,
        modelName: "私自填入模型",
      }).success
    ).toBe(false);
  });
  it("其他默认选填，必填时两侧均不可空白；限制每侧长度", () => {
    expect(isScoringAnswerComplete(textDimension)).toBe(true);
    const required = {
      scoringConfig: { ...textDimension.scoringConfig, required: true },
    };
    expect(
      isScoringAnswerComplete(required, {
        audioEvaluation: { leftText: "好", rightText: " " },
      })
    ).toBe(false);
    expect(
      isScoringAnswerComplete(required, {
        audioEvaluation: { leftText: "好", rightText: "停顿长" },
      })
    ).toBe(true);
    expect(
      scoringAnswerError(
        textDimension,
        { audioEvaluation: { leftText: "字".repeat(5001) } },
        false
      )
    ).toBeTruthy();
  });
});

describe("作答范围和完整性", () => {
  const pairs = [{ id: 10, groupLabel: "开心组" }];
  const answer = { ...value, blindTestPairId: 10, evaluationDimensionId: 1 };
  it("同时兼容量化、GSB、选填文本及情绪分组", () => {
    const dimensions = [
      dimension,
      textDimension,
      {
        id: 3,
        dimensionType: "emotion_accuracy",
        emotionCategories: [{ name: "悲伤", groupLabels: ["悲伤组"] }],
      },
      { id: 4 },
    ];
    expect(
      evaluationAnswersError(
        dimensions,
        pairs,
        [
          answer,
          {
            blindTestPairId: 10,
            evaluationDimensionId: 4,
            blindTestChoice: "same",
          },
        ],
        true
      )
    ).toBeUndefined();
    expect(evaluationAnswersError(dimensions, pairs, [answer], true)).toContain(
      "答卷不完整"
    );
  });
  it("拒绝跨组、跨维度、重复评分和普通问答字段混入", () => {
    for (const answers of [
      [{ ...answer, blindTestPairId: 11 }],
      [{ ...answer, evaluationDimensionId: 9 }],
      [answer, answer],
      [{ ...answer, answerContent: "伪造" }],
    ]) {
      expect(
        evaluationAnswersError([dimension], pairs, answers, false)
      ).toBeTruthy();
    }
  });
  it("缺任何必需评分都拒绝，但不要求未分配的配对", () => {
    expect(evaluationAnswersError([dimension], pairs, [], true)).toContain(
      "答卷不完整"
    );
    expect(
      evaluationAnswersError([dimension], pairs, [answer], true)
    ).toBeUndefined();
  });
});

describe("量化统计不污染 GSB，音频左右正确映射模型", () => {
  it("反转左右后仍按实际模型统计；不纳入不完整或无效分值", () => {
    const pairs = new Map([
      [10, { left: "模型A", right: "模型B" }],
      [11, { left: "模型B", right: "模型A" }],
    ]);
    const result = aggregateAudioEvaluations(
      [dimension, textDimension, { id: 3, dimensionName: "音质" }],
      pairs,
      [
        { ...value, blindTestPairId: 10, evaluationDimensionId: 1 },
        {
          audioEvaluation: { leftScore: 0.5, rightScore: 0 },
          blindTestPairId: 11,
          evaluationDimensionId: 1,
        },
        {
          audioEvaluation: { leftText: "停顿长", rightText: " " },
          blindTestPairId: 10,
          evaluationDimensionId: 2,
        },
        {
          blindTestChoice: "same",
          blindTestPairId: 10,
          evaluationDimensionId: 3,
        },
        {
          audioEvaluation: { leftScore: 99 },
          blindTestPairId: 10,
          evaluationDimensionId: 1,
        },
      ]
    );
    expect(result.numericSummaries).toEqual([
      expect.objectContaining({
        modelName: "模型A",
        count: 2,
        mean: 0,
        min: 0,
        max: 0,
      }),
      expect.objectContaining({
        modelName: "模型B",
        count: 2,
        mean: 0.75,
        min: 0.5,
        max: 1,
      }),
    ]);
    expect(result.numericScoreCount).toBe(4);
    expect(result.textCommentCount).toBe(1);
  });
});
