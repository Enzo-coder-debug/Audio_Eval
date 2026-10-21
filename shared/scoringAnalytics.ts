import {
  getScoringConfig,
  scoringAnswerError,
  type EvaluationAnswerValue,
} from "./scoring";

export function aggregateAudioEvaluations(
  dimensions: { id: number; dimensionName: string; scoringConfig?: unknown }[],
  pairs: Map<number, { left: string; right: string }>,
  answers: (EvaluationAnswerValue & {
    evaluationDimensionId?: number | null;
    blindTestPairId?: number | null;
  })[]
) {
  const dimensionsById = new Map(
    dimensions.map(dimension => [dimension.id, dimension])
  );
  const buckets = new Map<
    string,
    {
      dimensionId: number;
      dimensionName: string;
      modelName: string;
      rangeMin: number;
      rangeMax: number;
      scores: number[];
    }
  >();
  let textCommentCount = 0;
  for (const answer of answers) {
    const dimension = dimensionsById.get(answer.evaluationDimensionId ?? -1);
    const pair = pairs.get(answer.blindTestPairId ?? -1);
    if (!dimension || !pair || scoringAnswerError(dimension, answer, true))
      continue;
    const config = getScoringConfig(dimension);
    if (config.mode === "text") {
      textCommentCount += [
        answer.audioEvaluation?.leftText,
        answer.audioEvaluation?.rightText,
      ].filter(text => text?.trim()).length;
    }
    if (config.mode !== "numeric") continue;
    for (const side of ["left", "right"] as const) {
      const score =
        side === "left"
          ? answer.audioEvaluation?.leftScore
          : answer.audioEvaluation?.rightScore;
      if (score === undefined) continue;
      const key = JSON.stringify([dimension.id, pair[side]]);
      const bucket = buckets.get(key) ?? {
        dimensionId: dimension.id,
        dimensionName: dimension.dimensionName,
        modelName: pair[side],
        rangeMin: config.min,
        rangeMax: config.max,
        scores: [],
      };
      bucket.scores.push(score);
      buckets.set(key, bucket);
    }
  }
  const numericSummaries = Array.from(buckets.values())
    .map(({ scores, ...bucket }) => ({
      ...bucket,
      count: scores.length,
      mean: scores.reduce((total, score) => total + score, 0) / scores.length,
      min: scores.reduce(
        (minimum, score) => Math.min(minimum, score),
        Infinity
      ),
      max: scores.reduce(
        (maximum, score) => Math.max(maximum, score),
        -Infinity
      ),
    }))
    .sort(
      (first, second) =>
        first.dimensionId - second.dimensionId ||
        first.modelName.localeCompare(second.modelName)
    );
  return {
    numericSummaries,
    textCommentCount,
    numericScoreCount: numericSummaries.reduce(
      (total, summary) => total + summary.count,
      0
    ),
  };
}
