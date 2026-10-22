export function summarizeResponses(
  responses: { status: string; totalScore?: string | number | null }[]
) {
  const totalResponses = responses.length;
  const completedResponses = responses.filter(
    response => response.status === "submitted" || response.status === "graded"
  ).length;
  const inProgressResponses = responses.filter(
    response => response.status === "in_progress"
  ).length;
  const scores = responses
    .filter(
      response => response.status === "graded" && response.totalScore != null
    )
    .map(response => Number(response.totalScore))
    .filter(Number.isFinite);

  return {
    totalResponses,
    completedResponses,
    inProgressResponses,
    completionRate: totalResponses
      ? (completedResponses / totalResponses) * 100
      : 0,
    averageScore: scores.length
      ? scores.reduce((total, score) => total + score, 0) / scores.length
      : null,
    highestScore: scores.length ? Math.max(...scores) : null,
    lowestScore: scores.length ? Math.min(...scores) : null,
  };
}
