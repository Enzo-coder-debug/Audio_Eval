import { useEffect, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Play, Loader2, Sparkles } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export default function QuestionnaireDetail() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/admin/questionnaire/:id");
  const [, userParams] = useRoute("/user/questionnaire/:id");
  
  const questionnaireId = params?.id || userParams?.id;
  const isAdmin = user?.role === "admin";

  const [isGeneratingQuestions, setIsGeneratingQuestions] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editStatus, setEditStatus] = useState("");

  // Fetch questionnaire
  const { data: questionnaire, isLoading, refetch } = trpc.questionnaire.get.useQuery(
    { id: parseInt(questionnaireId || "0") },
    { enabled: !!questionnaireId }
  );

  // Fetch audio file for playback
  const { data: audioFile } = trpc.audio.get.useQuery(
    { id: questionnaire?.audioFileId || 0 },
    { enabled: !!questionnaire?.audioFileId }
  );

  // Start response for users
  const { mutate: startResponse, isPending: isStarting } = trpc.response.start.useMutation({
    onSuccess: (data) => {
      setLocation(`/user/questionnaire/${questionnaireId}/answer/${data.responseId}`);
    },
    onError: (error) => {
      toast.error(error.message || "无法开始答题");
    },
  });

  // Generate questions
  const { mutate: generateQuestions } = trpc.questionnaire.generateQuestions.useMutation({
    onSuccess: () => {
      toast.success("问卷已生成！");
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "生成失败");
    },
  });

  // Update questionnaire
  const { mutate: updateQuestionnaire } = trpc.questionnaire.update.useMutation({
    onSuccess: () => {
      toast.success("问卷已更新");
      setIsEditDialogOpen(false);
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "更新失败");
    },
  });

  const handleGenerateQuestions = async () => {
    if (!questionnaire || !audioFile) return;

    setIsGeneratingQuestions(true);
    try {
      generateQuestions({
        questionnaireId: questionnaire.id,
        transcription: audioFile.transcription || "",
        evaluationCopywriting: questionnaire.evaluationCopywriting || "",
        scoringStandard: questionnaire.scoringStandard || "",
      });
    } finally {
      setIsGeneratingQuestions(false);
    }
  };

  const handlePublish = () => {
    if (!questionnaire) return;
    updateQuestionnaire({
      id: questionnaire.id,
      status: "published",
    });
  };

  const handleStartAnswering = () => {
    if (!questionnaire) return;
    startResponse({ questionnaireId: questionnaire.id });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="animate-spin w-8 h-8" />
      </div>
    );
  }

  if (!questionnaire) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card>
          <CardContent className="pt-12 text-center">
            <p className="text-slate-600 mb-4">问卷不存在</p>
            <Button onClick={() => setLocation(isAdmin ? "/admin/dashboard" : "/user/dashboard")}>
              返回
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation(isAdmin ? "/admin/dashboard" : "/user/dashboard")}
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <h1 className="text-xl font-semibold text-slate-900">{questionnaire.title}</h1>
          </div>
          <Badge variant={questionnaire.status === "published" ? "default" : "secondary"}>
            {questionnaire.status === "published" ? "已发布" : questionnaire.status === "draft" ? "草稿" : "已下线"}
          </Badge>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid lg:grid-cols-3 gap-8">
          {/* Audio Section */}
          <div className="lg:col-span-2 space-y-6">
            {audioFile && (
              <Card>
                <CardHeader>
                  <CardTitle>音频内容</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="bg-slate-100 rounded-lg p-6 flex items-center gap-4">
                    <div className="w-12 h-12 bg-blue-600 rounded-lg flex items-center justify-center">
                      <Play className="w-6 h-6 text-white" />
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-slate-900">{audioFile.fileName}</p>
                      <p className="text-sm text-slate-600">
                        {(audioFile.fileSizeBytes / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>
                  </div>
                  <audio
                    controls
                    className="w-full"
                    src={audioFile.fileUrl}
                  />
                </CardContent>
              </Card>
            )}

            {/* Questionnaire Info */}
            <Card>
              <CardHeader>
                <CardTitle>问卷信息</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label className="text-slate-600">测评文案</Label>
                  <p className="mt-2 text-slate-900 whitespace-pre-wrap">
                    {questionnaire.evaluationCopywriting}
                  </p>
                </div>
                <div>
                  <Label className="text-slate-600">评分标准</Label>
                  <p className="mt-2 text-slate-900 whitespace-pre-wrap">
                    {questionnaire.scoringStandard}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Questions Section */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>测评问卷</CardTitle>
                  {isAdmin && questionnaire.status === "draft" && (!questionnaire.questions || questionnaire.questions.length === 0) && (
                    <Button
                      size="sm"
                      className="bg-blue-600 hover:bg-blue-700"
                      onClick={handleGenerateQuestions}
                      disabled={isGeneratingQuestions}
                    >
                      {isGeneratingQuestions ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          生成中...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4 mr-2" />
                          AI 生成问卷
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {!questionnaire.questions || questionnaire.questions.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-slate-600 mb-4">还没有问题</p>
                    {isAdmin && questionnaire.status === "draft" && (
                      <Button onClick={handleGenerateQuestions} disabled={isGeneratingQuestions}>
                        {isGeneratingQuestions ? "生成中..." : "使用 AI 生成问卷"}
                      </Button>
                    )}
                  </div>
                ) : (
                  questionnaire.questions.map((question, idx) => (
                    <div key={question.id} className="border-t pt-6 first:border-t-0 first:pt-0">
                      <h3 className="font-semibold text-slate-900 mb-4">
                        {idx + 1}. {question.questionText}
                      </h3>

                      {question.questionType === "single_choice" && (
                        <div className="space-y-3">
                          {(question.options as any[])?.map((option: any) => (
                            <div key={option.id} className="flex items-center gap-3">
                              <RadioGroup disabled>
                                <RadioGroupItem value={option.id} id={`q${question.id}-${option.id}`} />
                              </RadioGroup>
                              <Label htmlFor={`q${question.id}-${option.id}`} className="cursor-pointer">
                                {option.text as string}
                              </Label>
                            </div>
                          ))}
                        </div>
                      )}

                      {question.questionType === "multiple_choice" && (
                        <div className="space-y-3">
                          {(question.options as any[])?.map((option: any) => (
                            <div key={option.id} className="flex items-center gap-3">
                              <Checkbox disabled id={`q${question.id}-${option.id}`} />
                              <Label htmlFor={`q${question.id}-${option.id}`} className="cursor-pointer">
                                {option.text as string}
                              </Label>
                            </div>
                          ))}
                        </div>
                      )}

                      {question.questionType === "subjective" && (
                        <Textarea
                          placeholder="请输入你的答案..."
                          disabled
                          className="min-h-24"
                        />
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {isAdmin && (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">管理操作</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {questionnaire.status === "draft" && (
                      <Button
                        className="w-full bg-green-600 hover:bg-green-700"
                        onClick={handlePublish}
                      >
                        发布问卷
                      </Button>
                    )}
                    <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
                      <DialogTrigger asChild>
                        <Button variant="outline" className="w-full">
                          编辑信息
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>编辑问卷信息</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4">
                          <div>
                            <Label>标题</Label>
                            <Input
                              value={editTitle || questionnaire.title}
                              onChange={(e) => setEditTitle(e.target.value)}
                            />
                          </div>
                          <div className="flex gap-3">
                            <Button
                              variant="outline"
                              onClick={() => setIsEditDialogOpen(false)}
                            >
                              取消
                            </Button>
                            <Button
                              onClick={() => {
                                updateQuestionnaire({
                                  id: questionnaire.id,
                                  title: editTitle || questionnaire.title,
                                });
                              }}
                            >
                              保存
                            </Button>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </CardContent>
                </Card>
              </>
            )}

            {!isAdmin && questionnaire.status === "published" && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">开始答题</CardTitle>
                </CardHeader>
                <CardContent>
                  <Button
                    className="w-full bg-blue-600 hover:bg-blue-700"
                    onClick={handleStartAnswering}
                    disabled={isStarting}
                  >
                    {isStarting ? "加载中..." : "开始答题"}
                  </Button>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">问卷统计</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-600">问题数量</span>
                  <span className="font-medium">{questionnaire.questions?.length || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">创建时间</span>
                  <span className="font-medium">{new Date(questionnaire.createdAt).toLocaleDateString("zh-CN")}</span>
                </div>
                {questionnaire.validUntil && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">有效期至</span>
                    <span className="font-medium">{new Date(questionnaire.validUntil).toLocaleDateString("zh-CN")}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
