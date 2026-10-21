import { z } from "zod";
import { isDimensionApplicable } from "./evaluationDimensions";

export function getScoreValues(
  min: number,
  max: number,
  step: number
): number[] {
  const values = [min, max, step];
  if (
    values.some(
      value =>
        !Number.isFinite(value) ||
        Math.abs(value * 100 - Math.round(value * 100)) > 1e-7
    )
  )
    return [];
  const minimum = Math.round(min * 100);
  const maximum = Math.round(max * 100);
  const increment = Math.round(step * 100);
  if (
    min < -999.99 ||
    max > 999.99 ||
    maximum <= minimum ||
    increment <= 0 ||
    (maximum - minimum) % increment !== 0
  )
    return [];
  const count = (maximum - minimum) / increment + 1;
  if (count > 101) return [];
  return Array.from(
    { length: count },
    (_, index) => (minimum + index * increment) / 100
  );
}

export const scoringConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("gsb") }).strict(),
  z
    .object({
      mode: z.literal("numeric"),
      min: z.number(),
      max: z.number(),
      step: z.number(),
      rules: z
        .array(
          z
            .object({
              score: z.number(),
              description: z
                .string()
                .trim()
                .min(1, "每个分值都必须填写判定规则")
                .max(2000),
            })
            .strict()
        )
        .min(2)
        .max(101),
    })
    .strict()
    .superRefine((config, context) => {
      const values = getScoreValues(config.min, config.max, config.step);
      if (!values.length)
        context.addIssue({
          code: "custom",
          message:
            "分值须在 -999.99～999.99 内、最多两位小数，步长须整除区间，且包含 2～101 个分值",
        });
      if (
        config.rules.length !== values.length ||
        new Set(config.rules.map(rule => rule.score)).size !== values.length ||
        config.rules.some(rule => !values.includes(rule.score))
      ) {
        context.addIssue({
          code: "custom",
          message: "必须为区间内每个分值填写唯一的判定规则",
        });
      }
    }),
  z
    .object({
      mode: z.literal("text"),
      prompt: z.string().trim().min(1).max(2000),
      required: z.boolean(),
    })
    .strict(),
]);

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;
export type NumericScoringConfig = Extract<ScoringConfig, { mode: "numeric" }>;
export const audioEvaluationSchema = z
  .object({
    leftScore: z.number().optional(),
    rightScore: z.number().optional(),
    leftText: z.string().max(5000).optional(),
    rightText: z.string().max(5000).optional(),
  })
  .strict();
export type AudioEvaluation = z.infer<typeof audioEvaluationSchema>;
export type EvaluationAnswerValue = {
  blindTestChoice?: "left_better" | "same" | "right_better" | null;
  audioEvaluation?: AudioEvaluation | null;
};
export const evaluationAnswerSchema = z.object({
  questionId: z.number().int().positive().optional(),
  evaluationDimensionId: z.number().int().positive().optional(),
  blindTestPairId: z.number().int().positive().optional(),
  answerContent: z.string().optional(),
  blindTestChoice: z.enum(["left_better", "same", "right_better"]).optional(),
  audioEvaluation: audioEvaluationSchema.optional(),
});
export type EvaluationAnswerInput = z.infer<typeof evaluationAnswerSchema>;

export function getScoringConfig(dimension: {
  scoringConfig?: unknown;
}): ScoringConfig {
  return dimension.scoringConfig == null
    ? { mode: "gsb" }
    : scoringConfigSchema.parse(dimension.scoringConfig);
}

export function scoringAnswerError(
  dimension: { scoringConfig?: unknown },
  answer: EvaluationAnswerValue | undefined,
  complete: boolean
): string | undefined {
  const config = getScoringConfig(dimension);
  const value = answer?.audioEvaluation;
  if (config.mode === "gsb") {
    if (value != null) return "GSB 维度不能提交量化分值或文本";
    if (
      answer?.blindTestChoice &&
      !["left_better", "same", "right_better"].includes(answer.blindTestChoice)
    )
      return "无效的 GSB 选项";
    if (complete && !answer?.blindTestChoice) return "请选择 GSB 对比结果";
    return;
  }
  if (answer?.blindTestChoice != null) return "量化或文本维度不能提交 GSB 选项";
  if (value != null && !audioEvaluationSchema.safeParse(value).success)
    return "音频评分格式无效";
  if (config.mode === "numeric") {
    if (value?.leftText !== undefined || value?.rightText !== undefined)
      return "量化维度不能提交文本答案";
    const values = getScoreValues(config.min, config.max, config.step);
    if (
      [value?.leftScore, value?.rightScore].some(
        score => score !== undefined && !values.includes(score)
      )
    )
      return "评分不在配置的可选分值中";
    if (
      complete &&
      (value?.leftScore === undefined || value?.rightScore === undefined)
    )
      return "请分别给音频 A、B 打分";
  } else {
    if (value?.leftScore !== undefined || value?.rightScore !== undefined)
      return "文本维度不能提交分值";
    if (
      complete &&
      config.required &&
      (!value?.leftText?.trim() || !value?.rightText?.trim())
    )
      return "请分别填写音频 A、B 的观察";
  }
}

export function isScoringAnswerComplete(
  dimension: { scoringConfig?: unknown },
  answer?: EvaluationAnswerValue
): boolean {
  return scoringAnswerError(dimension, answer, true) === undefined;
}

export function evaluationAnswersError(
  dimensions: ({ id: number; scoringConfig?: unknown } & Parameters<
    typeof isDimensionApplicable
  >[0])[],
  pairs: { id: number; groupLabel: string }[],
  answers: EvaluationAnswerInput[],
  submit: boolean
): string | undefined {
  const allowed = new Map<string, (typeof dimensions)[number]>(
    pairs.flatMap(pair =>
      dimensions
        .filter(dimension => isDimensionApplicable(dimension, pair.groupLabel))
        .map(dimension => [`${pair.id}:${dimension.id}`, dimension] as const)
    )
  );
  const seen = new Map<string, EvaluationAnswerInput>();
  for (const answer of answers) {
    const key = `${answer.blindTestPairId}:${answer.evaluationDimensionId}`;
    const dimension = allowed.get(key);
    if (
      !dimension ||
      answer.questionId != null ||
      answer.answerContent != null ||
      seen.has(key)
    )
      return "答案包含未分配的题目、无效维度或重复评分";
    const error = scoringAnswerError(dimension, answer, submit);
    if (error) return error;
    seen.set(key, answer);
  }
  if (submit) {
    for (const [key, dimension] of Array.from(allowed)) {
      const error = scoringAnswerError(dimension, seen.get(key), true);
      if (error) return `答卷不完整：${error}`;
    }
  }
}

export function formatAudioEvaluation(value?: AudioEvaluation | null): string {
  if (!value) return "";
  if (value.leftScore !== undefined || value.rightScore !== undefined)
    return `音频 A：${value.leftScore ?? "未评分"} 分；音频 B：${value.rightScore ?? "未评分"} 分`;
  return `音频 A：${value.leftText || "未填写"}\n音频 B：${value.rightText || "未填写"}`;
}
