import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ArrowLeft, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";

export default function ResponseDetail() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/user/response/:id");

  const responseId = params?.id ? parseInt(params.id) : 0;

  // Fetch response
  const { data: response, isLoading } = trpc.response.get.useQuery(
    { id: responseId },
    { enabled: !!responseId }
  );

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="animate-spin w-8 h-8" />
      </div>
    );
  }

  if (!response) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card>
          <CardContent className="pt-12 text-center">
            <p className="text-slate-600 mb-4">答题记录不存在</p>
            <Button onClick={() => setLocation("/user/dashboard")}>
              返回
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const scorePercentage = response.totalScore ? (Number(response.totalScore) / 100) * 100 : 0;
  const isGraded = response.status === "graded";
  const isSubmitted = response.status === "submitted";

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation("/user/dashboard")}
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <h1 className="text-xl font-semibold text-slate-900">答题结果</h1>
          </div>
          <Badge variant={isGraded ? "default" : "secondary"}>
            {isGraded ? "已评分" : isSubmitted ? "评分中" : "进行中"}
          </Badge>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Score Card */}
        <Card className="mb-8 bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200">
          <CardHeader>
            <CardTitle>你的成绩</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {isGraded ? (
              <>
                <div className="flex items-center justify-center gap-8">
                  <div className="text-center">
                    <div className="text-6xl font-bold text-blue-600 mb-2">
                      {Number(response.totalScore)?.toFixed(1) || 0}
                    </div>
                    <p className="text-slate-600">总分 / 100</p>
                  </div>
                  <div className="w-32 h-32 rounded-full bg-white shadow-lg flex items-center justify-center">
                    <div className="text-center">
                      <div className="text-4xl font-bold text-blue-600">
                        {scorePercentage.toFixed(0)}%
                      </div>
                      <p className="text-xs text-slate-600 mt-1">完成度</p>
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">评分进度</span>
                    <span className="font-medium">{scorePercentage.toFixed(0)}%</span>
                  </div>
                  <Progress value={scorePercentage} className="h-2" />
                </div>
              </>
            ) : (
              <div className="text-center py-8">
                <AlertCircle className="w-12 h-12 text-yellow-600 mx-auto mb-4" />
                <p className="text-slate-900 font-medium mb-2">评分进行中</p>
                <p className="text-slate-600 text-sm">
                  AI 正在评阅你的答案，请稍候...
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* AI Comments */}
        {isGraded && response.aiComments && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-green-600" />
                AI 评语
              </CardTitle>
              <CardDescription>
                基于你的答案生成的个性化反馈
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="bg-slate-50 rounded-lg p-6 text-slate-900 whitespace-pre-wrap leading-relaxed">
                {response.aiComments}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Answer Details */}
        {response.answers && response.answers.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>答题详情</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {response.answers.map((answer, idx) => (
                <div key={answer.id} className="border-t pt-6 first:border-t-0 first:pt-0">
                  <div className="flex items-start justify-between mb-3">
                    <h3 className="font-semibold text-slate-900">
                      问题 {idx + 1}
                    </h3>
                    {isGraded && (
                      <div className="text-right">
                        <div className="text-lg font-bold text-blue-600">
                          {Number(answer.score)?.toFixed(1) || 0}
                        </div>
                        <p className="text-xs text-slate-600">分</p>
                      </div>
                    )}
                  </div>

                  <div className="bg-slate-50 rounded-lg p-4 mb-3">
                    <p className="text-slate-900 break-words">
                      {answer.answerContent}
                    </p>
                  </div>

                  {answer.feedback && (
                    <div className="border-l-4 border-blue-400 bg-blue-50 p-4 rounded">
                      <p className="text-sm text-slate-900">
                        <span className="font-medium">反馈：</span>
                        {answer.feedback}
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Action Buttons */}
        <div className="mt-8 flex gap-4 justify-center">
          <Button
            variant="outline"
            onClick={() => setLocation("/user/dashboard")}
          >
            返回
          </Button>
          <Button
            className="bg-blue-600 hover:bg-blue-700"
            onClick={() => setLocation("/user/dashboard")}
          >
            查看其他问卷
          </Button>
        </div>
      </main>
    </div>
  );
}
