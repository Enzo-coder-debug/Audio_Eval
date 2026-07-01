import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Music, CheckCircle, Clock, LogOut } from "lucide-react";
import { trpc } from "@/lib/trpc";

export default function UserDashboard() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();

  // Fetch published questionnaires
  const { data: questionnaires, isLoading: isLoadingQuestionnaires } =
    trpc.questionnaire.listPublished.useQuery();

  // Fetch user responses
  const { data: responses, isLoading: isLoadingResponses } =
    trpc.response.listUser.useQuery();

  const handleLogout = async () => {
    await logout();
    setLocation("/");
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Music className="w-6 h-6 text-blue-600" />
            <h1 className="text-xl font-semibold text-slate-900">答题中心</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-600">{user?.name}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="text-slate-600 hover:text-slate-900"
            >
              <LogOut className="w-4 h-4 mr-2" />
              退出
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Tabs defaultValue="available" className="space-y-6">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="available">可用问卷</TabsTrigger>
            <TabsTrigger value="completed">已完成</TabsTrigger>
          </TabsList>

          {/* Available Questionnaires */}
          <TabsContent value="available" className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">可用问卷</h2>
              <p className="text-slate-600 mt-1">选择一份问卷开始答题</p>
            </div>

            {isLoadingQuestionnaires ? (
              <div className="text-center py-12">
                <p className="text-slate-600">加载中...</p>
              </div>
            ) : !questionnaires || questionnaires.length === 0 ? (
              <Card>
                <CardContent className="pt-12 text-center">
                  <Music className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                  <p className="text-slate-600 mb-4">暂无可用问卷</p>
                  <p className="text-sm text-slate-500">请稍后再来查看</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4">
                {questionnaires.map((q) => (
                  <Card key={q.id} className="hover:shadow-md transition-shadow overflow-hidden">
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <CardTitle className="text-lg">{q.title}</CardTitle>
                          <CardDescription className="mt-1">
                            {q.description || "点击开始答题"}
                          </CardDescription>
                        </div>
                        {q.validUntil && (
                          <Badge variant="outline" className="ml-4">
                            <Clock className="w-3 h-3 mr-1" />
                            {new Date(q.validUntil).toLocaleDateString("zh-CN")}
                          </Badge>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-slate-600">
                          发布于 {new Date(q.publishedAt || q.createdAt).toLocaleDateString("zh-CN")}
                        </div>
                        <Button
                          className="bg-blue-600 hover:bg-blue-700"
                          onClick={() => setLocation(`/user/questionnaire/${q.id}`)}
                        >
                          开始答题
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Completed Responses */}
          <TabsContent value="completed" className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">已完成</h2>
              <p className="text-slate-600 mt-1">查看你的答题记录和成绩</p>
            </div>

            {isLoadingResponses ? (
              <div className="text-center py-12">
                <p className="text-slate-600">加载中...</p>
              </div>
            ) : !responses || responses.length === 0 ? (
              <Card>
                <CardContent className="pt-12 text-center">
                  <CheckCircle className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                  <p className="text-slate-600 mb-4">还没有完成任何问卷</p>
                  <p className="text-sm text-slate-500">完成问卷后，成绩和反馈将显示在这里</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4">
                {responses.map((r) => (
                  <Card key={r.id} className="hover:shadow-md transition-shadow">
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <CardTitle className="text-lg">问卷 #{r.questionnaireId}</CardTitle>
                          <CardDescription className="mt-1">
                            {r.status === "graded"
                              ? `得分: ${r.totalScore}`
                              : r.status === "submitted"
                              ? "等待评分中..."
                              : "进行中"}
                          </CardDescription>
                        </div>
                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                          r.status === "graded"
                            ? "bg-green-100 text-green-700"
                            : r.status === "submitted"
                            ? "bg-yellow-100 text-yellow-700"
                            : "bg-blue-100 text-blue-700"
                        }`}>
                          {r.status === "graded" ? "已评分" : r.status === "submitted" ? "已提交" : "进行中"}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-slate-600">
                          {new Date(r.startedAt).toLocaleDateString("zh-CN")}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setLocation(`/user/response/${r.id}`)}
                        >
                          查看详情
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
