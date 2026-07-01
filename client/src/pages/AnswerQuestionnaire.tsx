import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Send, Loader2, Play } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export default function AnswerQuestionnaire() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/user/questionnaire/:id/answer/:responseId");

  const questionnaireId = params?.id ? parseInt(params.id) : 0;
  const responseId = params?.responseId ? parseInt(params.responseId) : 0;

  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // Fetch questionnaire with questions
  const { data: questionnaire, isLoading } = trpc.questionnaire.get.useQuery(
    { id: questionnaireId },
    { enabled: !!questionnaireId }
  );

  // Fetch audio file
  const { data: audioFile } = trpc.audio.get.useQuery(
    { id: questionnaire?.audioFileId || 0 },
    { enabled: !!questionnaire?.audioFileId }
  );

  // Update audio URL when audio file is fetched
  if (audioFile?.fileUrl && !audioUrl) {
    setAudioUrl(audioFile.fileUrl);
  }

  // Submit answers
  const { mutate: submitAnswers } = trpc.response.submit.useMutation({
    onSuccess: () => {
      toast.success("答案已提交，等待 AI 评分...");
      setLocation(`/user/response/${responseId}`);
    },
    onError: (error) => {
      toast.error(error.message || "提交失败");
    },
  });

  const handleAnswerChange = (questionId: number, value: string, isMultiple: boolean = false) => {
    if (isMultiple) {
      const current = answers[questionId] ? JSON.parse(answers[questionId]) : [];
      const updated = current.includes(value)
        ? current.filter((v: string) => v !== value)
        : [...current, value];
      setAnswers(prev => ({
        ...prev,
        [questionId]: JSON.stringify(updated),
      }));
    } else {
      setAnswers(prev => ({
        ...prev,
        [questionId]: value,
      }));
    }
  };

  const handleSubmit = async () => {
    if (!questionnaire) return;

    // Validate all questions answered
    const unanswered = questionnaire.questions?.filter(q => !answers[q.id]);
    if (unanswered && unanswered.length > 0) {
      toast.error("请回答所有问题");
      return;
    }

    setIsSubmitting(true);
    try {
      const answersList = questionnaire.questions?.map(q => ({
        questionId: q.id,
        answerContent: answers[q.id],
      })) || [];

      submitAnswers({
        responseId,
        answers: answersList,
      });
    } finally {
      setIsSubmitting(false);
    }
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
            <Button onClick={() => setLocation("/user/dashboard")}>
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
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation("/user/dashboard")}
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <h1 className="text-xl font-semibold text-slate-900">答题</h1>
          </div>
          <div className="text-sm text-slate-600">
            {Object.keys(answers).length} / {questionnaire.questions?.length || 0}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>{questionnaire.title}</CardTitle>
            <CardDescription>
              请认真听取音频内容，并根据题目要求作答
            </CardDescription>
          </CardHeader>
          {audioUrl && (
            <CardContent>
              <div className="bg-slate-100 rounded-lg p-6 flex items-center gap-4">
                <div className="w-12 h-12 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Play className="w-6 h-6 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-900 mb-3">音频内容</p>
                  <audio
                    controls
                    className="w-full"
                    src={audioUrl}
                  />
                </div>
              </div>
            </CardContent>
          )}
        </Card>

        {/* Questions */}
        <div className="space-y-6">
          {questionnaire.questions?.map((question, idx) => (
            <Card key={question.id}>
              <CardHeader>
                <CardTitle className="text-lg">
                  {idx + 1}. {question.questionText}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {question.questionType === "single_choice" && (
                  <RadioGroup
                    value={answers[question.id] || ""}
                    onValueChange={(value) => handleAnswerChange(question.id, value)}
                  >
                    <div className="space-y-3">
                      {(question.options as any[])?.map((option: any) => (
                        <div key={option.id} className="flex items-center gap-3">
                          <RadioGroupItem value={option.id} id={`q${question.id}-${option.id}`} />
                          <Label htmlFor={`q${question.id}-${option.id}`} className="cursor-pointer flex-1">
                            {option.text as string}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </RadioGroup>
                )}

                {question.questionType === "multiple_choice" && (
                  <div className="space-y-3">
                    {(question.options as any[])?.map((option: any) => {
                      const selected = answers[question.id]
                        ? JSON.parse(answers[question.id]).includes(option.id)
                        : false;
                      return (
                        <div key={option.id} className="flex items-center gap-3">
                          <Checkbox
                            id={`q${question.id}-${option.id}`}
                            checked={selected}
                            onCheckedChange={() => handleAnswerChange(question.id, option.id, true)}
                          />
                          <Label htmlFor={`q${question.id}-${option.id}`} className="cursor-pointer flex-1">
                            {option.text as string}
                          </Label>
                        </div>
                      );
                    })}
                  </div>
                )}

                {question.questionType === "subjective" && (
                  <Textarea
                    placeholder="请输入你的答案..."
                    value={answers[question.id] || ""}
                    onChange={(e) => handleAnswerChange(question.id, e.target.value)}
                    className="min-h-32"
                  />
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Submit Button */}
        <div className="mt-8 flex gap-4 justify-center">
          <Button
            variant="outline"
            onClick={() => setLocation("/user/dashboard")}
          >
            返回
          </Button>
          <Button
            className="bg-blue-600 hover:bg-blue-700"
            onClick={handleSubmit}
            disabled={isSubmitting || Object.keys(answers).length !== (questionnaire.questions?.length || 0)}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                提交中...
              </>
            ) : (
              <>
                <Send className="w-4 h-4 mr-2" />
                提交答案
              </>
            )}
          </Button>
        </div>
      </main>
    </div>
  );
}
