import { useParams, useLocation } from "wouter";
import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from "recharts";
import { ArrowLeft, Loader2, TrendingUp, Filter } from "lucide-react";

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

export default function QuestionnaireAnalytics() {
  const { id } = useParams();
  const [, setLocation] = useLocation();
  const questionnaireId = parseInt(id || "0");

  // 正向选中的答卷(测评人)ID 集合,只有选中的答卷才参与聚合分析。
  // null 表示"尚未初始化"(数据到达后自动全选);空数组表示"全不选"。
  const [selectedIds, setSelectedIds] = useState<number[] | null>(null);

  // 后端语义:includeResponseIds 为空/undefined => 全选。
  // 故:未初始化(null) 或 已全选时传 undefined;部分选中传选中 id;全不选传 [-1](必不匹配,得到空结果)。
  const { data, isLoading } = trpc.stats.aggregate.useQuery(
    {
      questionnaireId,
      includeResponseIds:
        selectedIds === null
          ? undefined
          : selectedIds.length === 0
            ? [-1]
            : selectedIds,
    },
    { enabled: !!questionnaireId }
  );

  const responseSamples = data?.responseSamples || [];

  // 数据首次到达时,默认全选所有答卷
  useEffect(() => {
    if (selectedIds === null && responseSamples.length > 0) {
      setSelectedIds(responseSamples.map((r) => r.id));
    }
  }, [selectedIds, responseSamples]);

  const toggleResponse = (rid: number) => {
    setSelectedIds((prev) => {
      const base = prev ?? responseSamples.map((r) => r.id);
      return base.includes(rid) ? base.filter((x) => x !== rid) : [...base, rid];
    });
  };

  const allSelected =
    responseSamples.length > 0 &&
    (selectedIds === null || selectedIds.length === responseSamples.length);

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(responseSamples.map((r) => r.id));
    }
  };

  const selectedCount =
    selectedIds === null ? responseSamples.length : selectedIds.length;

  if (isLoading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  const comparisons = data?.comparisons || [];

  // 样本筛选面板:以测评人(每份提交的答卷)为一份样本,勾选=纳入分析(正向选中),默认全选
  const isSelected = (rid: number) =>
    selectedIds === null ? true : selectedIds.includes(rid);

  const filterPanel = responseSamples.length > 0 && (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Filter className="w-5 h-5" />
            样本筛选（选中要纳入分析的测评人）
          </CardTitle>
          <Button variant="outline" size="sm" onClick={toggleSelectAll}>
            {allSelected ? "取消全选" : "全选"}
          </Button>
        </div>
        <CardDescription>
          每份提交的问卷为一份样本（按测评人）。勾选表示纳入下方聚合统计。当前已选中 {selectedCount} / {responseSamples.length} 份。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {responseSamples.map((r) => (
            <label
              key={r.id}
              className="flex items-start gap-2 p-2 rounded border border-slate-200 hover:bg-slate-50 cursor-pointer"
            >
              <Checkbox
                checked={isSelected(r.id)}
                onCheckedChange={() => toggleResponse(r.id)}
              />
              <span className="text-sm text-slate-700">
                {r.visitorName}
                <br />
                <span className="text-xs text-slate-500">
                  {r.judgmentCount} 次判断
                  {r.submittedAt ? `｜${new Date(r.submittedAt).toLocaleString()}` : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  );

  if (comparisons.length === 0) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="max-w-5xl mx-auto space-y-4">
          <Button variant="ghost" size="sm" onClick={() => setLocation(`/admin/questionnaire/${questionnaireId}`)}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回问卷
          </Button>
          {filterPanel}
          <Card>
            <CardContent className="pt-12 text-center">
              <p className="text-slate-600">暂无可分析的盲测数据（需要有人完成答卷后才能生成对比结论，或当前所选样本无有效判断）</p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // GSB 图表数据:每个"维度 - 模型对比"一条,gsbScore>0 表示 modelA 更优
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
            <h1 className="text-3xl font-bold text-slate-900">盲测聚合分析报告</h1>
            <p className="text-slate-600 mt-2">
              共 {data?.totalResponses || 0} 份答卷、{data?.totalJudgments || 0} 次两两对比判断
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setLocation(`/admin/questionnaire/${questionnaireId}`)}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回问卷
          </Button>
        </div>

        {filterPanel}

        {/* GSB 净胜分图 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5" />
              GSB 净胜分（(胜-负)/总，正值表示前者更优）
            </CardTitle>
            <CardDescription>按 维度 × 模型对比 展示，绿色为统计显著的对比</CardDescription>
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
      </div>
    </div>
  );
}