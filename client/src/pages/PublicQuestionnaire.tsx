import { useState, useRef, useEffect } from "react";
import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
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
  choices: Record<number, BlindTestChoice>; // dimensionId -> choice
}

export default function PublicQuestionnaire() {
  const { shareToken } = useParams();
  const [visitorName, setVisitorName] = useState("");
  const [hasStarted, setHasStarted] = useState(false);
  const [responseId, setResponseId] = useState<number | null>(null);
  const [currentPairIndex, setCurrentPairIndex] = useState(0);
  const [pairAnswers, setPairAnswers] = useState<PairAnswer[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);

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
    { shareToken: shareToken || "" },
    { enabled: !!shareToken }
  );

  // Start response mutation
  const startMutation = trpc.response.startPublic.useMutation({
    onSuccess: (data) => {
      setResponseId(data.responseId);
      setHasStarted(true);
    },
    onError: (err) => {
      toast.error(err.message || "开始测评失败");
    },
  });

  // Submit mutation
  const submitMutation = trpc.response.submitPublic.useMutation({
    onSuccess: () => {
      setIsCompleted(true);
      setIsSubmitting(false);
    },
    onError: (err) => {
      toast.error(err.message || "提交失败");
      setIsSubmitting(false);
    },
  });

  // Initialize pair answers when data loads
  useEffect(() => {
    if (questionnaire?.blindTestPairs) {
      setPairAnswers(
        questionnaire.blindTestPairs.map((pair: any) => ({
          blindTestPairId: pair.id,
          choices: {},
        }))
      );
    }
  }, [questionnaire]);

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
      visitorToken: getVisitorToken(),
    });
  };

  // Handle choice selection
  const handleChoice = (dimensionId: number, choice: BlindTestChoice) => {
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
    return questionnaire.dimensions.every((dim: any) => currentAnswer.choices[dim.id] !== undefined);
  };

  // Handle next pair
  const handleNext = () => {
    if (!isCurrentPairComplete()) {
      toast.error("请完成所有维度的评分");
      return;
    }
    if (questionnaire && currentPairIndex < questionnaire.blindTestPairs.length - 1) {
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

    setIsSubmitting(true);

    // Flatten all answers
    const allAnswers = pairAnswers.flatMap(pa =>
      Object.entries(pa.choices).map(([dimId, choice]) => ({
        evaluationDimensionId: Number(dimId),
        blindTestPairId: pa.blindTestPairId,
        blindTestChoice: choice as "left_better" | "same" | "right_better",
      }))
    );

    submitMutation.mutate({
      responseId,
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
                共 {questionnaire.blindTestPairs?.length || 0} 组音频对比
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
  const currentPair = questionnaire.blindTestPairs?.[currentPairIndex];
  const totalPairs = questionnaire.blindTestPairs?.length || 0;
  const progressPercent = ((currentPairIndex + 1) / totalPairs) * 100;
  const currentAnswer = pairAnswers[currentPairIndex];

  return (
    <div className="min-h-screen bg-gray-50 py-6 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
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
          {questionnaire.dimensions?.map((dim: any) => {
            const currentChoice = currentAnswer?.choices[dim.id];
            return (
              <Card key={dim.id} className="border border-gray-200">
                <CardContent className="py-5 px-6">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <h4 className="font-bold text-gray-900 text-base">{dim.dimensionName}</h4>
                      {dim.description && (
                        <p className="text-sm text-gray-500 mt-1 leading-relaxed">{dim.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleChoice(dim.id, "left_better")}
                        className={`px-4 py-2 text-sm font-medium rounded-full border-2 transition-all duration-150 cursor-pointer ${
                          currentChoice === "left_better"
                            ? "bg-orange-50 border-orange-400 text-orange-700 shadow-sm"
                            : "border-orange-200 text-orange-600 hover:bg-orange-50 hover:border-orange-300"
                        }`}
                      >
                        左边更好
                      </button>
                      <button
                        onClick={() => handleChoice(dim.id, "same")}
                        className={`px-4 py-2 text-sm font-medium rounded-full border-2 transition-all duration-150 cursor-pointer ${
                          currentChoice === "same"
                            ? "bg-yellow-50 border-yellow-400 text-yellow-700 shadow-sm"
                            : "border-yellow-200 text-yellow-600 hover:bg-yellow-50 hover:border-yellow-300"
                        }`}
                      >
                        差不多
                      </button>
                      <button
                        onClick={() => handleChoice(dim.id, "right_better")}
                        className={`px-4 py-2 text-sm font-medium rounded-full border-2 transition-all duration-150 cursor-pointer ${
                          currentChoice === "right_better"
                            ? "bg-green-50 border-green-400 text-green-700 shadow-sm"
                            : "border-green-200 text-green-600 hover:bg-green-50 hover:border-green-300"
                        }`}
                      >
                        右边更好
                      </button>
                    </div>
                  </div>
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
