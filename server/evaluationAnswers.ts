import { TRPCError } from "@trpc/server";
import {
  evaluationAnswersError,
  type EvaluationAnswerInput,
} from "../shared/scoring";
import * as db from "./db";

export async function validatePublicEvaluationAnswers(
  response: { questionnaireId: number | null; sampledGroupLabels?: unknown },
  answers: EvaluationAnswerInput[],
  submit: boolean
) {
  if (!response.questionnaireId) return;
  const pairs = await db.getBlindTestPairsByQuestionnaire(
    response.questionnaireId
  );
  if (!pairs.length) {
    if (
      answers.some(
        answer =>
          answer.blindTestPairId != null ||
          answer.evaluationDimensionId != null ||
          answer.audioEvaluation != null
      )
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "问卷没有可评分的音频配对",
      });
    return;
  }
  const dimensions = await db.getEvaluationDimensionsByQuestionnaire(
    response.questionnaireId
  );
  let sampled: string[] | null = null;
  if (response.sampledGroupLabels) {
    const parsed =
      typeof response.sampledGroupLabels === "string"
        ? JSON.parse(response.sampledGroupLabels)
        : response.sampledGroupLabels;
    if (
      !Array.isArray(parsed) ||
      parsed.some(label => typeof label !== "string")
    )
      throw new TRPCError({ code: "CONFLICT", message: "问卷分组数据异常" });
    sampled = parsed;
  }
  const labeledPairs = await Promise.all(
    pairs.map(async pair => {
      const [left, right] = await Promise.all([
        db.getAudioFileById(pair.leftAudioFileId),
        db.getAudioFileById(pair.rightAudioFileId),
      ]);
      return {
        id: pair.id,
        groupLabel: (left?.groupLabel || right?.groupLabel || "").trim(),
      };
    })
  );
  const error = evaluationAnswersError(
    dimensions,
    labeledPairs.filter(pair => !sampled || sampled.includes(pair.groupLabel)),
    answers,
    submit
  );
  if (error) throw new TRPCError({ code: "BAD_REQUEST", message: error });
}
