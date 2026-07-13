import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from "recharts";
import { ArrowLeft, Loader2, TrendingUp, BarChart3 } from "lucide-react";

// 置信度徽标:根据显著性与置信度着色
function ConfidenceBadge({ significant, confidence }: { significant: boolean; confidence: number }) {
  const pct = (confidence * 100).toFixed(1);
  if (significant) {
    return (
      <span className="px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-700">
        显著（置信度 {pct}%）
      </span>
    );
  }
  return (
    <span className="px-2 py-1 rounded text-xs font-medium bg-slate-100 text-slate-600">
      不显著（置信度 {pct}%）
    </span>
  );
}

export default function MultiQuestionnaireAnalytics() {
  const [, setLocation] = useLocation();
  // 选中的问卷 id(参与聚合)
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const { data: questionnaires, isLoading: isLoadingList } =
    trpc.questionnaire.listAdmin.useQuery();

  const { data, isLoading, isFetching } = trpc.stats.aggregateMulti.useQuery(
    { questionnaireIds: selectedIds },
    { enabled: selectedIds.length > 0 }
  );

  const toggle = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const list = questionnaires || [];
  const allSelected = list.length > 0 && selectedIds.length === list.length;
  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : list.map((q: any) => q.id));
  };

  const comparisons = data?.comparisons || [];
  const chartData = comparisons.map((c) => ({
    label: `${c.dimensionName}｜${c.modelA} vs ${c.modelB}`,
    gsb: Number((c.gsbScore * 100).toFixed(1)),
    winner: c.winner,
    significant: c.significant,
  }));

  return (
    <div className="min-h-screen bg-slate-50 p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">跨问卷聚合分析</h1>
            <p className="text-slate-600 mt-2">选中多个问卷进行合并统计（按模型对比 × 维度名跨问卷聚合）</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setLocation("/admin/dashboard")}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回
          </Button>
        </div>

        {/* 问卷多选 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5" />
              选择参与聚合的问卷
            </CardTitle>
            <CardDescription>已选 {selectedIds.length} 个问卷</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingList ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : list.length === 0 ? (
              <p className="text-slate-500 text-sm py-4">暂无问卷</p>
            ) : (
              <div className="space-y-2">
                <label className="flex items-center gap-2 pb-2 border-b border-slate-100 cursor-pointer">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                  <span className="text-sm font-medium text-slate-700">全选 / 取消全选</span>
                </label>
                {list.map((q: any) => (
                  <label
                    key={q.id}
                    className="flex items-center gap-2 py-1 cursor-pointer hover:bg-slate-50 rounded px-1"
                  >
                    <Checkbox
                      checked={selectedIds.includes(q.id)}
                      onCheckedChange={() => toggle(q.id)}
                    />
                    <span className="text-sm text-slate-800">{q.title}</span>
                    <span className="text-xs text-slate-400">
                      {q.status === "published" ? "已发布" : q.status === "draft" ? "草稿" : q.status}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {selectedIds.length === 0 ? (
          <Card>
            <CardContent className="pt-12 text-center">
              <p className="text-slate-600">请先勾选至少一个问卷以查看聚合结果</p>
            </CardContent>
          </Card>
        ) : isLoading || isFetching ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin" />
          </div>
        ) : comparisons.length === 0 ? (
          <Card>
            <CardContent className="pt-12 text-center">
              <p className="text-slate-600">选中的问卷暂无可分析的盲测数据</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              共聚合 {data?.totalResponses || 0} 份答卷、{data?.totalJudgments || 0} 次两两对比判断，
              涵盖 {data?.includedQuestionnaires?.length || 0} 个问卷
            </p>

            {/* GSB 净胜分图 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="w-5 h-5" />
                  GSB 净胜分（(胜-负)/总，正值表示前者更优）
                </CardTitle>
                <CardDescription>按 维度 × 模型对比 跨问卷合并展示，绿色为统计显著的对比</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={Math.max(240, chartData.length * 48)}>
                  <BarChart data={chartData} layout="vertical" margin={{ left: 40, right: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" domain={[-100, 100]} unit="%" />
                    <YAxis type="category" dataKey="label" width={220} tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v: any) => [`${v}%`, "GSB 净胜分"]} />
                    <ReferenceLine x={0} stroke="#94a3b8" />
                    <Bar dataKey="gsb">
                      {chartData.map((entry, index) => (
                        <Cell key={index} fill={entry.significant ? "#10b981" : "#94a3b8"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* 详细统计表 */}
            <Card>
              <CardHeader>
                <CardTitle>详细对比统计</CardTitle>
                <CardDescription>
                  胜率与置信度基于双侧二项检验（H0：两模型无差异），Wilson 区间为前者胜出比例的 95% 置信区间
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>维度</TableHead>
                      <TableHead>模型对比</TableHead>
                      <TableHead className="text-center">胜 / 平 / 负</TableHead>
                      <TableHead className="text-center">胜率</TableHead>
                      <TableHead className="text-center">GSB</TableHead>
                      <TableHead className="text-center">95% 区间</TableHead>
                      <TableHead>结论</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {comparisons.map((c, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium">{c.dimensionName}</TableCell>
                        <TableCell className="text-sm">
                          <span className="font-medium">{c.modelA}</span>
                          <span className="text-slate-400"> vs </span>
                          <span className="font-medium">{c.modelB}</span>
                        </TableCell>
                        <TableCell className="text-center text-sm">
                          {c.aWins} / {c.ties} / {c.bWins}
                        </TableCell>
                        <TableCell className="text-center text-sm">
                          {(c.aWinRate * 100).toFixed(1)}%
                        </TableCell>
                        <TableCell className="text-center text-sm font-medium">
                          {c.gsbScore > 0 ? "+" : ""}{(c.gsbScore * 100).toFixed(1)}%
                        </TableCell>
                        <TableCell className="text-center text-xs text-slate-500">
                          [{(c.wilsonLower * 100).toFixed(0)}%, {(c.wilsonUpper * 100).toFixed(0)}%]
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {c.winner ? (
                              <div className="text-sm font-medium text-green-700">{c.winner} 更优</div>
                            ) : (
                              <div className="text-sm text-slate-500">无显著差异</div>
                           )}
                            <ConfidenceBadge significant={c.significant} confidence={c.confidenceLevel} />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}