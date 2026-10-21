import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { aggregateAudioEvaluations } from "@shared/scoringAnalytics";

export function NumericScoringSummary({
  numericSummaries = [],
  textCommentCount = 0,
}: Partial<ReturnType<typeof aggregateAudioEvaluations>>) {
  if (!numericSummaries.length && !textCommentCount) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>量化评分与文本反馈</CardTitle>
        <CardDescription>
          按维度和实际模型汇总单音频评分，不混入
          GSB。不同量表不合并；同一音频多次评分分别计数。已有 {textCommentCount}{" "}
          条音频观察，可在答卷详情导出。
        </CardDescription>
      </CardHeader>
      {!!numericSummaries.length && (
        <CardContent className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  "维度",
                  "模型",
                  "量表",
                  "评分次数",
                  "平均分",
                  "最低分",
                  "最高分",
                ].map(label => (
                  <th key={label} className="whitespace-nowrap border-b p-3">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {numericSummaries.map(summary => (
                <tr key={`${summary.dimensionId}:${summary.modelName}`}>
                  <td className="p-3">{summary.dimensionName}</td>
                  <td className="p-3">{summary.modelName}</td>
                  <td className="p-3">
                    {summary.rangeMin}～{summary.rangeMax}
                  </td>
                  <td className="p-3">{summary.count}</td>
                  <td className="p-3 font-medium">{summary.mean.toFixed(2)}</td>
                  <td className="p-3">{summary.min}</td>
                  <td className="p-3">{summary.max}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      )}
    </Card>
  );
}
