import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Upload, Plus, Music, FileText, LogOut, X, Loader2, Trash2, Copy } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

interface AudioItem {
  file: File;
  modelName: string;
}

export default function AdminDashboard() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [audioItems, setAudioItems] = useState<AudioItem[]>([]);
  const [title, setTitle] = useState("");
  const [evaluationCopywriting, setEvaluationCopywriting] = useState("");
  const [scoringStandard, setScoringStandard] = useState("");

  // Fetch admin questionnaires
  const { data: questionnaires, isLoading: isLoadingQuestionnaires, refetch: refetchQuestionnaires } = 
    trpc.questionnaire.listAdmin.useQuery();

  // Handle audio upload mutation
  const { mutate: uploadAudio, isPending: isUploadingAudio } = trpc.audio.upload.useMutation({
    onSuccess: (data) => {
      toast.success(`上传成功！已创建 ${data.blindTestPairsCount} 个对比配对，${data.dimensionsCount} 个评分维度`);
      setIsUploadDialogOpen(false);
      setAudioItems([]);
      setTitle("");
      setEvaluationCopywriting("");
      setScoringStandard("");
      refetchQuestionnaires();
    },
    onError: (error) => {
      toast.error(error.message || "上传失败，请重试");
    },
  });

  // 删除问卷
  const { mutate: deleteQuestionnaire, isPending: isDeleting } = trpc.questionnaire.delete.useMutation({
    onSuccess: () => {
      toast.success("问卷已删除");
      refetchQuestionnaires();
    },
    onError: (error) => {
      toast.error(error.message || "删除失败，请重试");
    },
  });

  const handleDelete = (id: number, title: string) => {
    if (window.confirm(`确定删除问卷「${title}」吗？该操作将同时删除其所有配对、维度和作答记录，且不可恢复。`)) {
      deleteQuestionnaire({ id });
    }
  };

  // 复制问卷:创建一份草稿副本(含音频、组别、维度并按组别重建配对)
  const { mutate: duplicateQuestionnaire, isPending: isDuplicating } = trpc.questionnaire.duplicate.useMutation({
    onSuccess: () => {
      toast.success("问卷已复制为草稿副本");
      refetchQuestionnaires();
    },
    onError: (error) => {
      toast.error(error.message || "复制失败，请重试");
    },
  });

  const handleDuplicate = (id: number, title: string) => {
    if (window.confirm(`确定复制问卷「${title}」吗？将创建一份草稿副本。`)) {
      duplicateQuestionnaire({ id });
    }
  };

  // Add files to the list
  const handleFilesSelected = (files: FileList | null) => {
    if (!files) return;
    const newItems: AudioItem[] = Array.from(files).map(file => ({
      file,
      modelName: "",
    }));
    setAudioItems(prev => [...prev, ...newItems]);
  };

  // Remove an audio item
  const removeAudioItem = (index: number) => {
    setAudioItems(prev => prev.filter((_, i) => i !== index));
  };

  // Update model name for an audio item
  const updateModelName = (index: number, modelName: string) => {
    setAudioItems(prev => prev.map((item, i) => i === index ? { ...item, modelName } : item));
  };

  // Handle batch upload
  const handleUpload = async () => {
    if (audioItems.length === 0) {
      toast.error("请至少上传一个音频文件");
      return;
    }
    if (!title.trim()) {
      toast.error("请填写问卷名称");
      return;
    }
    if (audioItems.some(item => !item.modelName.trim())) {
      toast.error("请为每个音频指定所属模型");
      return;
    }
    if (!evaluationCopywriting || evaluationCopywriting.length < 10) {
      toast.error("请填写测评背景（至少10个字符）");
      return;
    }
    if (!scoringStandard || scoringStandard.length < 10) {
      toast.error("请填写评分标准（至少10个字符）");
      return;
    }

    try {
      const audios = await Promise.all(
        audioItems.map(async (item) => {
          const fileData = await item.file.arrayBuffer();
          let mimeType: "audio/mpeg" | "audio/wav" | "audio/mp4" = "audio/mpeg";
          if (item.file.type === "audio/wav") mimeType = "audio/wav";
          else if (item.file.type === "audio/mp4" || item.file.name.endsWith(".m4a")) mimeType = "audio/mp4";
          
          return {
            fileName: item.file.name,
            fileData: new Uint8Array(fileData),
            mimeType,
            fileSizeBytes: item.file.size,
            modelName: item.modelName.trim(),
          };
        })
      );

      uploadAudio({
        title: title.trim(),
        audios,
        evaluationCopywriting,
        scoringStandard,
      });
    } catch (error) {
      toast.error("文件读取失败");
      console.error(error);
    }
  };

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
            <h1 className="text-xl font-semibold text-slate-900">语音模型盲测管理</h1>
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
        <Tabs defaultValue="questionnaires" className="space-y-6">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="questionnaires">盲测管理</TabsTrigger>
            <TabsTrigger value="statistics">数据统计</TabsTrigger>
          </TabsList>

          {/* Questionnaires Tab */}
          <TabsContent value="questionnaires" className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-slate-900">盲测问卷</h2>
                <p className="text-slate-600 mt-1">上传多个模型的音频，系统自动创建对比盲测</p>
              </div>
              <Dialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen}>
                <DialogTrigger asChild>
                  <Button className="bg-blue-600 hover:bg-blue-700">
                    <Plus className="w-4 h-4 mr-2" />
                    新建盲测
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>创建语音模型盲测</DialogTitle>
                    <DialogDescription>
                      上传多个模型的音频文件，系统将自动配对进行对比盲测
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-6">
                    {/* Questionnaire Title */}
                    <div className="space-y-2">
                      <Label htmlFor="title">问卷名称</Label>
                      <Input
                        id="title"
                        placeholder="请输入问卷名称，如：TTS 模型对比测评 2026"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                      />
                    </div>

                    {/* Batch File Upload */}
                    <div className="space-y-3">
                      <Label>音频文件（支持批量上传）</Label>
                      <div className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center hover:border-blue-400 transition-colors">
                        <input
                          type="file"
                          accept="audio/*"
                          multiple
                          onChange={(e) => handleFilesSelected(e.target.files)}
                          className="hidden"
                          id="audio-input"
                        />
                        <label htmlFor="audio-input" className="cursor-pointer">
                          <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                          <p className="font-medium text-slate-900">点击或拖拽上传音频</p>
                          <p className="text-sm text-slate-500 mt-1">支持 MP3、WAV、M4A 格式，可多选</p>
                        </label>
                      </div>

                      {/* Audio Items List */}
                      {audioItems.length > 0 && (
                        <div className="space-y-2 mt-4">
                          <p className="text-sm font-medium text-slate-700">
                            已选择 {audioItems.length} 个文件
                          </p>
                          {audioItems.map((item, idx) => (
                            <div key={idx} className="flex items-center gap-3 bg-white border border-slate-200 rounded-lg p-3">
                              <Music className="w-5 h-5 text-blue-500 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-slate-900 truncate">{item.file.name}</p>
                                <p className="text-xs text-slate-500">{(item.file.size / 1024 / 1024).toFixed(2)} MB</p>
                              </div>
                              <Input
                                placeholder="模型名称"
                                value={item.modelName}
                                onChange={(e) => updateModelName(idx, e.target.value)}
                                className="w-40"
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => removeAudioItem(idx)}
                                className="text-slate-400 hover:text-red-500"
                              >
                                <X className="w-4 h-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Evaluation Copywriting */}
                    <div className="space-y-2">
                      <Label htmlFor="copywriting">测评背景</Label>
                      <Textarea
                        id="copywriting"
                        placeholder="描述此次盲测的背景、目的和评估要求..."
                        value={evaluationCopywriting}
                        onChange={(e) => setEvaluationCopywriting(e.target.value)}
                        className="min-h-24"
                      />
                    </div>

                    {/* Scoring Standard */}
                    <div className="space-y-2">
                      <Label htmlFor="standard">评分标准</Label>
                      <Textarea
                        id="standard"
                        placeholder="详细说明评分维度和标准，如：情绪表达、音质清晰度、自然度等..."
                        value={scoringStandard}
                        onChange={(e) => setScoringStandard(e.target.value)}
                        className="min-h-24"
                      />
                    </div>

                    <div className="flex gap-3 justify-end pt-4">
                      <Button
                        variant="outline"
                        onClick={() => setIsUploadDialogOpen(false)}
                      >
                        取消
                      </Button>
                      <Button
                        className="bg-blue-600 hover:bg-blue-700"
                        onClick={handleUpload}
                        disabled={isUploadingAudio}
                      >
                        {isUploadingAudio ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            上传中...
                          </>
                        ) : (
                          "上传并创建盲测"
                        )}
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>

            {/* Questionnaires List */}
            {isLoadingQuestionnaires ? (
              <div className="text-center py-12">
                <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-600" />
                <p className="text-slate-600 mt-2">加载中...</p>
              </div>
            ) : !questionnaires || questionnaires.length === 0 ? (
              <Card>
                <CardContent className="pt-12 text-center">
                  <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                  <p className="text-slate-600 mb-4">还没有创建任何盲测问卷</p>
                  <Button
                    variant="outline"
                    onClick={() => setIsUploadDialogOpen(true)}
                  >
                    创建第一个盲测
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4">
                {questionnaires.map((q) => (
                  <Card key={q.id} className="hover:shadow-md transition-shadow">
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <CardTitle className="text-lg">{q.title}</CardTitle>
                          <CardDescription className="mt-1">
                            {q.description || "语音模型对比盲测"}
                          </CardDescription>
                        </div>
                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                          q.status === "published"
                            ? "bg-green-100 text-green-700"
                            : q.status === "draft"
                            ? "bg-amber-100 text-amber-700"
                            : "bg-slate-100 text-slate-700"
                        }`}>
                          {q.status === "published" ? "已发布" : q.status === "draft" ? "草稿" : "已下线"}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <div className="text-sm text-slate-600">
                          创建于 {new Date(q.createdAt).toLocaleDateString("zh-CN")}
                        </div>
                        {q.status === "published" && q.shareToken && (
                          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                            <p className="text-xs font-medium text-blue-900 mb-2">分享链接（测评人通过此链接参与盲测）</p>
                            <div className="flex items-center gap-2">
                              <code className="flex-1 text-xs bg-white border border-blue-200 rounded px-2 py-1 text-blue-900 break-all">
                                {`${window.location.origin}/q/${q.shareToken}`}
                              </code>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  navigator.clipboard.writeText(`${window.location.origin}/q/${q.shareToken}`);
                                  toast.success("链接已复制");
                                }}
                              >
                                复制
                              </Button>
                            </div>
                          </div>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setLocation(`/admin/questionnaire/${q.id}`)}
                        >
                          查看详情
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleDuplicate(q.id, q.title)}
                          disabled={isDuplicating}
                          className="ml-2"
                        >
                          <Copy className="w-4 h-4 mr-1" />
                          复制问卷
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleDelete(q.id, q.title)}
                          disabled={isDeleting}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50 ml-2"
                        >
                          <Trash2 className="w-4 h-4 mr-1" />
                          删除
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Statistics Tab */}
          <TabsContent value="statistics" className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">数据统计</h2>
              <p className="text-slate-600 mt-1">查看所有盲测的答题统计和分析</p>
            </div>
            <Card>
              <CardContent className="pt-12 text-center">
                <p className="text-slate-600">请在各问卷详情页查看统计数据</p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
