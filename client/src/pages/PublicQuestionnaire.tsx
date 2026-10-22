import { useState, useRef, useEffect, useMemo } from "react";
import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { getEmotionCategories, isDimensionApplicable } from "@shared/evaluationDimensions";
import { getScoringConfig, isScoringAnswerComplete, type EvaluationAnswerValue, type AudioEvaluation } from "@shared/scoring";
import { ScoringAnswerFields } from "@/components/ScoringAnswerFields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { Play, Pause, Volume2, Loader2, CheckCircle2 } from "lucide-react";

type BlindTestChoice = "left_better" | "same" | "right_better";

// 获取/生成浏览器级稳定标识,持久化在 localStorage。用于区分同一 IP 下的不同访客,
// 使"复用未提交记录 / 清理残留 in_progress"按浏览器而非按 IP 生效。
function getVisitorToken(): string {
  const KEY = "audio_eval_visitor_token";
  try {
    let token = localStorage.getItem(KEY);
    if (!token) {
      token =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(KEY, token);
    }
    return token;
  } catch {
    // localStorage 不可用(隐私模式等)时降级:返回空串,后端将回退为每次新建、不复用不清理
    return "";
  }
}

interface PairAnswer {
  blindTestPairId: number;
  choices: Record<number, EvaluationAnswerValue>;
}

// 断点续答:按 responseId 在 localStorage 记住当前 pair 指针,关闭浏览器后再回来能定位到上次位置
const PAIR_IDX_KEY_PREFIX = "audio_eval_pair_idx_";
function loadSavedPairIndex(responseId: number): number | null {
  try {
    const raw = localStorage.getItem(`${PAIR_IDX_KEY_PREFIX}${responseId}`);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
function savePairIndex(responseId: number, idx: number) {
  try { localStorage.setItem(`${PAIR_IDX_KEY_PREFIX}${responseId}`, String(idx)); } catch { /* ignore */ }
}
function clearPairIndex(responseId: number) {
  try { localStorage.removeItem(`${PAIR_IDX_KEY_PREFIX}${responseId}`); } catch { /* ignore */ }
}

export default function PublicQuestionnaire() {
  const { shareToken } = useParams();
  const [visitorName, setVisitorName] = useState("");
  const [visitorToken] = useState(() => getVisitorToken() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
  const [subQuestionnaireIndex, setSubQuestionnaireIndex] = useState<number | null>(null);
  const [hasStarted, setHasStarted] = useState(false);
  const [responseId, setResponseId] = useState<number | null>(null);
  const [currentPairIndex, setCurrentPairIndex] = useState(0);
  const [pairAnswers, setPairAnswers] = useState<PairAnswer[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  // 服务端返回的已答快照,等 questionnaire 数据到齐后水合进 pairAnswers
  const [savedAnswersSnapshot, setSavedAnswersSnapshot] = useState<Array<{
    blindTestPairId: number | null;
    evaluationDimensionId: number | null;
    blindTestChoice: string | null;
    audioEvaluation?: AudioEvaluation | null;
  }> | null>(null);
  // 断点续答需要"数据加载完成后再跳转"到 savedIdx,避免 questionnaire 还没到就被裁剪掉
  const [pendingResumeIndex, setPendingResumeIndex] = useState<number | null>(null);

  // 抽样发放:startPublic 返回该答卷锚定的抽样组别子集(null = 未抽样,发放全部组)。
  const [sampledGroupLabels, setSampledGroupLabels] = useState<string[] | null>(null);

  // Audio player state
  const [leftPlaying, setLeftPlaying] = useState(false);
  const [rightPlaying, setRightPlaying] = useState(false);
  const [leftProgress, setLeftProgress] = useState(0);
  const [rightProgress, setRightProgress] = useState(0);
  const [leftDuration, setLeftDuration] = useState(0);
  const [rightDuration, setRightDuration] = useState(0);
  const [leftCurrentTime, setLeftCurrentTime] = useState(0);
  const [rightCurrentTime, setRightCurrentTime] = useState(0);
  const leftAudioRef = useRef<HTMLAudioElement>(null);
  const rightAudioRef = useRef<HTMLAudioElement>(null);

  // Fetch questionnaire data
  const { data: questionnaire, isLoading, error } = trpc.questionnaire.getByShareToken.useQuery(
    { shareToken: shareToken || "", ...(subQuestionnaireIndex != null && responseId != null ? { responseId, visitorToken } : {}) },
    { enabled: !!shareToken }
  );

  // 抽样发放:实际参与答题的 pairs 集合。未抽样(sampledGroupLabels=null)时为全部;
  // 抽样时仅保留抽中组别(groupLabel)内的 pairs。pairAnswers/进度/提交/导航/渲染统一以此为准,
  // 避免只在展示层过滤导致 index 与 pairAnswers 错位。
  const visiblePairs = useMemo(() => {
    const all = (questionnaire?.blindTestPairs || []) as any[];
    if (!sampledGroupLabels || sampledGroupLabels.length === 0) return all;
    const set = new Set(sampledGroupLabels);
    return all.filter((p: any) => set.has((p?.groupLabel || "").trim()));
  }, [questionnaire?.blindTestPairs, sampledGroupLabels]);

  // Start response mutation
  const startMutation = trpc.response.startPublic.useMutation({
    onSuccess: (data) => {
      setResponseId(data.responseId);
      setSubQuestionnaireIndex("subQuestionnaireIndex" in data ? data.subQuestionnaireIndex ?? null : null);
      setHasStarted(true);
      // 抽样发放:锚定后端返回的组别子集(可能为 null=全部)。后续 pairs 全部按此过滤。
      setSampledGroupLabels(data.sampledGroupLabels ?? null);
      // 断点续答:后端返回该 response 之前中途保存过的 answers 快照,先存下来,
      // 等 questionnaire.blindTestPairs 到位的 useEffect 里再水合进 pairAnswers。
      setSavedAnswersSnapshot(data.savedAnswers ?? []);
      // localStorage 记录的 pair 指针也在此暂存,等 pairs 到齐后再 clamp 到合法范围
      const saved = loadSavedPairIndex(data.responseId);
      if (saved !== null) setPendingResumeIndex(saved);
      if ((data.savedAnswers?.length ?? 0) > 0 || saved !== null) {
        toast.success("已为你恢复上次的作答进度");
      }
    },
    onError: (err) => {
      toast.error(err.message || "开始测评失败");
    },
  });

  // 中途保存作答进度(节流触发,与最终提交共享 answers 表的 upsert 快照语义)
  const saveProgressMutation = trpc.response.saveProgressPublic.useMutation({
    scope: { id: "public-questionnaire-autosave" },
    onSuccess: () => { toast.dismiss("autosave-failed"); },
    onError: (error) => { if (!isSubmitting && !isCompleted) toast.error(error.data?.code === "NOT_FOUND" ? "答卷不存在或已被管理员删除，请刷新页面重新填写。" : "自动保存失败，请保持页面打开并重试；提交成功前不要关闭页面。", { id: "autosave-failed" }); },
  });

  // Submit mutation
  const submitMutation = trpc.response.submitPublic.useMutation({
    scope: { id: "public-questionnaire-autosave" },
    onSuccess: () => {
      toast.dismiss("autosave-failed");
      setIsCompleted(true);
      setIsSubmitting(false);
      if (responseId) clearPairIndex(responseId);
    },
    onError: (err) => {
      toast.error(err.data?.code === "NOT_FOUND" ? "答卷不存在或已被管理员删除，请刷新页面重新填写。" : err.message || "提交失败");
      setIsSubmitting(false);
    },
  });

  // Initialize pair answers when data loads
  // 仅在「配对集合(按 pair id)真正变化」时才重建,并保留已作答的选择。
  // 背景:此前依赖整个 questionnaire 对象,任何 refetch(引用变化)都会把已答的 choices 清空,
  // 用户回看/网络重取后已答内容丢失,提交时就少了那些组 -> 残缺样本(12/18)。
  // 额外:如果 startPublic 带回了 savedAnswersSnapshot(断点续答),这里把它水合进 choices,
  // 消费后清空 snapshot,防止后续 refetch 触发的重跑再次覆盖用户新的作答。
  useEffect(() => {
    const pairs = visiblePairs;
    if (!pairs || pairs.length === 0) return;
    setPairAnswers((prev) => {
      const prevById = new Map(prev.map((p) => [p.blindTestPairId, p]));
      // 服务端快照按 (pairId, dimId) 聚合成 choices
      const snapshotById = new Map<number, Record<number, EvaluationAnswerValue>>();
      if (savedAnswersSnapshot && savedAnswersSnapshot.length > 0) {
        for (const a of savedAnswersSnapshot) {
          if (a.blindTestPairId == null || a.evaluationDimensionId == null) continue;
          const ch = a.blindTestChoice as BlindTestChoice;
          if (!a.audioEvaluation && ch !== "left_better" && ch !== "same" && ch !== "right_better") continue;
          const bucket = snapshotById.get(a.blindTestPairId) ?? {};
          bucket[a.evaluationDimensionId] = a.audioEvaluation ? { audioEvaluation: a.audioEvaluation } : { blindTestChoice: ch };
          snapshotById.set(a.blindTestPairId, bucket);
        }
      }
      return pairs.map((pair: any) => {
        const inMemory = prevById.get(pair.id);
        const fromSnapshot = snapshotById.get(pair.id);
        if (fromSnapshot) {
          // 内存中已有的选择优先(用户可能已经在页面里作过答),再补齐快照里的选项
          return { blindTestPairId: pair.id, choices: { ...fromSnapshot, ...(inMemory?.choices || {}) } };
     }
        return inMemory ?? { blindTestPairId: pair.id, choices: {} };
      });
    });
    if (savedAnswersSnapshot && savedAnswersSnapshot.length > 0) {
      setSavedAnswersSnapshot(null);
    }
    // 断点续答:pairs 到位后把 pending 的 pair 指针 clamp 到合法范围并生效一次
    if (pendingResumeIndex !== null && pairs.length > 0) {
      const clamped = Math.min(Math.max(pendingResumeIndex, 0), pairs.length - 1);
      setCurrentPairIndex(clamped);
      setPendingResumeIndex(null);
    }
    // 用 pair id 序列作为依赖签名,避免对象引用变化触发重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePairs.map((p: any) => p.id).join(","), savedAnswersSnapshot, pendingResumeIndex]);

  // Audio player handlers
  const toggleLeftAudio = () => {
    if (!leftAudioRef.current) return;
    if (leftPlaying) {
      leftAudioRef.current.pause();
    } else {
      rightAudioRef.current?.pause();
      setRightPlaying(false);
      leftAudioRef.current.play();
    }
    setLeftPlaying(!leftPlaying);
  };

  const toggleRightAudio = () => {
    if (!rightAudioRef.current) return;
    if (rightPlaying) {
      rightAudioRef.current.pause();
    } else {
      leftAudioRef.current?.pause();
      setLeftPlaying(false);
      rightAudioRef.current.play();
    }
    setRightPlaying(!rightPlaying);
  };

  // Seek handlers: 点击或拖动进度条跳转到指定时间
  const seekLeft = (percent: number) => {
    const audio = leftAudioRef.current;
    if (!audio || !audio.duration || isNaN(audio.duration)) return;
    const time = (percent / 100) * audio.duration;
    audio.currentTime = time;
    setLeftCurrentTime(time);
    setLeftProgress(percent);
  };

  const seekRight = (percent: number) => {
    const audio = rightAudioRef.current;
    if (!audio || !audio.duration || isNaN(audio.duration)) return;
    const time = (percent / 100) * audio.duration;
    audio.currentTime = time;
    setRightCurrentTime(time);
    setRightProgress(percent);
  };

  // Reset audio when pair changes
  useEffect(() => {
    setLeftPlaying(false);
    setRightPlaying(false);
    setLeftProgress(0);
    setRightProgress(0);
    setLeftCurrentTime(0);
    setRightCurrentTime(0);
    setLeftDuration(0);
    setRightDuration(0);
    if (leftAudioRef.current) {
      leftAudioRef.current.pause();
      leftAudioRef.current.currentTime = 0;
    }
    if (rightAudioRef.current) {
      rightAudioRef.current.pause();
      rightAudioRef.current.currentTime = 0;
    }
  }, [currentPairIndex]);

  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Handle start
  const handleStart = () => {
    if (!visitorName.trim()) {
      toast.error("请输入您的姓名");
      return;
    }
    if (!questionnaire) return;
    startMutation.mutate({
      questionnaireId: questionnaire.id,
      visitorName: visitorName.trim(),
      visitorToken,
    });
  };

  // 断点续答:pair 指针变化时同步 localStorage,关掉浏览器再回来能定位到这一组
  useEffect(() => {
    if (responseId != null) savePairIndex(responseId, currentPairIndex);
  }, [responseId, currentPairIndex]);

  // 断点续答:pairAnswers 变化时 debounce 保存进度到服务端,与最终提交共享 upsert 快照
  // 仅在已开始答卷且已获得 responseId 后启用;submit/complete 状态下跳过
  useEffect(() => {
    if (!hasStarted || responseId == null || isCompleted || isSubmitting) return;
    const dims = (questionnaire?.dimensions || []) as any[];
    const pairs = visiblePairs;
    if (pairs.length === 0) return;
    const dimsForPair = (pair: any) => {
      const groupLabel = (pair?.groupLabel || "").trim();
      return dims.filter((d: any) => {
        return isDimensionApplicable(d, groupLabel);
      });
    };
    const allAnswers = pairAnswers.flatMap((pa, idx) => {
      const required = dimsForPair(pairs[idx]);
      const requiredIds = new Set(required.map((d: any) => d.id));
      return Object.entries(pa.choices)
        .filter(([dimId]) => requiredIds.has(Number(dimId)))
        .map(([dimId, choice]) => ({
          evaluationDimensionId: Number(dimId),
          blindTestPairId: pa.blindTestPairId,
          blindTestChoice: choice.blindTestChoice ?? undefined,
          audioEvaluation: choice.audioEvaluation ?? undefined,
        }));
    });
    // 空作答(初始加载或全被清空)不必去服务端 delete,避免不必要请求
    if (allAnswers.length === 0) return;
    const timer = window.setTimeout(() => {
      saveProgressMutation.mutate({ responseId, visitorToken, answers: allAnswers });
    }, 800);
    return () => window.clearTimeout(timer);
    // saveProgressMutation 引用稳定,不放入依赖避免无谓重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairAnswers, hasStarted, responseId, isCompleted, isSubmitting, questionnaire?.dimensions, visiblePairs]);

  // Handle choice selection
  const handleChoice = (dimensionId: number, choice: EvaluationAnswerValue) => {
    setPairAnswers(prev => {
      const updated = [...prev];
      if (updated[currentPairIndex]) {
        updated[currentPairIndex] = {
          ...updated[currentPairIndex],
          choices: {
            ...updated[currentPairIndex].choices,
            [dimensionId]: choice,
          },
        };
      }
      return updated;
    });
  };

  // Check if current pair is fully answered
  const isCurrentPairComplete = () => {
    if (!questionnaire?.dimensions || questionnaire.dimensions.length === 0) return true;
    const currentAnswer = pairAnswers[currentPairIndex];
    if (!currentAnswer) return false;
    const currentPair = visiblePairs[currentPairIndex];
    // 特殊维度按组别过滤：不适用于当前组的维度视为「无需作答」
    const groupLabel = (currentPair?.groupLabel || "").trim();
    const dimsForPair = (questionnaire.dimensions as any[]).filter((d: any) => {
      return isDimensionApplicable(d, groupLabel);
    });
    if (dimsForPair.length === 0) return true;
    return dimsForPair.every((dim: any) => isScoringAnswerComplete(dim, currentAnswer.choices[dim.id]));
  };

  // Handle next pair
  const handleNext = () => {
    if (!isCurrentPairComplete()) {
      toast.error("请完成所有维度的评分");
      return;
    }
    if (questionnaire && currentPairIndex < visiblePairs.length - 1) {
      setCurrentPairIndex(prev => prev + 1);
    }
  };

  // Handle previous pair
  const handlePrev = () => {
    if (currentPairIndex > 0) {
      setCurrentPairIndex(prev => prev - 1);
    }
  };

  // Handle submit
  const handleSubmit = () => {
    if (!isCurrentPairComplete()) {
      toast.error("请完成所有维度的评分");
      return;
    }
    if (!responseId) return;

    // 提交前对「全部组 × 全部维度」做完整性校验:只要有任意一组的任意维度未作答,
    // 就阻止提交并跳转到第一处未完成的组。
    // 背景:此前 flatMap 只收集有作答的组,漏答的组不会生成 answer,导致提交后
    // 出现「判断次数 < 满额(组数×维度数)」的残缺样本(如 12/18)。
    // 注意:音色相似度和情绪准确度维度按组别限定，只在命中组别的题目上要求作答。
    const dims = (questionnaire?.dimensions || []) as any[];
    const pairs = visiblePairs;
    const total = pairs.length;
    const dimsForPair = (pair: any) => {
      const groupLabel = (pair?.groupLabel || "").trim();
      return dims.filter((d: any) => {
        return isDimensionApplicable(d, groupLabel);
      });
    };
    if (dims.length > 0 && total > 0) {
      const firstIncomplete = pairAnswers.findIndex((pa, idx) => {
        const required = dimsForPair(pairs[idx]);
        return !required.every((dim: any) => isScoringAnswerComplete(dim, pa.choices[dim.id]));
      });
      // pairAnswers 数量与组数不一致(异常),或存在未答满的组,都视为未完成
      if (pairAnswers.length !== total || firstIncomplete !== -1) {
        const jumpTo = firstIncomplete === -1 ? 0 : firstIncomplete;
        setCurrentPairIndex(jumpTo);
        toast.error(`还有未完成的评分,请完成第 ${jumpTo + 1} 组后再提交`);
        return;
      }
    }

    setIsSubmitting(true);

    // Flatten all answers（按 pair 过滤后的维度提交，避免提交组别不适用的特殊维度）
    const allAnswers = pairAnswers.flatMap((pa, idx) => {
      const required = dimsForPair(pairs[idx]);
      const requiredIds = new Set(required.map((d: any) => d.id));
      return Object.entries(pa.choices)
        .filter(([dimId]) => requiredIds.has(Number(dimId)))
        .map(([dimId, choice]) => ({
          evaluationDimensionId: Number(dimId),
          blindTestPairId: pa.blindTestPairId,
          blindTestChoice: choice.blindTestChoice ?? undefined,
          audioEvaluation: choice.audioEvaluation ?? undefined,
        }));
    });

    submitMutation.mutate({
      responseId,
      visitorToken,
      answers: allAnswers,
    });
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // Error state
  if (error || !questionnaire) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="pt-8 text-center">
            <p className="text-lg font-medium text-gray-900">问卷不存在或已过期</p>
            <p className="text-sm text-gray-500 mt-2">请检查链接是否正确</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Completed state
  if (isCompleted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="pt-8 text-center space-y-4">
            <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto" />
            <h2 className="text-2xl font-bold text-gray-900">感谢您的参与！</h2>
            <p className="text-gray-600">您的评测结果已成功提交</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Entry screen - name input
  if (!hasStarted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
        <Card className="max-w-lg w-full">
          <CardContent className="pt-8 space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-gray-900">{questionnaire.title}</h1>
              {questionnaire.description && (
                <p className="text-gray-600 mt-2">{questionnaire.description}</p>
              )}
              <p className="text-sm text-gray-500 mt-4">
                {questionnaire.distribution
                  ? `将从 ${questionnaire.distribution.formCount} 张预设子问卷中随机领取一张，每张 ${questionnaire.distribution.minGroups === questionnaire.distribution.maxGroups ? questionnaire.distribution.minGroups : `${questionnaire.distribution.minGroups}–${questionnaire.distribution.maxGroups}`} 个组别（同组全部配对一起发放）`
                  : (questionnaire as any).sampleSize && (questionnaire as any).sampleSize > 0
                  ? `将从题库中随机抽取 ${(questionnaire as any).sampleSize} 组供你测评`
                  : `共 ${questionnaire.blindTestPairs?.length || 0} 组音频对比`}
                {questionnaire.dimensions?.length > 0 && `，${questionnaire.dimensions.length} 个评分维度`}
              </p>
            </div>

            {/* 测评背景 */}
            {questionnaire.evaluationCopywriting && (
              <div className="space-y-1.5 text-left">
                <h2 className="text-sm font-semibold text-gray-900">测评背景</h2>
                <p className="text-sm text-gray-600 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg p-3">
                  {questionnaire.evaluationCopywriting}
                </p>
              </div>
            )}

            {/* 评分标准 */}
            {questionnaire.scoringStandard && (
              <div className="space-y-1.5 text-left">
                <h2 className="text-sm font-semibold text-gray-900">评分标准</h2>
                <p className="text-sm text-gray-600 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg p-3">
                  {questionnaire.scoringStandard}
                </p>
              </div>
            )}

            <div className="space-y-2">
              {questionnaire.distribution && <p className="text-xs text-slate-500">开始后占用一份名额；同一浏览器、同一姓名可续答，不会重新抽取。请勿重复领取。</p>}
              <label className="text-sm font-medium text-gray-700">
                请输入您的姓名 <span className="text-red-500">*</span>
              </label>
              <Input
                placeholder="请输入姓名"
                value={visitorName}
                onChange={(e) => setVisitorName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleStart()}
              />
            </div>
            <Button
              className="w-full bg-blue-600 hover:bg-blue-700"
              onClick={handleStart}
              disabled={startMutation.isPending}
            >
              {startMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              开始测评
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Main blind test interface
  if (visiblePairs.length === 0) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6"><p role="alert" className="text-sm text-slate-700">所分配问卷暂无可用配对，请刷新重试或联系管理员。已有领取记录不会重复占用名额。</p></div>;
  }
  const currentPair = visiblePairs[currentPairIndex];
  const totalPairs = visiblePairs.length;
  const progressPercent = ((currentPairIndex + 1) / totalPairs) * 100;
  const currentAnswer = pairAnswers[currentPairIndex];

  // 按盲测题的组别过滤维度：
  // - 普通维度：所有题目都展示；
  // - 特殊维度：只在目标组别或情绪类别配置命中当前题目组别时展示。
  const filterDimensionsForPair = (pair: any) => {
    const dims = questionnaire?.dimensions || [];
    const groupLabel = (pair?.groupLabel || "").trim();
    return dims.filter((d: any) => {
      return isDimensionApplicable(d, groupLabel);
    });
  };
  const dimensionsForCurrentPair = filterDimensionsForPair(currentPair);

  return (
    <div className="min-h-screen bg-gray-50 py-6 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
        {subQuestionnaireIndex != null && <p className="text-sm text-blue-700">已分配：子问卷 {subQuestionnaireIndex} · {sampledGroupLabels?.length ?? 0} 个组别 · {visiblePairs.length} 对音频</p>}
        {/* Progress Header */}
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700 whitespace-nowrap">
            {currentPairIndex + 1} / {totalPairs}
          </span>
          <Progress value={progressPercent} className="flex-1 h-2" />
          <span className="text-sm text-gray-600 whitespace-nowrap">{visitorName}</span>
        </div>

        {/* Audio Comparison */}
        <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center">
          {/* Left Audio */}
          <Card className="border-2 border-gray-200 hover:border-gray-300 transition-colors">
            <CardContent className="pt-6 text-center space-y-4">
              <h3 className="font-bold text-lg text-gray-900">左边</h3>
              <div className="flex items-center justify-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleLeftAudio}
                  className="rounded-full w-10 h-10 p-0"
                >
                  {leftPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                </Button>
                <div className="flex-1 text-xs text-gray-500">
                  {formatTime(leftCurrentTime)} / {formatTime(leftDuration)}
                </div>
                <Volume2 className="w-4 h-4 text-gray-400" />
              </div>
              {/* Progress bar (clickable & draggable) */}
              <div className="relative w-full h-4 flex items-center">
                <div className="absolute w-full bg-gray-200 rounded-full h-1.5">
                  <div
                    className="bg-blue-500 h-1.5 rounded-full"
                    style={{ width: `${leftProgress}%` }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={0.1}
                  value={leftProgress}
                  onChange={(e) => seekLeft(Number(e.target.value))}
                  aria-label="左边音频进度"
                  className="absolute w-full h-4 cursor-pointer appearance-none bg-transparent
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-600 [&::-webkit-slider-thumb]:cursor-pointer
                    [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full
                    [&::-moz-range-thumb]:bg-blue-600 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer"
                />
              </div>
              {/* Hidden audio element */}
              {currentPair?.leftAudio && (
                <audio
                  ref={leftAudioRef}
                  src={currentPair.leftAudio.fileUrl}
                  preload="metadata"
                  onTimeUpdate={() => {
                    if (leftAudioRef.current) {
                      setLeftCurrentTime(leftAudioRef.current.currentTime);
                      setLeftProgress((leftAudioRef.current.currentTime / leftAudioRef.current.duration) * 100);
                    }
                  }}
                  onLoadedMetadata={() => {
                    if (leftAudioRef.current) setLeftDuration(leftAudioRef.current.duration);
                  }}
                  onEnded={() => setLeftPlaying(false)}
                />
              )}
            </CardContent>
          </Card>

          {/* VS Separator */}
          <div className="text-2xl font-bold text-gray-400">VS</div>

          {/* Right Audio */}
          <Card className="border-2 border-gray-200 hover:border-gray-300 transition-colors">
            <CardContent className="pt-6 text-center space-y-4">
              <h3 className="font-bold text-lg text-gray-900">右边</h3>
              <div className="flex items-center justify-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleRightAudio}
                  className="rounded-full w-10 h-10 p-0"
                >
                  {rightPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                </Button>
                <div className="flex-1 text-xs text-gray-500">
                  {formatTime(rightCurrentTime)} / {formatTime(rightDuration)}
                </div>
                <Volume2 className="w-4 h-4 text-gray-400" />
              </div>
              {/* Progress bar (clickable & draggable) */}
              <div className="relative w-full h-4 flex items-center">
                <div className="absolute w-full bg-gray-200 rounded-full h-1.5">
                  <div
                    className="bg-blue-500 h-1.5 rounded-full"
                    style={{ width: `${rightProgress}%` }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={0.1}
                  value={rightProgress}
                  onChange={(e) => seekRight(Number(e.target.value))}
                  aria-label="右边音频进度"
                  className="absolute w-full h-4 cursor-pointer appearance-none bg-transparent
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-600 [&::-webkit-slider-thumb]:cursor-pointer
                    [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full
                    [&::-moz-range-thumb]:bg-blue-600 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer"
                />
              </div>
              {/* Hidden audio element */}
              {currentPair?.rightAudio && (
                <audio
                  ref={rightAudioRef}
                  src={currentPair.rightAudio.fileUrl}
                  preload="metadata"
                  onTimeUpdate={() => {
                    if (rightAudioRef.current) {
                      setRightCurrentTime(rightAudioRef.current.currentTime);
                      setRightProgress((rightAudioRef.current.currentTime / rightAudioRef.current.duration) * 100);
                    }
                  }}
                  onLoadedMetadata={() => {
                    if (rightAudioRef.current) setRightDuration(rightAudioRef.current.duration);
                  }}
                  onEnded={() => setRightPlaying(false)}
                />
              )}
            </CardContent>
          </Card>
        </div>

        {/* Evaluation Dimensions */}
        <div className="space-y-3">
          {dimensionsForCurrentPair.map((dim: any) => {
            const isSimilarity = dim.dimensionType === "similarity";
            const isEmotionAccuracy = dim.dimensionType === "emotion_accuracy";
            const groupLabel = (currentPair.groupLabel || "").trim();
            const targetEmotion = getEmotionCategories(dim.emotionCategories)
              .find(category => category.groupLabels.includes(groupLabel))?.name;
            return (
              <Card key={dim.id} className={`border ${isSimilarity ? "border-purple-200 bg-purple-50/40" : "border-gray-200"}`}>
                <CardContent className="py-5 px-6 space-y-3">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <h4 className="font-bold text-gray-900 text-base">
                        {dim.dimensionName}
                        {isSimilarity && (
                          <span className="ml-2 inline-block rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 align-middle">
                            音色相似度
                          </span>
                        )}
                        {isEmotionAccuracy && (
                          <span className="ml-2 inline-block rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 align-middle">
                            情绪准确度
                          </span>
                        )}
                      </h4>
                      {isEmotionAccuracy && targetEmotion && (
                        <p className="mt-2 text-sm font-medium text-blue-700">
                          目标情绪：{targetEmotion}。{getScoringConfig(dim).mode === "numeric" ? "请分别评价两个音频的情绪准确度。" : "请选择更准确表达该情绪的音频。"}
                        </p>
                      )}
                      {dim.description && (
                        <p className="text-sm text-gray-500 mt-1 leading-relaxed">{dim.description}</p>
                      )}
                    </div>
                  </div>
                  <ScoringAnswerFields dimension={dim} value={currentAnswer?.choices[dim.id]} onChange={value => handleChoice(dim.id, value)} disabled={isSubmitting} />
                  {/* 相似度维度：附参考音频播放器（对比左右两边与参考音频的相似度） */}
                  {isSimilarity && dim.referenceAudio?.fileUrl && (
                    <div className="rounded-md border border-purple-200 bg-white p-3">
                      <div className="text-xs text-purple-700 mb-2">
                        参考音频（判断左右两边哪一边更像下面这段声音）
                      </div>
                      <audio
                        src={dim.referenceAudio.fileUrl}
                        controls
                        preload="metadata"
                        className="w-full"
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between pt-4">
          <Button
            variant="outline"
            onClick={handlePrev}
            disabled={currentPairIndex === 0}
            className="px-6"
          >
            上一组
          </Button>
          <div className="text-sm text-gray-500">
            {isCurrentPairComplete() ? (
              <span className="text-green-600 font-medium flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" /> 已完成
              </span>
            ) : (
              <span>请完成所有维度评分</span>
            )}
          </div>
          {currentPairIndex < totalPairs - 1 ? (
            <Button
              className="bg-blue-600 hover:bg-blue-700 px-6"
              onClick={handleNext}
              disabled={!isCurrentPairComplete()}
            >
              下一组
            </Button>
          ) : (
            <Button
              className="bg-green-600 hover:bg-green-700 px-6"
              onClick={handleSubmit}
              disabled={!isCurrentPairComplete() || isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  提交中...
                </>
              ) : (
                "提交评测"
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
