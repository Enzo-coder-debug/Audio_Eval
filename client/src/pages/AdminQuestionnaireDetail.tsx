import React, { useState } from "react";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Plus, Edit2, Trash2, Music, Send, Copy, Globe, BarChart3, Download } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import * as XLSX from "xlsx";

// 读取音频文件为上传所需格式(与 AdminDashboard 一致)。
async function readAudioForUpload(file: File) {
  const fileData = await file.arrayBuffer();
  let mimeType: "audio/mpeg" | "audio/wav" | "audio/mp4" = "audio/mpeg";
  if (file.type === "audio/wav") mimeType = "audio/wav";
  else if (file.type === "audio/mp4" || file.name.endsWith(".m4a")) mimeType = "audio/mp4";
  return {
    fileName: file.name,
    fileData: new Uint8Array(fileData),
    mimeType,
    fileSizeBytes: file.size,
  };
}

export default function AdminQuestionnaireDetail() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const questionnaireId = parseInt(id || "0");

  const [isDimensionDialogOpen, setIsDimensionDialogOpen] = useState(false);
  const [editingDimensionId, setEditingDimensionId] = useState<number | null>(null);
  const [dimensionName, setDimensionName] = useState("");
  const [dimensionDescription, setDimensionDescription] = useState("");
  const [dimensionWeight, setDimensionWeight] = useState("1");
  const [dimensionMaxScore, setDimensionMaxScore] = useState("10");
  // 编辑评分标准(保存后自动重新解析并同步维度)
  const [isStandardDialogOpen, setIsStandardDialogOpen] = useState(false);
  const [standardDraft, setStandardDraft] = useState("");
  const [expandedResponseId, setExpandedResponseId] = useState<number | null>(null);

  // 音频管理:待新增音频列表(支持一次选多个,填好模型名后一次性上传+配对)
  // 每一项 = 一个文件 + 对应模型名
  const [pendingAudios, setPendingAudios] = useState<{ file: File; modelName: string; groupLabel: string }[]>([]);
  const audioInputRef = React.useRef<HTMLInputElement>(null);
  // 删除:已勾选待移除的音频 id 集合(支持一次移除成组音频后再统一重建配对)
  const [selectedRemoveIds, setSelectedRemoveIds] = useState<number[]>([]);
  // 组别草稿:音频 id -> 组别输入值(在音频管理表格里就地编辑,保存后调 updateGroupLabels)
  const [groupLabelDraft, setGroupLabelDraft] = useState<Record<number, string>>({});

  // Fetch questionnaire details
  const { data: questionnaire, isLoading: isLoadingQuestionnaire, refetch: refetchQuestionnaire } = 
    trpc.questionnaire.get.useQuery({ id: questionnaireId });

  // Publish questionnaire mutation
  const { mutate: publishQuestionnaire, isPending: isPublishing } = 
    trpc.questionnaire.update.useMutation({
      onSuccess: () => {
        toast.success("问卷已发布！分享链接已生成");
        refetchQuestionnaire();
      },
      onError: (error) => {
        toast.error(error.message || "发布失败");
      },
    });

  // Unpublish questionnaire mutation
  const { mutate: unpublishQuestionnaire, isPending: isUnpublishing } = 
    trpc.questionnaire.update.useMutation({
      onSuccess: () => {
        toast.success("问卷已下线");
        refetchQuestionnaire();
      },
      onError: (error) => {
        toast.error(error.message || "操作失败");
      },
    });

  // Fetch evaluation dimensions
  const { data: dimensions, refetch: refetchDimensions } = 
    trpc.dimension.list.useQuery({ questionnaireId });

  // 音频管理:该问卷当前音频列表 + 是否已有作答(用于风险提示)
  const { data: audioData, refetch: refetchAudios } =
    trpc.audio.listByQuestionnaire.useQuery({ questionnaireId });
  const questionnaireAudios = audioData?.audios || [];
  const audioResponseCount = audioData?.responseCount || 0;

  const { mutate: addAudio, isPending: isAddingAudio } =
    trpc.audio.addToQuestionnaire.useMutation({
      onSuccess: () => {
        toast.success("音频已添加，请设置组别后点击「生成盲测配对」");
        setPendingAudios([]);
        if (audioInputRef.current) audioInputRef.current.value = "";
        refetchAudios();
        refetchResponses();
      },
      onError: (error) => toast.error(error.message || "添加失败"),
    });

  const { mutate: removeAudio, isPending: isRemovingAudio } =
    trpc.audio.removeFromQuestionnaire.useMutation({
      onSuccess: () => {
        toast.success("音频已移除，请重新点击「生成盲测配对」");
        setSelectedRemoveIds([]);
        refetchAudios();
        refetchResponses();
      },
      onError: (error) => toast.error(error.message || "移除失败"),
    });

  // 保存组别:批量把表格中就地编辑的组别写回音频记录(不触发配对)
  const { mutate: saveGroupLabels, isPending: isSavingGroups } =
    trpc.audio.updateGroupLabels.useMutation({
      onSuccess: () => {
        toast.success("组别已保存，可点击「生成盲测配对」");
        refetchAudios();
      },
      onError: (error) => toast.error(error.message || "保存组别失败"),
    });

  // 生成盲测配对:按当前音频组别显式重建配对(会清空已有答卷)
  const { mutate: generatePairs, isPending: isGeneratingPairs } =
    trpc.audio.generatePairs.useMutation({
      onSuccess: (res: any) => {
        toast.success(`已生成 ${res?.pairsCount ?? 0} 组盲测配对`);
        refetchAudios();
        refetchResponses();
      },
      onError: (error) => toast.error(error.message || "生成配对失败"),
    });

  // Fetch responses with auto-refresh
  const { data: responsesData, refetch: refetchResponses } = 
    trpc.response.listQuestionnaire.useQuery({ questionnaireId });
  const responses = responsesData?.responses;
  const pairsInfo = responsesData?.pairsInfo;

  // Auto-refresh every 5 seconds
  React.useEffect(() => {
    const interval = setInterval(() => {
      refetchResponses();
    }, 5000);
    return () => clearInterval(interval);
  }, [refetchResponses]);

  // Create dimension mutation
  const { mutate: createDimension, isPending: isCreatingDimension } = 
    trpc.dimension.create.useMutation({
      onSuccess: () => {
        toast.success("维度添加成功！");
        setIsDimensionDialogOpen(false);
        resetDimensionForm();
        refetchDimensions();
      },
      onError: (error) => {
        toast.error(error.message || "添加失败");
      },
    });

  // Update dimension mutation
  const { mutate: updateDimension, isPending: isUpdatingDimension } = 
    trpc.dimension.update.useMutation({
      onSuccess: () => {
        toast.success("维度更新成功！");
        setIsDimensionDialogOpen(false);
        resetDimensionForm();
        refetchDimensions();
      },
      onError: (error) => {
        toast.error(error.message || "更新失败");
      },
    });

  // Delete dimension mutation
  const { mutate: deleteDimension } = 
    trpc.dimension.delete.useMutation({
      onSuccess: () => {
        toast.success("维度删除成功！");
        refetchDimensions();
      },
      onError: (error) => {
        toast.error(error.message || "删除失败");
      },
    });

  // 保存评分标准:变更后端会自动重新解析并同步维度(删旧建新);若已有作答会一并清理
  const { mutate: updateStandard, isPending: isUpdatingStandard } =
    trpc.questionnaire.update.useMutation({
      onSuccess: (res: any) => {
        if (res?.dimensionsUpdated) {
          toast.success(`评分标准已更新，已重新解析 ${res.dimensionsCount ?? 0} 个维度`);
        } else {
          toast.success("评分标准已更新");
        }
        setIsStandardDialogOpen(false);
        refetchDimensions();
        refetchQuestionnaire();
      },
      onError: (error) => {
        toast.error(error.message || "更新失败");
      },
    });

  const handleSaveStandard = () => {
    if (!standardDraft.trim()) {
      toast.error("请填写评分标准");
      return;
    }
    if (
      standardDraft !== (questionnaire?.scoringStandard || "") &&
      audioResponseCount > 0 &&
      !window.confirm(
        `修改评分标准会重新解析评分维度，并清空该问卷已有的 ${audioResponseCount} 份作答记录，确定继续吗？`
      )
    ) {
      return;
    }
    updateStandard({ id: questionnaireId, scoringStandard: standardDraft });
  };

  const resetDimensionForm = () => {
    setDimensionName("");
    setDimensionDescription("");
    setDimensionWeight("1");
    setDimensionMaxScore("10");
    setEditingDimensionId(null);
  };

  const handleSaveDimension = () => {
    if (!dimensionName.trim()) {
      toast.error("请输入维度名称");
      return;
    }

    if (editingDimensionId) {
      updateDimension({
        id: editingDimensionId,
        dimensionName,
        description: dimensionDescription || undefined,
        weight: parseFloat(dimensionWeight),
        maxScore: parseFloat(dimensionMaxScore),
      });
    } else {
      createDimension({
        questionnaireId,
        dimensionName,
        description: dimensionDescription || undefined,
        weight: parseFloat(dimensionWeight),
        maxScore: parseFloat(dimensionMaxScore),
        orderIndex: (dimensions?.length || 0) + 1,
      });
    }
  };

  const handleEditDimension = (dimension: any) => {
    setEditingDimensionId(dimension.id);
    setDimensionName(dimension.dimensionName);
    setDimensionDescription(dimension.description || "");
    setDimensionWeight(String(dimension.weight));
    setDimensionMaxScore(String(dimension.maxScore));
    setIsDimensionDialogOpen(true);
  };

  const handleDeleteDimension = (dimensionId: number) => {
    if (confirm("确定要删除这个维度吗？")) {
      deleteDimension({ id: dimensionId });
    }
  };

  // 选择文件:把新选中的文件追加到待上传列表(默认模型名/组别留空,由用户填写)
  const handleSelectFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added = Array.from(files).map((file) => ({ file, modelName: "", groupLabel: "" }));
    setPendingAudios((prev) => [...prev, ...added]);
    if (audioInputRef.current) audioInputRef.current.value = "";
  };

  const updatePendingModelName = (index: number, modelName: string) => {
    setPendingAudios((prev) => prev.map((it, i) => (i === index ? { ...it, modelName } : it)));
  };

  const updatePendingGroupLabel = (index: number, groupLabel: string) => {
    setPendingAudios((prev) => prev.map((it,i) => (i === index ? { ...it, groupLabel } : it)));
  };

  const removePendingAudio = (index: number) => {
    setPendingAudios((prev) => prev.filter((_, i) => i !== index));
  };

  // 新增音频:等这一批全部选好并填好模型名后,一次性上传(不自动配对,组别可选)
  const handleAddAudio = async () => {
    if (pendingAudios.length === 0) {
      toast.error("请先选择音频文件");
      return;
    }
    if (pendingAudios.some((it) => !it.modelName.trim())) {
      toast.error("请为每个待上传音频填写模型名称");
      return;
    }
    try {
      const audios = await Promise.all(
        pendingAudios.map(async (it) => {
          const base = await readAudioForUpload(it.file);
          return { ...base, modelName: it.modelName.trim(), groupLabel: it.groupLabel.trim() || undefined };
        })
      );
      addAudio({ questionnaireId, audios });
    } catch (e) {
      toast.error("文件读取失败");
    }
  };

  const toggleRemoveSelect = (audioFileId: number) => {
    setSelectedRemoveIds((prev) =>
      prev.includes(audioFileId) ? prev.filter((id) => id !== audioFileId) : [...prev, audioFileId]
    );
  };

  // 批量移除:勾选成组音频后统一移除(不自动配对,需管理员再手动生成)
  const handleRemoveSelected = () => {
    if (selectedRemoveIds.length === 0) {
      toast.error("请先勾选要移除的音频");
      return;
    }
    if (confirm(`确定移除选中的 ${selectedRemoveIds.length} 个音频吗？移除后请重新生成盲测配对。`)) {
      removeAudio({ questionnaireId, audioFileIds: selectedRemoveIds });
    }
  };

  // 保存组别:把表格里就地编辑的组别草稿批量写回(空草稿的音频用其当前组别)
  const handleSaveGroupLabels = () => {
    const items = questionnaireAudios.map((a: any) => ({
      audioFileId: a.id,
      groupLabel: (groupLabelDraft[a.id] ?? a.groupLabel ?? "").trim(),
    }));
    if (items.length === 0) {
      toast.error("暂无音频可设置组别");
      return;
    }
    saveGroupLabels({ questionnaireId, items });
  };

  // 生成盲测配对:显式重建(会清空已有答卷),先保存当前组别再生成
  const handleGeneratePairs = () => {
    const msg = audioResponseCount > 0
      ? `该问卷已有 ${audioResponseCount} 份答卷，重新生成配对会清空已有答卷数据，确定继续？`
      : "将按当前音频组别生成盲测配对（同组内不同模型两两配对）。确定继续？";
    if (confirm(msg)) {
      generatePairs({ questionnaireId });
    }
  };

  // Calculate statistics
  const totalResponses = responses?.length || 0;
  const completedResponses = responses?.filter(r => r.status === "graded").length || 0;
  const inProgressResponses = responses?.filter(r => r.status === "in_progress").length || 0;
  const completionRate = totalResponses > 0 ? ((completedResponses / totalResponses) * 100).toFixed(1) : 0;

  // 维度 id -> 名称映射,用于在答卷详情里展示每个维度的选择
  const dimensionNameMap = new Map<number, string>(
    (dimensions || []).map((d: any) => [d.id, d.dimensionName])
  );
  // 盲测配对 id -> 左右模型信息映射,把"左/右更好"翻译为具体模型的优劣
  const pairInfoMap = new Map<number, any>(
    (pairsInfo || []).map((p: any) => [p.id, p])
  );
  // 从文件名中提取音频序号(去扩展名后取末尾数字),用作"音频X"的展示
  const audioLabel = (fileName: string | null | undefined) => {
    if (!fileName) return "音频";
    const base = fileName.replace(/\.[^/.]+$/, "");
    const m = base.match(/(\d+)\s*$/);
    return m ? `音频${m[1]}` : base;
  };
  const verdictLabel = (pair: any, choice: string | null | undefined) => {
    const left = pair?.leftModelName ?? "左侧模型";
    const right = pair?.rightModelName ?? "右侧模型";
    if (choice === "left_better") return `${left} 更好`;
    if (choice === "right_better") return `${right} 更好`;
    if (choice === "same") return `${left} 与 ${right} 相当`;
    return "-";
  };
  // 把一份答卷的盲测选择按配对(blindTestPairId)分组,组序号按出现顺序
  const groupAnswersByPair = (answers: any[]) => {
    const order: number[] = [];
    const map = new Map<number, any[]>();
    for (const a of answers || []) {
      const pid = a.blindTestPairId ?? -1;
      if (!map.has(pid)) {
        map.set(pid, []);
        order.push(pid);
      }
      map.get(pid)!.push(a);
    }
    return order.map(pid => ({ pairId: pid, answers: map.get(pid)! }));
  };

  // 导出答卷详情到 Excel:每个答卷人一个 sheet,行=各盲测配对×维度的选择结果
  const handleExportExcel = () => {
    if (!responses || responses.length === 0) {
      toast.error("暂无答卷可导出");
      return;
    }
    const wb = XLSX.utils.book_new();
    const usedNames = new Set<string>();
    // sheet 名去重且满足 Excel 限制(<=31字符,不含 : \ / ? * [ ])
    const safeSheetName = (raw: string, idx: number) => {
      let name = (raw || `答卷${idx + 1}`).replace(/[:\\/?*[\]]/g, "_").slice(0, 28);
      let candidate = name || `答卷${idx + 1}`;
      let n = 1;
      while (usedNames.has(candidate)) {
        candidate = `${name.slice(0, 25)}_${n++}`;
      }
      usedNames.add(candidate);
      return candidate;
    };

    responses.forEach((response: any, idx: number) => {
      const rows: any[] = [];
      // 每个 sheet 头部信息
      rows.push({ 配对: "访客名称", 维度: response.visitorName || "匿名", 选择结果: "" });
      rows.push({ 配对: "访客IP", 维度: response.visitorIp || "-", 选择结果: "" });
      rows.push({
        配对: "状态",
        维度:
          response.status === "graded" ? "已评分" : response.status === "submitted" ? "已提交" : "进行中",
        选择结果: "",
      });
      rows.push({
        配对: "提交时间",
        维度: response.submittedAt ? new Date(response.submittedAt).toLocaleString("zh-CN") : "-",
        选择结果: "",
      });
      rows.push({ 配对: "", 维度: "", 选择结果: "" });

      const groups = groupAnswersByPair(response.answers || []);
      for (const group of groups) {
        const pair = pairInfoMap.get(group.pairId);
        const leftAudio = audioLabel(pair?.leftFileName);
        const rightAudio = audioLabel(pair?.rightFileName);
        const groupTitle = leftAudio === rightAudio ? leftAudio : `${leftAudio} vs ${rightAudio}`;
        for (const a of group.answers) {
          rows.push({
            配对: groupTitle,
            维度: a.evaluationDimensionId
              ? dimensionNameMap.get(a.evaluationDimensionId) || `维度#${a.evaluationDimensionId}`
              : "评价",
            选择结果: verdictLabel(pair, a.blindTestChoice),
          });
        }
      }

      const ws = XLSX.utils.json_to_sheet(rows, { header: ["配对", "维度", "选择结果"] });
      ws["!cols"] = [{ wch: 24 }, { wch: 20 }, { wch: 24 }];
      XLSX.utils.book_append_sheet(wb, ws, safeSheetName(response.visitorName, idx));
    });

    const fileName = `${(questionnaire?.title || "答卷详情").replace(/[\\/?*[\]:]/g, "_")}.xlsx`;
    XLSX.writeFile(wb, fileName);
    toast.success(`已导出 ${responses.length} 份答卷`);
  };

  if (isLoadingQuestionnaire) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <p className="text-slate-600">加载中...</p>
      </div>
    );
  }

  if (!questionnaire) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <p className="text-slate-600">问卷不存在</p>
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
              onClick={() => setLocation("/admin/dashboard")}
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              返回
            </Button>
            <div>
              <h1 className="text-xl font-semibold text-slate-900">{questionnaire.title}</h1>
              <p className="text-sm text-slate-600">问卷详情与管理</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {questionnaire.status === "draft" && (
              <Button
                className="bg-blue-600 hover:bg-blue-700"
                onClick={() => publishQuestionnaire({ id: questionnaireId, status: "published" })}
                disabled={isPublishing}
              >
                <Send className="w-4 h-4 mr-2" />
                {isPublishing ? "发布中..." : "发布问卷"}
              </Button>
            )}
            {questionnaire.status === "published" && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (questionnaire.shareToken) {
                      navigator.clipboard.writeText(`${window.location.origin}/q/${questionnaire.shareToken}`);
                      toast.success("分享链接已复制到剪贴板");
                    }
                  }}
                >
                  <Copy className="w-4 h-4 mr-2" />
                  复制链接
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={() => unpublishQuestionnaire({ id: questionnaireId, status: "offline" })}
                  disabled={isUnpublishing}
                >
                  {isUnpublishing ? "下线中..." : "下线问卷"}
                </Button>
              </>
            )}
            {questionnaire.status === "offline" && (
              <Button
                className="bg-blue-600 hover:bg-blue-700"
                onClick={() => publishQuestionnaire({ id: questionnaireId, status: "published" })}
                disabled={isPublishing}
              >
                <Globe className="w-4 h-4 mr-2" />
                {isPublishing ? "发布中..." : "重新发布"}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLocation(`/admin/questionnaire/${questionnaireId}/analytics`)}
            >
              <BarChart3 className="w-4 h-4 mr-2" />
              查看分析
            </Button>
            <span className={`px-3 py-1 rounded-full text-xs font-medium ${
              questionnaire.status === "published"
                ? "bg-green-100 text-green-700"
                : questionnaire.status === "draft"
                ? "bg-amber-100 text-amber-700"
                : "bg-slate-100 text-slate-700"
            }`}>
              {questionnaire.status === "published" ? "已发布" : questionnaire.status === "draft" ? "草稿" : "已下线"}
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Tabs defaultValue="dimensions" className="space-y-6">
          <TabsList className="grid w-full max-w-lg grid-cols-4">
            <TabsTrigger value="dimensions">测评维度</TabsTrigger>
            <TabsTrigger value="audios">音频管理</TabsTrigger>
            <TabsTrigger value="progress">填写进展</TabsTrigger>
            <TabsTrigger value="responses">答卷详情</TabsTrigger>
          </TabsList>

          {/* Dimensions Tab */}
          <TabsContent value="dimensions" className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-slate-900">测评维度</h2>
                <p className="text-slate-600 mt-1">定义问卷的评分维度</p>
              </div>
              <div className="flex items-center gap-2">
                <Dialog open={isStandardDialogOpen} onOpenChange={setIsStandardDialogOpen}>
                  <DialogTrigger asChild>
                    <Button
                      variant="outline"
                      onClick={() => setStandardDraft(questionnaire?.scoringStandard || "")}
                    >
                      <Edit2 className="w-4 h-4 mr-2" />
                      编辑评分标准
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-lg">
                    <DialogHeader>
                      <DialogTitle>编辑评分标准</DialogTitle>
                      <DialogDescription>
                        保存后将根据评分标准文本自动重新解析并同步评分维度（覆盖现有维度）。
                        {audioResponseCount > 0 && (
                          <span className="text-red-600">
                            {" "}该问卷已有 {audioResponseCount} 份作答，保存将一并清空。
                          </span>
                        )}
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="standardDraft">评分标准</Label>
                        <Textarea
                          id="standardDraft"
                          rows={8}
                          placeholder="每行/分号分隔一个维度，如：情绪表达：是否自然；音质清晰度；整体自然度..."
                          value={standardDraft}
                          onChange={(e) => setStandardDraft(e.target.value)}
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" onClick={() => setIsStandardDialogOpen(false)}>
                          取消
                        </Button>
                        <Button
                          className="bg-blue-600 hover:bg-blue-700"
                          disabled={isUpdatingStandard}
                          onClick={handleSaveStandard}
                        >
                          {isUpdatingStandard ? "保存中..." : "保存并重新解析"}
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
                <Dialog open={isDimensionDialogOpen} onOpenChange={setIsDimensionDialogOpen}>
                <DialogTrigger asChild>
                  <Button
                    className="bg-blue-600 hover:bg-blue-700"
                    onClick={() => resetDimensionForm()}
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    添加维度
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>
                      {editingDimensionId ? "编辑维度" : "添加新维度"}
                    </DialogTitle>
                  </DialogHeader>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>维度名称 *</Label>
                      <Input
                        placeholder="如：发音、流畅度、语调"
                        value={dimensionName}
                        onChange={(e) => setDimensionName(e.target.value)}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>描述</Label>
                      <Textarea
                        placeholder="维度的详细描述"
                        value={dimensionDescription}
                        onChange={(e) => setDimensionDescription(e.target.value)}
                        rows={3}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>权重</Label>
                        <Input
                          type="number"
                          step="0.1"
                          min="0"
                          value={dimensionWeight}
                          onChange={(e) => setDimensionWeight(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>满分</Label>
                        <Input
                          type="number"
                          step="0.1"
                          min="0"
                          value={dimensionMaxScore}
                          onChange={(e) => setDimensionMaxScore(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="flex gap-2 pt-4">
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => {
                          setIsDimensionDialogOpen(false);
                          resetDimensionForm();
                        }}
                      >
                        取消
                      </Button>
                      <Button
                        className="flex-1 bg-blue-600 hover:bg-blue-700"
                        onClick={handleSaveDimension}
                        disabled={isCreatingDimension || isUpdatingDimension}
                      >
                        {editingDimensionId ? "更新" : "添加"}
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
              </div>
            </div>

            {/* Dimensions List */}
            {!dimensions || dimensions.length === 0 ? (
              <Card>
                <CardContent className="pt-12 text-center">
                  <p className="text-slate-600 mb-4">还没有添加任何维度</p>
                  <Button
                    variant="outline"
                    onClick={() => {
                      resetDimensionForm();
                      setIsDimensionDialogOpen(true);
                    }}
                  >
                    添加第一个维度
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4">
                {dimensions.map((dimension: any) => (
                  <Card key={dimension.id}>
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle className="text-lg">{dimension.dimensionName}</CardTitle>
                          {dimension.description && (
                            <CardDescription className="mt-1">
                              {dimension.description}
                            </CardDescription>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleEditDimension(dimension)}
                          >
                            <Edit2 className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleDeleteDimension(dimension.id)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex gap-6 text-sm">
                        <div>
                          <span className="text-slate-600">权重：</span>
                          <span className="font-medium">{dimension.weight}</span>
                        </div>
                        <div>
                          <span className="text-slate-600">满分：</span>
                          <span className="font-medium">{dimension.maxScore}</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Audio Management Tab */}
          <TabsContent value="audios" className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">音频管理</h2>
              <p className="text-slate-600 mt-1">
                可一次选择多个音频、分别填好模型名和组别后统一上传。上传/移除后不再自动配对，需在下方为音频设置组别并点击「生成盲测配对」（同组内不同模型两两配对）。
                {audioResponseCount > 0 && (
                  <span className="text-red-600">（该问卷已有 {audioResponseCount} 份答卷，修改音频会清空已有答卷）</span>
                )}
              </p>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">批量新增音频</CardTitle>
                <CardDescription>先选择一批音频文件，为每个文件填写模型名称，最后统一上传并重建配对</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>选择音频文件（可多选）</Label>
                  <Input
                    ref={audioInputRef}
                    type="file"
                    multiple
                    accept="audio/*,.m4a"
                    onChange={(e) => handleSelectFiles(e.target.files)}
                  />
                </div>

                {pendingAudios.length > 0 && (
                  <div className="space-y-2">
                    <Label>待上传列表（{pendingAudios.length} 个，请为每个填写模型名）</Label>
                    <div className="space-y-2">
                      {pendingAudios.map((item, idx) => (
                        <div key={idx} className="flex items-center gap-3 rounded-md border p-2">
                          <Music className="w-4 h-4 text-slate-400 shrink-0" />
                          <span className="flex-1 truncate text-sm text-slate-700">{item.file.name}</span>
                          <Input
                            className="w-40"
                            placeholder="模型名称，如：模型A"
                            value={item.modelName}
                            onChange={(e) => updatePendingModelName(idx, e.target.value)}
                          />
                          <Input
                            className="w-32"
                            placeholder="组别（可选）"
                            value={item.groupLabel}
                            onChange={(e) => updatePendingGroupLabel(idx, e.target.value)}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => removePendingAudio(idx)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <Button
                  className="bg-blue-600 hover:bg-blue-700"
                  onClick={handleAddAudio}
                  disabled={isAddingAudio || pendingAudios.length === 0}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  {isAddingAudio ? "上传中..." : `上传音频（${pendingAudios.length}）`}
                </Button>
              </CardContent>
            </Card>

            {questionnaireAudios.length === 0 ? (
              <Card>
                <CardContent className="pt-12 text-center">
                  <p className="text-slate-600">该问卷暂无音频，请添加至少两个不同模型的音频以生成盲测配对</p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="pt-6">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-slate-600">
                      已勾选 {selectedRemoveIds.length} 个音频
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSaveGroupLabels}
                        disabled={isSavingGroups || questionnaireAudios.length === 0}
                      >
                        {isSavingGroups ? "保存中..." : "保存组别"}
                      </Button>
                      <Button
                        size="sm"
                        className="bg-blue-600 hover:bg-blue-700"
                        onClick={handleGeneratePairs}
                        disabled={isGeneratingPairs || questionnaireAudios.length === 0}
                      >
                        {isGeneratingPairs ? "生成中..." : "生成盲测配对"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-red-600 border-red-200 hover:bg-red-50"
                        onClick={handleRemoveSelected}
                        disabled={isRemovingAudio || selectedRemoveIds.length === 0}
                      >
                        <Trash2 className="w-4 h-4 mr-1" />
                        {isRemovingAudio ? "移除中..." : `批量移除（${selectedRemoveIds.length}）`}
                      </Button>
                    </div>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">选择</TableHead>
                        <TableHead>文件名</TableHead>
                        <TableHead>模型名称</TableHead>
                        <TableHead className="w-40">组别</TableHead>
                        <TableHead>试听</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {questionnaireAudios.map((audio: any) => (
                        <TableRow key={audio.id}>
                          <TableCell>
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              checked={selectedRemoveIds.includes(audio.id)}
                              onChange={() => toggleRemoveSelect(audio.id)}
                            />
                          </TableCell>
                          <TableCell>
                            <span className="flex items-center gap-2">
                              <Music className="w-4 h-4 text-slate-400" />
                              {audio.fileName}
                            </span>
                          </TableCell>
                          <TableCell className="font-medium">{audio.modelName || "-"}</TableCell>
                          <TableCell>
                            <Input
                              className="w-36 h-8"
                              placeholder="组别"
                              value={groupLabelDraft[audio.id] ?? audio.groupLabel ?? ""}
                              onChange={(e) =>
                                setGroupLabelDraft((prev) => ({ ...prev, [audio.id]: e.target.value }))
                              }
                            />
                          </TableCell>
                          <TableCell>
                            {audio.fileUrl ? (
                              <audio controls src={audio.fileUrl} className="h-8" />
                            ) : (
                              "-"
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="text-xs text-slate-500 mt-3">
                    提示：为同一段文案下的不同模型音频填相同「组别」，保存组别后点击「生成盲测配对」，同组内不同模型会两两配对。组别为空的音频不参与配对。
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Progress Tab */}
          <TabsContent value="progress" className="space-y-6">
            <h2 className="text-2xl font-bold text-slate-900">填写进展</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-slate-600">总答卷数</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-slate-900">{totalResponses}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-slate-600">已完成</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-green-600">{completedResponses}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-slate-600">进行中</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-blue-600">{inProgressResponses}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-slate-600">完成率</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-slate-900">{completionRate}%</div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Responses Tab */}
          <TabsContent value="responses" className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold text-slate-900">答卷详情</h2>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportExcel}
                disabled={!responses || responses.length === 0}
              >
                <Download className="w-4 h-4 mr-2" />
                导出 Excel
              </Button>
            </div>

            {!responses || responses.length === 0 ? (
              <Card>
                <CardContent className="pt-12 text-center">
                  <p className="text-slate-600">还没有人填写问卷</p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="pt-6">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>访客名称</TableHead>
                        <TableHead>访客 IP</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>得分</TableHead>
                          <TableHead>开始时间</TableHead>
                        <TableHead>提交时间</TableHead>
                        <TableHead>操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {responses.map((response: any) => (
                        <React.Fragment key={response.id}>
                        <TableRow>
                          <TableCell>{response.visitorName || "匿名"}</TableCell>
                       <TableCell className="font-mono text-sm">{response.visitorIp}</TableCell>
                          <TableCell>
                            <span className={`px-2 py-1 rounded text-xs font-medium ${
                              response.status === "graded"
                                ? "bg-green-100 text-green-700"
                                : response.status === "submitted"
                                ? "bg-blue-100 text-blue-700"
                                : "bg-yellow-100 text-yellow-700"
                            }`}>
                              {response.status === "graded" ? "已评分" : response.status === "submitted" ? "已提交" : "进行中"}
                            </span>
                          </TableCell>
                          <TableCell className="font-medium">
                            {response.totalScore ? `${response.totalScore}` : "-"}
                          </TableCell>
                          <TableCell className="text-sm">
                            {new Date(response.startedAt).toLocaleString("zh-CN")}
                          </TableCell>
                          <TableCell className="text-sm">
                            {response.submittedAt ? new Date(response.submittedAt).toLocaleString("zh-CN") : "-"}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setExpandedResponseId(
                                  expandedResponseId === response.id ? null : response.id
                                )
                              }
                            >
                              {expandedResponseId === response.id ? "收起" : "查看作答"}
                            </Button>
                          </TableCell>
                        </TableRow>
                        {expandedResponseId === response.id && (
                          <TableRow>
                            <TableCell colSpan={7} className="bg-slate-50">
                              {!response.answers || response.answers.length === 0 ? (
                                <p className="text-sm text-slate-500 py-2">该答卷暂无作答记录</p>
                              ) : (
                                <div className="space-y-4 py-2">
                                  {groupAnswersByPair(response.answers).map((group) => {
                                    const pair = pairInfoMap.get(group.pairId);
                                    const leftAudio = audioLabel(pair?.leftFileName);
                                    const rightAudio = audioLabel(pair?.rightFileName);
                                    const groupTitle =
                                  leftAudio === rightAudio
                                        ? leftAudio
                                        : `${leftAudio} vs ${rightAudio}`;
                                    return (
                                    <div key={group.pairId} className="border border-slate-200 rounded-lg p-3 bg-white">
                                      <p className="font-medium text-slate-800 mb-2">{groupTitle}</p>
                                      <div className="space-y-1">
                                        {group.answers.map((a: any) => (
                                          <div key={a.id} className="flex items-center justify-between text-sm">
                                            <span className="text-slate-600">
                                              {a.evaluationDimensionId
                                            ? dimensionNameMap.get(a.evaluationDimensionId) || `维度#${a.evaluationDimensionId}`
                                                : "评价"}
                                            </span>
                                            <span className="font-medium text-slate-900">
                                              {verdictLabel(pair, a.blindTestChoice)}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                    );
                                  })}
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                        </React.Fragment>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
