import React, { useState } from "react";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GroupLabelPicker } from "@/components/GroupLabelPicker";
import { SubQuestionnaireDistribution } from "@/components/SubQuestionnaireDistribution";
import { DeleteResponseButton } from "@/components/DeleteResponseButton";
import { summarizeResponses } from "@shared/responseStats";
import { ScoringConfigEditor, ScoringConfigSummary } from "@/components/ScoringConfigEditor";
import { formatAudioEvaluation, getScoringConfig, scoringConfigSchema, type ScoringConfig } from "@shared/scoring";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Plus, Edit2, Trash2, Music, Send, Copy, Globe, BarChart3, Download } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatResponsePairAudioLabel } from "@/lib/responseAudioLabels";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { getEmotionCategories, type EmotionCategory } from "@shared/evaluationDimensions";
import { deriveGroupLabel } from "@shared/audioGroupLabels";

// 读取音频文件为上传所需格式(与 AdminDashboard 一致)。
async function readAudioForUpload(file: File) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // base64 编码:避免 tRPC superjson 把二进制展开成数字数组文本(膨胀 3-4 倍)。
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  let mimeType: "audio/mpeg" | "audio/wav" | "audio/mp4" = "audio/mpeg";
  if (file.type === "audio/wav") mimeType = "audio/wav";
  else if (file.type === "audio/mp4" || file.name.endsWith(".m4a")) mimeType = "audio/mp4";
  return {
    fileName: file.name,
    fileData: btoa(binary),
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
  // 特殊维度：音色相似度
  const [dimensionType, setDimensionType] = useState<"normal" | "similarity" | "emotion_accuracy" | "other">("normal");
  const [scoringConfig, setScoringConfig] = useState<ScoringConfig>({ mode: "gsb" });
  const [referenceAudioFileId, setReferenceAudioFileId] = useState<number | null>(null);
  // 参考音频当前显示的文件名(独立上传流程,仅用于回显,不用于业务逻辑)
  const [referenceAudioFileName, setReferenceAudioFileName] = useState<string>("");
  const [referenceAudioUploading, setReferenceAudioUploading] = useState(false);
  const referenceAudioInputRef = React.useRef<HTMLInputElement>(null);
  const [targetGroupLabels, setTargetGroupLabels] = useState<string[]>([]);
  const [emotionCategories, setEmotionCategories] = useState<EmotionCategory[]>([]);
  // 编辑评分标准(保存后自动重新解析并同步维度)
  const [isStandardDialogOpen, setIsStandardDialogOpen] = useState(false);
  const [standardDraft, setStandardDraft] = useState("");
  const [isBackgroundDialogOpen, setIsBackgroundDialogOpen] = useState(false);
  const [backgroundDraft, setBackgroundDraft] = useState("");
  const [isSampleDialogOpen, setIsSampleDialogOpen] = useState(false);
  const [sampleSizeDraft, setSampleSizeDraft] = useState("");
  const [expandedResponseId, setExpandedResponseId] = useState<number | null>(null);

  // 音频管理:待新增音频列表(支持一次选多个,填好模型名后一次性上传+配对)
  // 每一项 = 一个文件 + 对应模型名
  const [pendingAudios, setPendingAudios] = useState<{ file: File; modelName: string; groupLabel: string }[]>([]);
  const audioInputRef = React.useRef<HTMLInputElement>(null);
  const audioFolderInputRef = React.useRef<HTMLInputElement>(null);
  const [selectedAudioIds, setSelectedAudioIds] = useState<number[]>([]);
  const [isBulkGroupDialogOpen, setIsBulkGroupDialogOpen] = useState(false);
  const [bulkGroupLabel, setBulkGroupLabel] = useState("");
  // 组别草稿:音频 id -> 组别输入值(在音频管理表格里就地编辑,保存后调 updateGroupLabels)
  const [groupLabelDraft, setGroupLabelDraft] = useState<Record<number, string>>({});

  React.useEffect(() => {
    setSelectedAudioIds([]);
    setGroupLabelDraft({});
    setIsBulkGroupDialogOpen(false);
    setBulkGroupLabel("");
    setIsBackgroundDialogOpen(false);
    setBackgroundDraft("");
  }, [questionnaireId]);

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
  const availableDimensionGroups = React.useMemo(() => Array.from(new Set(
    (audioData?.audios ?? [])
      .filter(audio => audio.modelName !== "__reference__")
      .map(audio => audio.groupLabel?.trim() || "")
      .filter(Boolean)
  )).sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true })), [audioData?.audios]);
  const audioResponseCount = audioData?.responseCount || 0;
  const emptyGroupAudios = questionnaireAudios.filter(audio => !audio.groupLabel?.trim());
  const selectedAudioIdSet = new Set(selectedAudioIds);
  const selectedAudios = questionnaireAudios.filter(audio => selectedAudioIdSet.has(audio.id));
  const hasUnsavedGroupLabels = questionnaireAudios.some(audio =>
    (groupLabelDraft[audio.id] ?? audio.groupLabel ?? "").trim() !== (audio.groupLabel ?? "")
  );

  const { mutateAsync: addAudioAsync, isPending: isAddingAudio } =
    trpc.audio.addToQuestionnaire.useMutation({
      onError: (error) => toast.error(error.message || "添加失败"),
    });

  const { mutate: removeAudio, isPending: isRemovingAudio } =
    trpc.audio.removeFromQuestionnaire.useMutation({
      onSuccess: () => {
        toast.success("音频已移除，请重新点击「生成盲测配对」");
        setSelectedAudioIds([]);
        refetchAudios();
        refetchResponses();
      },
      onError: (error) => toast.error(error.message || "移除失败"),
    });

  // 保存组别:批量把表格中就地编辑的组别写回音频记录(不触发配对)
  const { mutate: saveGroupLabels, isPending: isSavingGroups } =
    trpc.audio.updateGroupLabels.useMutation({
      onSuccess: async (_result, variables) => {
        toast.success("组别已保存，可点击「生成盲测配对」");
        await refetchAudios();
        setGroupLabelDraft(previous => {
          const next = { ...previous };
          for (const item of variables.items) delete next[item.audioFileId];
          return next;
        });
      },
      onError: (error) => toast.error(error.message || "保存组别失败"),
    });

  const { mutate: fillFilenameGroups, isPending: isFillingFilenameGroups } =
    trpc.audio.fillMissingGroupLabels.useMutation({
      onSuccess: async result => {
        toast.success(result.updatedCount ? `已按文件名补齐 ${result.updatedCount} 个音频的组别` : "没有需要补齐的空组别");
        await refetchAudios();
        setGroupLabelDraft({});
      },
      onError: error => toast.error(error.message || "补齐组别失败"),
    });
  const isEditingGroups = isSavingGroups || isFillingFilenameGroups;

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

  // 上传"音色相似度"参考音频:独立文件上传通道,写入 audioFiles 并以 modelName='__reference__' 标记
  const { mutateAsync: uploadReferenceAudioAsync } =
    trpc.dimension.uploadReferenceAudio.useMutation();

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
    // 后端已停止在 update 时依据评分标准重建维度，这里只是纯文本存档
    updateStandard({ id: questionnaireId, scoringStandard: standardDraft });
  };

  const { mutate: updateBackground, isPending: isUpdatingBackground } =
    trpc.questionnaire.update.useMutation({
      onSuccess: async () => {
        await refetchQuestionnaire();
        setIsBackgroundDialogOpen(false);
        toast.success("测评背景已更新");
      },
      onError: error => toast.error(error.message || "测评背景保存失败，请重试"),
    });

  const handleSaveBackground = () => {
    if (isUpdatingBackground) return;
    const evaluationCopywriting = backgroundDraft.trim();
    if (!evaluationCopywriting) {
      toast.error("请填写测评背景");
      return;
    }
    updateBackground({ id: questionnaireId, evaluationCopywriting });
  };

  // 保存发放组数(抽样):留空/0 表示发放全部组，>0 表示每位答卷人随机抽取该数量的组别
  const handleSaveSampleSize = () => {
    const trimmed = sampleSizeDraft.trim();
    let sampleSize: number | null = null;
    if (trimmed !== "") {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        toast.error("请输入非负整数");
        return;
      }
      sampleSize = parsed;
    }
    updateStandard(
      { id: questionnaireId, sampleSize },
      {
        onSuccess: () => {
          toast.success(sampleSize && sampleSize > 0 ? `已设为随机抽取 ${sampleSize} 组` : "已设为发放全部组");
          setIsSampleDialogOpen(false);
          refetchQuestionnaire();
        },
      }
    );
  };

  const resetDimensionForm = () => {
    setScoringConfig({ mode: "gsb" });
    setDimensionName("");
    setDimensionDescription("");
    setDimensionWeight("1");
    setDimensionMaxScore("10");
    setDimensionType("normal");
    setReferenceAudioFileId(null);
    setReferenceAudioFileName("");
    setReferenceAudioUploading(false);
    setTargetGroupLabels([]);
    setEmotionCategories([]);
    setEditingDimensionId(null);
  };

  const handleSaveDimension = () => {
    const parsedScoring = scoringConfigSchema.safeParse(scoringConfig);
    if (!parsedScoring.success) {
      toast.error(parsedScoring.error.issues[0].message);
      return;
    }
    if (!dimensionName.trim()) {
      toast.error("请输入维度名称");
      return;
    }

    // 相似度维度：必须选择参考音频与至少一个目标组别
    if (dimensionType === "similarity") {
      if (!referenceAudioFileId) {
        toast.error("音色相似度维度必须选择参考音频");
        return;
      }
      if (!targetGroupLabels.length) {
        toast.error("音色相似度维度必须选择至少一个目标组别");
        return;
      }
    }

    const categories = emotionCategories.map(category => ({ ...category, name: category.name.trim() }));
    if (dimensionType === "emotion_accuracy") {
      if (!categories.length || categories.some(category => !category.name || !category.groupLabels.length)) {
        toast.error("请为每个情绪类别填写名称并选择至少一个音频组别");
        return;
      }
      if (new Set(categories.map(category => category.name)).size !== categories.length) {
        toast.error("情绪类别名称不能重复");
        return;
      }
      const labels = categories.flatMap(category => category.groupLabels);
      if (new Set(labels).size !== labels.length) {
        toast.error("每个音频组别只能指定一种目标情绪");
        return;
      }
    }

    const payload: any = {
      dimensionName,
      description: dimensionDescription || undefined,
      weight: parseFloat(dimensionWeight),
      maxScore: parseFloat(dimensionMaxScore),
      dimensionType,
      referenceAudioFileId: dimensionType === "similarity" ? referenceAudioFileId : null,
      targetGroupLabels: dimensionType === "similarity" ? targetGroupLabels : [],
      emotionCategories: dimensionType === "emotion_accuracy" ? categories : undefined,
      scoringConfig: parsedScoring.data,
    };

    if (editingDimensionId) {
      updateDimension({ id: editingDimensionId, ...payload });
    } else {
      createDimension({
        questionnaireId,
        ...payload,
        orderIndex: (dimensions?.length || 0) + 1,
      });
    }
  };

  const handleEditDimension = (dimension: any) => {
    setScoringConfig(getScoringConfig(dimension));
    setEditingDimensionId(dimension.id);
    setDimensionName(dimension.dimensionName);
    setDimensionDescription(dimension.description || "");
    setDimensionWeight(String(dimension.weight));
    setDimensionMaxScore(String(dimension.maxScore));
    setDimensionType((dimension.dimensionType as "normal" | "similarity" | "emotion_accuracy" | "other") || "normal");
    setReferenceAudioFileId(dimension.referenceAudioFileId ?? null);
    // 参考音频文件名回显:优先从 dimension 关联对象取,否则查 questionnaireAudios(含参考音频)。
    // 由于 questionnaireAudios 默认过滤参考音频,这里通过 fileName 兜底为空;编辑时如已选参考音频将显示 ID 占位。
    // 注:实际业务下参考音频独立上传后不会出现在此列表,编辑态如需显示文件名建议后端在 dimension 关联参考音频对象。
    setReferenceAudioFileName(dimension.referenceAudioFile?.fileName || "");
    setReferenceAudioUploading(false);
    // 后端 targetGroupLabels 存的是 JSON 字符串
    let groups: string[] = [];
    if (Array.isArray(dimension.targetGroups)) {
      groups = dimension.targetGroups;
    } else if (typeof dimension.targetGroupLabels === "string") {
      try {
        const parsed = JSON.parse(dimension.targetGroupLabels);
        if (Array.isArray(parsed)) groups = parsed.filter((v: any) => typeof v === "string");
      } catch { /* ignore */ }
    }
    setTargetGroupLabels(groups);
    setEmotionCategories(getEmotionCategories(dimension.emotionCategories).map(category => ({ ...category, groupLabels: [...category.groupLabels] })));
    setIsDimensionDialogOpen(true);
  };

  const handleDeleteDimension = (dimensionId: number) => {
    if (confirm("确定要删除这个维度吗？")) {
      deleteDimension({ id: dimensionId });
    }
  };

  // 独立上传参考音频:与音频管理的批量上传隔离,只做单文件,成功后即回填 referenceAudioFileId
  const handleReferenceAudioSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (referenceAudioInputRef.current) referenceAudioInputRef.current.value = "";
    if (!questionnaireId) {
      toast.error("请先保存问卷");
      return;
    }
    setReferenceAudioUploading(true);
    try {
      const payload = await readAudioForUpload(file);
      const res = await uploadReferenceAudioAsync({ questionnaireId, ...payload });
      setReferenceAudioFileId(res.audioFileId);
      setReferenceAudioFileName(res.fileName);
      toast.success("参考音频上传成功");
    } catch (err: any) {
      toast.error(err?.message || "参考音频上传失败");
    } finally {
      setReferenceAudioUploading(false);
    }
  };

  const handleSelectFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added = Array.from(files).map((file) => ({ file, modelName: "", groupLabel: deriveGroupLabel(file.name) }));
    setPendingAudios((prev) => [...prev, ...added]);
    if (audioInputRef.current) audioInputRef.current.value = "";
  };

  // 选择文件夹:递归挑出所有音频文件,顶层文件夹名做为默认模型名(可逐项覆盖)。
  // 与 AdminDashboard.handleFolderSelected 保持一致,便于同名文件按组别自动配对。
  const isAudioLike = (f: File) => {
    if (f.type && f.type.startsWith("audio/")) return true;
    const n = f.name.toLowerCase();
    return n.endsWith(".mp3") || n.endsWith(".wav") || n.endsWith(".m4a") || n.endsWith(".flac") || n.endsWith(".ogg") || n.endsWith(".aac");
  };
  const handleSelectFolder = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const audioFiles = Array.from(files).filter(isAudioLike);
    if (audioFiles.length === 0) {
      toast.error("该文件夹内没有音频文件");
      if (audioFolderInputRef.current) audioFolderInputRef.current.value = "";
      return;
    }
    const rel = (audioFiles[0] as unknown as { webkitRelativePath?: string }).webkitRelativePath;
    const defaultModel = rel ? rel.split("/")[0] : "";
    const added = audioFiles.map((file) => ({ file, modelName: defaultModel, groupLabel: deriveGroupLabel(file.name) }));
    setPendingAudios((prev) => [...prev, ...added]);
    toast.success(`已从文件夹添加 ${added.length} 个音频，模型名默认为「${defaultModel || "(请填写)"}」`);
    if (audioFolderInputRef.current) audioFolderInputRef.current.value = "";
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

  // 新增音频:待批处理列表全部选好并填好模型名后,拆成单文件请求 + 客户端窗口并发上传
  // (每个请求体只带一个音频,不触碰 JDOS ingress 1MB 上限;并发窗口=4 消除串行 RTT 累加)
  const UPLOAD_CONCURRENCY = 4;
  const [addAudioProgress, setAddAudioProgress] = useState<{ done: number; total: number } | null>(null);
  const handleAddAudio = async () => {
    if (pendingAudios.length === 0) {
      toast.error("请先选择音频文件");
      return;
    }
    if (pendingAudios.some((it) => !it.modelName.trim())) {
      toast.error("请为每个待上传音频填写模型名称");
      return;
    }
    setAddAudioProgress({ done: 0, total: pendingAudios.length });
    try {
      const items = pendingAudios.map((it) => ({
        file: it.file,
        modelName: it.modelName.trim(),
        groupLabel: it.groupLabel.trim(),
      }));
      const uploadOne = async (it: { file: File; modelName: string; groupLabel?: string }) => {
        const base = await readAudioForUpload(it.file);
        await addAudioAsync({
          questionnaireId,
          audios: [{ ...base, modelName: it.modelName, groupLabel: it.groupLabel }],
        });
      };
      let cursor = 0;
      let doneCount = 0;
      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= items.length) return;
          await uploadOne(items[idx]);
          doneCount++;
          setAddAudioProgress({ done: doneCount, total: items.length });
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, items.length) }, () => worker())
      );
      toast.success("音频已添加，请设置组别后点击「生成盲测配对」");
      setPendingAudios([]);
      if (audioInputRef.current) audioInputRef.current.value = "";
      refetchAudios();
      refetchResponses();
    } catch (e: any) {
      toast.error(e?.message || "文件读取或上传失败");
    } finally {
      setAddAudioProgress(null);
    }
  };

  const toggleAudioSelect = (audioFileId: number) => {
    setSelectedAudioIds((prev) =>
      prev.includes(audioFileId) ? prev.filter((id) => id !== audioFileId) : [...prev, audioFileId]
    );
  };

  // 批量移除:勾选成组音频后统一移除(不自动配对,需管理员再手动生成)
  const handleRemoveSelected = () => {
    if (selectedAudios.length === 0) {
      toast.error("请先勾选要移除的音频");
      return;
    }
    if (confirm(`确定移除选中的 ${selectedAudios.length} 个音频吗？移除后请重新生成盲测配对。`)) {
      removeAudio({ questionnaireId, audioFileIds: selectedAudios.map(audio => audio.id) });
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

  const handleOpenBulkGroupEditor = () => {
    const labels = selectedAudios.map(audio =>
      (groupLabelDraft[audio.id] ?? audio.groupLabel ?? "").trim()
    );
    setBulkGroupLabel(labels.every(label => label === labels[0]) ? labels[0] ?? "" : "");
    setIsBulkGroupDialogOpen(true);
  };

  const handleFillFilenameGroups = () => {
    if (!questionnaire) return;
    if (hasUnsavedGroupLabels) {
      toast.error("请先保存表格中的组别修改，再补齐空组别");
      return;
    }
    if (confirm(`将为「${questionnaire.title}」的 ${emptyGroupAudios.length} 个空组别音频，按文件名（去掉扩展名）补齐组别。已有组别保持不变，不重建配对、不清空答卷。确定继续？`)) {
      fillFilenameGroups({ questionnaireId });
    }
  };

  const handleSaveBulkGroupLabels = () => {
    if (!selectedAudios.length) {
      toast.error("请先勾选要编辑组别的音频");
      return;
    }
    const groupLabel = bulkGroupLabel.trim();
    if (groupLabel.length > 255) {
      toast.error("组别不能超过 255 个字符");
      return;
    }
    saveGroupLabels({
      questionnaireId,
      items: selectedAudios.map(audio => ({ audioFileId: audio.id, groupLabel })),
    }, {
      onSuccess: () => {
        setIsBulkGroupDialogOpen(false);
        setSelectedAudioIds([]);
      },
    });
  };

  // 生成盲测配对:显式重建(会清空已有答卷),先保存当前组别再生成
  const handleGeneratePairs = () => {
    if (hasUnsavedGroupLabels) {
      toast.error("请先保存组别修改，再生成盲测配对");
      return;
    }
    const msg = audioResponseCount > 0
      ? `该问卷已有 ${audioResponseCount} 份答卷，重新生成配对会清空已有答卷数据，确定继续？`
      : "将按当前音频组别生成盲测配对（同组内不同模型两两配对）。确定继续？";
    if (confirm(msg)) {
      generatePairs({ questionnaireId });
    }
  };

  // Calculate statistics
  const responseSummary = summarizeResponses(responses ?? []);
  const { totalResponses, completedResponses, inProgressResponses } = responseSummary;
  const completionRate = responseSummary.completionRate.toFixed(1);

  // 维度 id -> 名称映射,用于在答卷详情里展示每个维度的选择
  const dimensionNameMap = new Map<number, string>(
    (dimensions || []).map((d: any) => [d.id, d.dimensionName])
  );
  // 盲测配对 id -> 左右模型信息映射,把"左/右更好"翻译为具体模型的优劣
  const pairInfoMap = new Map<number, any>(
    (pairsInfo || []).map((p: any) => [p.id, p])
  );
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
      if (response.subQuestionnaireIndex != null) rows.push({ 配对: "分配子问卷", 维度: `子问卷 ${response.subQuestionnaireIndex}`, 选择结果: "" });
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
        const groupTitle = formatResponsePairAudioLabel(pair);
        for (const a of group.answers) {
          rows.push({
            配对: groupTitle,
            维度: a.evaluationDimensionId
              ? dimensionNameMap.get(a.evaluationDimensionId) || `维度#${a.evaluationDimensionId}`
              : "评价",
            选择结果: formatAudioEvaluation(a.audioEvaluation) || verdictLabel(pair, a.blindTestChoice),
            组别: pair?.groupLabel || "",
            配对ID: group.pairId,
            维度ID: a.evaluationDimensionId ?? "",
            音频A文件名: pair?.leftFileName || "",
            音频AID: pair?.leftAudioFileId ?? "",
            音频A模型: pair?.leftModelName || "",
            音频A分值: a.audioEvaluation?.leftScore ?? "",
            音频A观察: a.audioEvaluation?.leftText ?? "",
            音频B文件名: pair?.rightFileName || "",
            音频BID: pair?.rightAudioFileId ?? "",
            音频B模型: pair?.rightModelName || "",
            音频B分值: a.audioEvaluation?.rightScore ?? "",
            音频B观察: a.audioEvaluation?.rightText ?? "",
          });
        }
      }

      const ws = XLSX.utils.json_to_sheet(rows, { header: ["配对", "维度", "选择结果"] });
      ws["!cols"] = Array.from({ length: 17 }, (_, index) => ({ wch: index === 0 || index === 2 ? 60 : 24 }));
      XLSX.utils.book_append_sheet(wb, ws, safeSheetName(response.visitorName, idx));
    });

    const ruleRows = (dimensions || []).flatMap(dimension => {
      const config = getScoringConfig(dimension);
      const base = { 维度ID: dimension.id, 维度: dimension.dimensionName, 方法: config.mode };
      return config.mode === "numeric"
        ? config.rules.map(rule => ({ ...base, 分值: rule.score as number | string, 判定规则: rule.description }))
        : [{ ...base, 分值: "", 判定规则: config.mode === "text" ? `${config.required ? "必填" : "选填"}：${config.prompt}` : "左边更好 / 差不多 / 右边更好" }];
    });
    const rulesSheet = XLSX.utils.json_to_sheet(ruleRows);
    rulesSheet["!cols"] = [{ wch: 12 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, rulesSheet, safeSheetName("评分规则", responses.length));
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
        <Card className="mb-6">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle className="text-lg">测评背景</CardTitle>
              <CardDescription>向答卷人说明本次测评的背景、目的和评估要求。</CardDescription>
            </div>
            <Dialog
              open={isBackgroundDialogOpen}
              onOpenChange={open => {
                if (isUpdatingBackground) return;
                if (open) setBackgroundDraft(questionnaire.evaluationCopywriting || "");
                setIsBackgroundDialogOpen(open);
              }}
            >
              <DialogTrigger asChild>
                <Button variant="outline" className="shrink-0">
                  <Edit2 className="w-4 h-4 mr-2" />
                  编辑测评背景
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>编辑测评背景</DialogTitle>
                  <DialogDescription>
                    保存后，答卷人下次打开或刷新问卷时将看到新背景。不会修改评分维度、音频、配对或已有答卷。
                  </DialogDescription>
                </DialogHeader>
                <form
                  className="space-y-4"
                  onSubmit={event => {
                    event.preventDefault();
                    handleSaveBackground();
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="backgroundDraft">测评背景</Label>
                    <Textarea
                      id="backgroundDraft"
                      placeholder="描述此次盲测的背景、目的和评估要求..."
                      className="min-h-48"
                      value={backgroundDraft}
                      disabled={isUpdatingBackground}
                      required
                      onChange={event => setBackgroundDraft(event.target.value)}
                    />
                    <p className="text-xs text-slate-500">支持多行文字，测评背景不能为空。</p>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" disabled={isUpdatingBackground} onClick={() => setIsBackgroundDialogOpen(false)}>
                      取消
                    </Button>
                    <Button
                      type="submit"
                      disabled={isUpdatingBackground || !backgroundDraft.trim() || backgroundDraft.trim() === (questionnaire.evaluationCopywriting || "").trim()}
                    >
                      {isUpdatingBackground ? "保存中..." : "保存背景"}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent>
            {questionnaire.evaluationCopywriting?.trim() ? (
              <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">
                {questionnaire.evaluationCopywriting}
              </p>
            ) : (
              <p className="text-sm text-slate-500">暂未填写测评背景，可点击「编辑测评背景」补充。</p>
            )}
          </CardContent>
        </Card>
        <Tabs defaultValue="dimensions" className="space-y-6">
          <TabsList className="flex h-auto w-full max-w-2xl flex-wrap justify-start">
            <TabsTrigger value="dimensions">测评维度</TabsTrigger>
            <TabsTrigger value="audios">音频管理</TabsTrigger>
            <TabsTrigger value="distribution">分组发放</TabsTrigger>
            <TabsTrigger value="progress">填写进展</TabsTrigger>
            <TabsTrigger value="responses">答卷详情</TabsTrigger>
          </TabsList>
          <TabsContent value="distribution"><SubQuestionnaireDistribution questionnaireId={questionnaireId} published={questionnaire.status === "published"} onChange={() => refetchQuestionnaire()} /></TabsContent>

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
                        评分标准将作为参考文本存档，不再自动覆盖维度。请前往「测评维度」手动新增或调整评分维度。
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
                          {isUpdatingStandard ? "保存中..." : "保存"}
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
                <Dialog open={isSampleDialogOpen} onOpenChange={setIsSampleDialogOpen}>
                  <DialogTrigger asChild>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setSampleSizeDraft(
                          questionnaire?.sampleSize ? String(questionnaire.sampleSize) : ""
                        )
             }
                    >
                      发放组数
                      {questionnaire?.subQuestionnairePlan ? "（固定子问卷）" : questionnaire?.sampleSize ? `（抽 ${questionnaire.sampleSize} 组）` : "（全部）"}
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle>设置发放组数</DialogTitle>
                      <DialogDescription>
                        {questionnaire.subQuestionnairePlan != null && "当前已启用固定子问卷，请在「分组发放」中查看和管理；此处不能改为随机抽样。"}
                        设定每位答卷人随机测评的组别数量。留空或填 0 表示发放全部组；填写正整数则每人随机抽取该数量的组（同一人固定，可断点续答）。超出总组数时自动按全部发放。
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="sampleSizeDraft">发放组数</Label>
                        <Input
                          id="sampleSizeDraft"
                          type="number"
                          min={0}
                          step={1}
                          placeholder="留空或 0 = 发放全部组"
                          value={sampleSizeDraft}
                          onChange={(e) => setSampleSizeDraft(e.target.value)}
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" onClick={() => setIsSampleDialogOpen(false)}>
                          取消
                        </Button>
                        <Button
                          className="bg-blue-600 hover:bg-blue-700"
                          disabled={isUpdatingStandard || !!questionnaire.subQuestionnairePlan}
                          onClick={handleSaveSampleSize}
                        >
                          {isUpdatingStandard ? "保存中..." : "保存"}
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
                <Dialog open={isDimensionDialogOpen} onOpenChange={setIsDimensionDialogOpen}>
                <DialogTrigger asChild>
                  <Button
                    className="bg-blue-600 hover:bg-blue-700"
                    disabled={questionnaire.status === "published" || (responses?.length ?? 0) > 0}
                    onClick={() => resetDimensionForm()}
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    添加维度
                  </Button>
                </DialogTrigger>
                <DialogContent className="flex h-[min(820px,90dvh)] max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
                  <DialogHeader className="shrink-0 border-b px-6 py-4 pr-12">
                    <DialogTitle>
                      {editingDimensionId ? "编辑维度" : "添加新维度"}
                    </DialogTitle>
                  <DialogDescription>支持 GSB、量化打分和「其他」开放文本；发布或产生答卷后，评分维度不可修改。</DialogDescription>
                  </DialogHeader>

                  <ScrollArea type="always" className="min-h-0 flex-1">
                  <div className="min-w-0 space-y-4 p-6">
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


                    {/* 维度类型：普通 / 音色相似度 / 情绪准确度，特殊维度按组别配置 */}
                    <div className="space-y-2">
                      <Label>维度类型</Label>
                      <Select
                        value={dimensionType}
                        onValueChange={(v) => {
                          const next = v as "normal" | "similarity" | "emotion_accuracy" | "other";
                          setDimensionType(next);
                          if (next === "other") {
                            if (!dimensionName.trim()) setDimensionName("其他");
                            setScoringConfig({ mode: "text", prompt: "请描述该音频的表现、异常片段或改进建议。", required: false });
                          } else if (scoringConfig.mode === "text") setScoringConfig({ mode: "gsb" });
                          if (next === "emotion_accuracy") {
                            if (!dimensionName.trim()) setDimensionName("情绪准确度");
                            if (!dimensionDescription.trim()) setDimensionDescription("判断哪段音频更准确地表达指定的目标情绪。");
                            if (!emotionCategories.length) setEmotionCategories([{ name: "", groupLabels: [] }]);
                          }
                          if (next === "normal") {
                            setReferenceAudioFileId(null);
                            setReferenceAudioFileName("");
                            setTargetGroupLabels([]);
                          }
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="选择维度类型" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="normal">普通评分维度</SelectItem>
                          <SelectItem value="similarity">音色相似度（需参考音频+目标组别）</SelectItem>
                          <SelectItem value="emotion_accuracy">情绪准确度（情绪类别+音频组别）</SelectItem>
                          <SelectItem value="other">其他（开放文本，用于自然语言分析）</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <ScoringConfigEditor value={scoringConfig} onChange={setScoringConfig} textOnly={dimensionType === "other"} />
                    {dimensionType === "emotion_accuracy" && (
                      <div className="space-y-3">
                        <Label>情绪类别与音频组别 *</Label>
                        <p className="text-xs text-slate-500">可自定义开心、悲伤、愤怒等类别，每个组别只能对应一种目标情绪。仅在指定组别的题目上展示。</p>
                        {emotionCategories.map((category, index) => {
                          const assignedElsewhere = new Map(emotionCategories.flatMap((item, otherIndex) =>
                            otherIndex === index ? [] : item.groupLabels.map(label => [label, item.name.trim() || `情绪类别 ${otherIndex + 1}`] as const)
                          ));
                          return (
                            <div key={index} className="rounded-md border p-3 space-y-3">
                              <div className="flex gap-2">
                                <Input aria-label={`情绪类别 ${index + 1}`} placeholder="输入情绪类别，如开心" value={category.name}
                                  onChange={event => setEmotionCategories(prev => prev.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} />
                                <Button type="button" variant="outline" onClick={() => setEmotionCategories(prev => prev.filter((_, i) => i !== index))}>移除</Button>
                              </div>
                              <GroupLabelPicker
                                label={`情绪类别 ${index + 1} 组别`}
                                availableLabels={availableDimensionGroups}
                                selectedLabels={category.groupLabels}
                                assignedElsewhere={assignedElsewhere}
                                disabled={isCreatingDimension || isUpdatingDimension}
                                onChange={groupLabels => setEmotionCategories(prev => prev.map((item, itemIndex) =>
                                  itemIndex === index ? { ...item, groupLabels } : item
                                ))}
                              />
                            </div>
                          );
                        })}
                        <Button type="button" variant="outline" onClick={() => setEmotionCategories(prev => [...prev, { name: "", groupLabels: [] }])}>添加情绪类别</Button>
                      </div>
                    )}

                    {dimensionType === "similarity" && (
                      <>
                        <div className="space-y-2">
                          <Label>参考音频 *</Label>
                          <div className="flex items-center gap-2">
                            <input
                              ref={referenceAudioInputRef}
                              type="file"
                              accept="audio/*,.m4a"
                              className="hidden"
                              onChange={(e) => handleReferenceAudioSelect(e.target.files)}
                            />
                            <Button
                        type="button"
                              variant="outline"
                              disabled={referenceAudioUploading}
                              onClick={() => referenceAudioInputRef.current?.click()}
                            >
                              {referenceAudioUploading
                                ? "上传中..."
                                : referenceAudioFileId
                                ? "重新上传"
                                : "上传参考音频"}
                            </Button>
                            <div className="text-sm text-slate-600 truncate">
                              {referenceAudioFileName
                                ? referenceAudioFileName
                                : referenceAudioFileId
                                ? `已选参考音频 #${referenceAudioFileId}`
                                : "尚未上传"}
                            </div>
                          </div>
                          <p className="text-xs text-slate-500">
                            参考音频将独立存储,不进入音频管理列表,也不参与盲测配对。
                          </p>
                        </div>

                        <div className="space-y-2">
                          <Label>目标组别 *（只在包含以下组别的盲测题上展示）</Label>
                          <GroupLabelPicker
                            label="音色相似度目标组别"
                            availableLabels={availableDimensionGroups}
                            selectedLabels={targetGroupLabels}
                            onChange={setTargetGroupLabels}
                            disabled={isCreatingDimension || isUpdatingDimension}
                          />
                        </div>
                      </>
                    )}

                  </div>
                  </ScrollArea>
                    <div className="flex shrink-0 gap-2 border-t bg-white px-6 py-4">
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
                </DialogContent>
              </Dialog>
              </div>
            </div>

            {(questionnaire.status === "published" || (responses?.length ?? 0) > 0) && <p className="text-sm text-amber-700">评分维度已锁定。无答卷时可取消发布后修改；已有答卷请复制问卷后配置新规则。</p>}
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
                          <CardTitle className="text-lg">
                            {dimension.dimensionName}
                            <span className="ml-2 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium">{getScoringConfig(dimension).mode === "numeric" ? "量化打分 · A/B 独立" : getScoringConfig(dimension).mode === "text" ? "开放文本" : "GSB"}</span>
                            {dimension.dimensionType === "emotion_accuracy" && (
                              <span className="ml-2 inline-block rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">情绪准确度</span>
                            )}
                            {dimension.dimensionType === "similarity" && (
                              <span className="ml-2 inline-block rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 align-middle">
                                音色相似度
                              </span>
                            )}
                          </CardTitle>
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
                            aria-label={`编辑维度 ${dimension.dimensionName}`}
                            onClick={() => handleEditDimension(dimension)}
                            disabled={questionnaire.status === "published" || (responses?.length ?? 0) > 0}
                          >
                            <Edit2 className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleDeleteDimension(dimension.id)}
                            disabled={questionnaire.status === "published" || (responses?.length ?? 0) > 0}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-6 text-sm">
                        <ScoringConfigSummary dimension={dimension} />
                        {dimension.dimensionType === "emotion_accuracy" && (
                          <div className="space-y-1">
                            {getEmotionCategories(dimension.emotionCategories).map(category => (
                              <div key={category.name}><span className="font-medium">{category.name}：</span>{category.groupLabels.join("、")}</div>
                            ))}
                          </div>
                        )}
                        {dimension.dimensionType === "similarity" && (
                          <>
                            <div>
                              <span className="text-slate-600">参考音频：</span>
                              <span className="font-medium">
         {(() => {
                                  // 优先用后端 join 返回的 referenceAudioFile;老数据兼容:再查一次 questionnaireAudios
                                  if (dimension.referenceAudioFile?.fileName) return dimension.referenceAudioFile.fileName;
                                  const ref = questionnaireAudios.find((a: any) => a.id === dimension.referenceAudioFileId);
                                  return ref ? `${ref.fileName}${ref.modelName ? `（${ref.modelName}）` : ""}` : `#${dimension.referenceAudioFileId ?? "-"}`;
                                })()}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-600">目标组别：</span>
                              <span className="font-medium">
                                {(() => {
                                  if (Array.isArray(dimension.targetGroups) && dimension.targetGroups.length) {
                                    return dimension.targetGroups.join("、");
                                  }
                                  try {
                                    const parsed = JSON.parse(dimension.targetGroupLabels || "[]");
                                    return Array.isArray(parsed) ? parsed.join("、") : "-";
                                  } catch { return "-"; }
                                })()}
                              </span>
                            </div>
                          </>
                        )}
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
                  <span className="text-red-600">（该问卷已有 {audioResponseCount} 份答卷，重新生成配对会清空已有答卷）</span>
                )}
              </p>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">批量新增音频</CardTitle>
                <CardDescription>选择音频后填写模型名称，组别默认取文件名（去掉扩展名），可手动修改或清空；上传后按需生成配对。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>选择音频（可多选文件，或直接选择整个文件夹）</Label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <span className="text-xs text-slate-500">选择文件</span>
                      <Input
                        ref={audioInputRef}
                        type="file"
                        multiple
                        accept="audio/*,.m4a"
                        onChange={(e) => handleSelectFiles(e.target.files)}
                      />
                    </div>
                    <div className="space-y-1">
                      <span className="text-xs text-slate-500">选择文件夹（顶层文件夹名作默认模型名）</span>
                      <Input
                        ref={audioFolderInputRef}
                        type="file"
                        multiple
                        /* @ts-expect-error webkitdirectory 为浏览器私有属性 */
                        webkitdirectory=""
                        directory=""
                        onChange={(e) => handleSelectFolder(e.target.files)}
                      />
                    </div>
                  </div>
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
                  disabled={!!addAudioProgress || isAddingAudio || pendingAudios.length === 0}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  {addAudioProgress
                    ? `上传中 ${addAudioProgress.done}/${addAudioProgress.total}...`
                    : isAddingAudio
                    ? "上传中..."
                    : `上传音频（${pendingAudios.length}）`}
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
                      已勾选 {selectedAudios.length} / {questionnaireAudios.length} 个音频
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleOpenBulkGroupEditor}
                        disabled={isEditingGroups || isGeneratingPairs || isRemovingAudio || selectedAudios.length === 0}
                      >
                        <Edit2 className="w-4 h-4 mr-1" />
                        批量编辑组别（{selectedAudios.length}）
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleFillFilenameGroups}
                        disabled={isEditingGroups || isGeneratingPairs || isRemovingAudio || hasUnsavedGroupLabels || emptyGroupAudios.length === 0}
                      >
                        {isFillingFilenameGroups ? "补齐中..." : `按文件名补齐空组别（${emptyGroupAudios.length}）`}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSaveGroupLabels}
                        disabled={isEditingGroups || isGeneratingPairs || isRemovingAudio || questionnaireAudios.length === 0}
                      >
                        {isSavingGroups ? "保存中..." : "保存组别"}
                      </Button>
                      <Button
                        size="sm"
                        className="bg-blue-600 hover:bg-blue-700"
                        onClick={handleGeneratePairs}
                        disabled={isGeneratingPairs || isEditingGroups || isRemovingAudio || hasUnsavedGroupLabels || questionnaireAudios.length === 0}
                      >
                        {isGeneratingPairs ? "生成中..." : "生成盲测配对"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-red-600 border-red-200 hover:bg-red-50"
                        onClick={handleRemoveSelected}
                        disabled={isRemovingAudio || isEditingGroups || isGeneratingPairs || selectedAudios.length === 0}
                      >
                        <Trash2 className="w-4 h-4 mr-1" />
                        {isRemovingAudio ? "移除中..." : `批量移除（${selectedAudios.length}）`}
                      </Button>
                    </div>
                  </div>
                  {hasUnsavedGroupLabels && (
                    <p className="mb-3 text-sm text-amber-700">有未保存的组别修改，请先点击「保存组别」，再生成盲测配对。</p>
                  )}
                  <Dialog
                    open={isBulkGroupDialogOpen}
                    onOpenChange={open => { if (!isSavingGroups) setIsBulkGroupDialogOpen(open); }}
                  >
                    <DialogContent className="max-w-md">
                      <DialogHeader>
                        <DialogTitle>批量编辑组别</DialogTitle>
                        <DialogDescription>
                          仅修改选中的 {selectedAudios.length} 个音频，未选音频及其未保存的修改保持不变。
                        </DialogDescription>
                      </DialogHeader>
                      <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (!isSavingGroups) handleSaveBulkGroupLabels(); }}>
                        <div className="space-y-2">
                          <Label htmlFor="bulk-group-label">统一设置组别</Label>
                          <Input
                            id="bulk-group-label"
                            placeholder="例如：query1；留空则清空组别"
                            value={bulkGroupLabel}
                            maxLength={255}
                            disabled={isSavingGroups}
                            onChange={event => setBulkGroupLabel(event.target.value)}
                          />
                          <p className="text-xs text-slate-500">最多 255 个字符。留空会清空所选音频的组别。</p>
                        </div>
                        <p className="text-sm text-amber-700">
                          保存不会自动重建配对或清空答卷。修改后请检查情绪准确度、音色相似度的组别配置，再手动生成配对；重建配对会清空已有答卷。
                        </p>
                        <div className="flex justify-end gap-2">
                          <Button type="button" variant="outline" disabled={isSavingGroups} onClick={() => setIsBulkGroupDialogOpen(false)}>取消</Button>
                          <Button type="submit" disabled={isSavingGroups || selectedAudios.length === 0}>
                            {isSavingGroups ? "保存中..." : bulkGroupLabel.trim() ? `保存所选 ${selectedAudios.length} 个音频` : `清空所选 ${selectedAudios.length} 个音频的组别`}
                          </Button>
                        </div>
                      </form>
                    </DialogContent>
                  </Dialog>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox
                            aria-label="全选音频"
                            checked={selectedAudios.length === questionnaireAudios.length ? true : selectedAudios.length > 0 ? "indeterminate" : false}
                            disabled={isEditingGroups || isGeneratingPairs || isRemovingAudio}
                            onCheckedChange={checked => setSelectedAudioIds(checked === true ? questionnaireAudios.map(audio => audio.id) : [])}
                          />
                        </TableHead>
                        <TableHead>文件名</TableHead>
                        <TableHead>模型名称</TableHead>
                        <TableHead className="w-40">组别</TableHead>
                        <TableHead>试听</TableHead>
                        <TableHead>公网链接</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {questionnaireAudios.map((audio: any) => (
                        <TableRow key={audio.id}>
                          <TableCell>
                            <Checkbox
                              aria-label={`选择音频 ${audio.fileName}`}
                              checked={selectedAudioIdSet.has(audio.id)}
                              disabled={isEditingGroups || isGeneratingPairs || isRemovingAudio}
                              onCheckedChange={() => toggleAudioSelect(audio.id)}
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
                              aria-label={`${audio.fileName} 的组别`}
                              maxLength={255}
                              disabled={isEditingGroups || isGeneratingPairs || isRemovingAudio}
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
                          <TableCell>
                            {audio.publicUrl ? (
                              <div className="flex items-center gap-1">
                                <code className="text-xs bg-slate-100 rounded px-1.5 py-0.5 max-w-[180px] truncate inline-block align-middle">
                                  {audio.publicUrl}
                                </code>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2"
                                  onClick={() => {
                                    navigator.clipboard.writeText(audio.publicUrl);
                                    toast.success("公网链接已复制");
                                  }}
                                >
                                  <Copy className="w-3.5 h-3.5" />
                                </Button>
                              </div>
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
                          <TableCell>{response.visitorName || "匿名"}{response.subQuestionnaireIndex != null && <p className="text-xs text-blue-600">子问卷 {response.subQuestionnaireIndex}</p>}</TableCell>
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
                            <div className="flex flex-wrap gap-2">
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
                              <DeleteResponseButton
                                questionnaireId={questionnaireId}
                                response={response}
                                onDeleted={() => setExpandedResponseId(current => current === response.id ? null : current)}
                              />
                            </div>
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
                                    const groupTitle = formatResponsePairAudioLabel(pair);
                                    return (
                                    <div key={group.pairId} className="border border-slate-200 rounded-lg p-3 bg-white">
                                      <p className="font-medium text-slate-800 mb-2 break-all">{groupTitle}</p>
                                      <div className="space-y-1">
                                        {group.answers.map((a: any) => (
                                          <div key={a.id} className="grid gap-2 py-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
                                            <span className="text-slate-600">
                                              {a.evaluationDimensionId
                                            ? dimensionNameMap.get(a.evaluationDimensionId) || `维度#${a.evaluationDimensionId}`
                                                : "评价"}
                                            </span>
                                            <span className="min-w-0 whitespace-pre-wrap break-words font-medium text-slate-900">
                                              {formatAudioEvaluation(a.audioEvaluation) || verdictLabel(pair, a.blindTestChoice)}
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
