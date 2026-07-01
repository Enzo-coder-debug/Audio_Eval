import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { Loader2 } from "lucide-react";

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

export default function QuestionnaireAnalytics() {
  const { id } = useParams();
  const questionnaireId = parseInt(id || "0");

  const { data: responsesData, isLoading } = trpc.response.listQuestionnaire.useQuery(
    { questionnaireId },
    { enabled: !!questionnaireId }
  );
  const responses = responsesData?.responses;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  if (!responses || responses.length === 0) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <Card>
          <CardContent className="pt-12 text-center">
            <p className="text-slate-600">暂无答题数据</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Calculate score distribution
  const scoreDistribution: Record<string, number> = {
    "0-20": 0,
    "21-40": 0,
    "41-60": 0,
    "61-80": 0,
    "81-100": 0,
  };

  responses.forEach((r) => {
    if (r.totalScore !== null) {
      const score = Number(r.totalScore);
      if (score <= 20) scoreDistribution["0-20"]++;
      else if (score <= 40) scoreDistribution["21-40"]++;
      else if (score <= 60) scoreDistribution["41-60"]++;
      else if (score <= 80) scoreDistribution["61-80"]++;
      else scoreDistribution["81-100"]++;
    }
  });

  const scoreDistributionData = Object.entries(scoreDistribution).map(([range, count]) => ({
    range,
    count,
  }));

  // Calculate statistics
  const gradedResponses = responses.filter((r) => r.status === "graded");
  const scores = gradedResponses
    .map((r) => (r.totalScore !== null ? Number(r.totalScore) : 0))
    .filter((s) => s > 0);

  const avgScore = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2) : "N/A";
  const maxScore = scores.length > 0 ? Math.max(...scores).toFixed(2) : "N/A";
  const minScore = scores.length > 0 ? Math.min(...scores).toFixed(2) : "N/A";

  // Collect subjective answers
  const subjectiveAnswers: string[] = [];
  responses.forEach((r) => {
    // In a real app, you'd fetch the answers separately
    // For now, we'll just show the count
  });

  return (
    <div className="min-h-screen bg-slate-50 p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">问卷分析报告</h1>
          <p className="text-slate-600 mt-2">共有 {responses.length} 份答卷</p>
        </div>

        {/* Statistics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">总答卷数</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{responses.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">已评分</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{gradedResponses.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">平均分</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{avgScore}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">完成率</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {((gradedResponses.length / responses.length) * 100).toFixed(0)}%
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Charts */}
        <Tabs defaultValue="distribution" className="space-y-4">
          <TabsList>
            <TabsTrigger value="distribution">得分分布</TabsTrigger>
            <TabsTrigger value="details">答卷详情</TabsTrigger>
          </TabsList>

          <TabsContent value="distribution">
            <Card>
              <CardHeader>
                <CardTitle>得分分布统计</CardTitle>
                <CardDescription>显示各分数段的答卷数量</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={scoreDistributionData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="range" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="count" fill="#3b82f6" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="details">
            <Card>
              <CardHeader>
                <CardTitle>答卷详情</CardTitle>
                <CardDescription>所有答卷的详细信息</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 px-4">访客名称</th>
                        <th className="text-left py-2 px-4">访客 IP</th>
                        <th className="text-left py-2 px-4">得分</th>
                        <th className="text-left py-2 px-4">状态</th>
                        <th className="text-left py-2 px-4">提交时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {responses.map((r) => (
                        <tr key={r.id} className="border-b hover:bg-slate-50">
                          <td className="py-2 px-4">{r.visitorName || "匿名"}</td>
                          <td className="py-2 px-4 font-mono text-xs">{r.visitorIp}</td>
                          <td className="py-2 px-4 font-semibold">
                            {r.totalScore !== null ? Number(r.totalScore).toFixed(2) : "-"}
                          </td>
                          <td className="py-2 px-4">
                            <span className={`px-2 py-1 rounded text-xs font-medium ${
                              r.status === "graded"
                                ? "bg-green-100 text-green-700"
                                : r.status === "submitted"
                                ? "bg-blue-100 text-blue-700"
                                : "bg-slate-100 text-slate-700"
                            }`}>
                              {r.status === "graded" ? "已评分" : r.status === "submitted" ? "待评分" : "进行中"}
                            </span>
                          </td>
                          <td className="py-2 px-4 text-xs text-slate-600">
                            {r.submittedAt ? new Date(r.submittedAt).toLocaleString("zh-CN") : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Summary Statistics */}
        <Card>
          <CardHeader>
            <CardTitle>统计摘要</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-slate-600">最高分</p>
                <p className="text-2xl font-bold text-green-600">{maxScore}</p>
              </div>
              <div>
                <p className="text-sm text-slate-600">最低分</p>
                <p className="text-2xl font-bold text-red-600">{minScore}</p>
              </div>
              <div>
                <p className="text-sm text-slate-600">平均分</p>
                <p className="text-2xl font-bold text-blue-600">{avgScore}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
