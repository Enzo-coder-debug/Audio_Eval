import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import {
  MAX_RESPONSE_DELETE_BATCH,
  type ResponseDeletionTarget,
} from "@shared/responseDeletion";
import { summarizeResponses } from "@shared/responseStats";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export function DeleteResponseButton({
  questionnaireId,
  response,
  onDeleted,
}: {
  questionnaireId: number;
  response: ResponseDeletionTarget;
  onDeleted: () => void;
}) {
  return (
    <DeleteResponsesButton
      questionnaireId={questionnaireId}
      responses={[response]}
      onDeleted={() => onDeleted()}
      single
    />
  );
}

export function DeleteResponsesButton({
  questionnaireId,
  responses,
  onDeleted,
  single = false,
}: {
  questionnaireId: number;
  responses: ResponseDeletionTarget[];
  onDeleted: (responseIds: number[]) => void;
  single?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<ResponseDeletionTarget[]>([]);
  const summary = summarizeResponses(targets);
  const releasedByForm = new Map<number, number>();
  for (const target of targets) {
    if (target.subQuestionnaireIndex != null)
      releasedByForm.set(
        target.subQuestionnaireIndex,
        (releasedByForm.get(target.subQuestionnaireIndex) ?? 0) + 1
      );
  }
  const quotaDescription = Array.from(releasedByForm)
    .sort(([left], [right]) => left - right)
    .map(([index, count]) => `子问卷 ${index}：${count} 个`)
    .join("；");
  const utils = trpc.useUtils();
  const deletion = trpc.response.deleteBatch.useMutation({
    onSuccess: async result => {
      const deletedIds = new Set(result.responseIds);
      utils.response.listQuestionnaire.setData(
        { questionnaireId },
        current =>
          current && {
            ...current,
            responses: current.responses.filter(
              item => !deletedIds.has(item.id)
            ),
          }
      );
      setOpen(false);
      onDeleted(result.responseIds);
      toast.success(
        result.releasedQuota
          ? `已删除 ${result.deletedCount} 份答卷，释放 ${result.releasedQuota} 个子问卷名额`
          : `已删除 ${result.deletedCount} 份答卷，统计已更新`
      );
      const refreshes = await Promise.allSettled([
        utils.response.listQuestionnaire.invalidate({ questionnaireId }),
        utils.questionnaire.distribution.invalidate({ questionnaireId }),
        utils.audio.listByQuestionnaire.invalidate({ questionnaireId }),
        utils.stats.get.invalidate({ questionnaireId }),
        utils.stats.aggregate.invalidate(),
        utils.stats.aggregateMulti.invalidate(),
      ]);
      if (refreshes.some(refresh => refresh.status === "rejected")) {
        toast.warning(
          "答卷已删除，但部分页面数据刷新失败，请刷新页面查看最新统计"
        );
      }
    },
    onError: error => toast.error(error.message || "删除失败，请重试"),
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={value => {
        if (deletion.isPending) return;
        if (value) setTargets(responses.map(response => ({ ...response })));
        setOpen(value);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant={single ? "outline" : "destructive"}
          size="sm"
          className={single ? "text-destructive" : undefined}
          disabled={
            deletion.isPending ||
            responses.length === 0 ||
            responses.length > MAX_RESPONSE_DELETE_BATCH
          }
          aria-label={
            single
              ? `删除 ${responses[0]?.visitorName || "匿名"} 的答卷 #${responses[0]?.id}`
              : `批量删除 ${responses.length} 份答卷`
          }
        >
          <Trash2 className="mr-1 h-4 w-4" />
          {single ? "删除答卷" : `批量删除（${responses.length}）`}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {single
              ? "确认删除这份答卷？"
              : `确认删除选中的 ${targets.length} 份答卷？`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            将永久删除下列答卷及其全部作答和评分，无法撤销。只删除所选记录，问卷、音频和其他人的答卷不受影响。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul
          className="max-h-40 overflow-y-auto rounded-md border p-3 text-sm space-y-1"
          aria-label="待删除答卷"
        >
          {targets.map(target => (
            <li key={target.id} className="break-words">
              #{target.id} · {target.visitorName || "匿名"} ·{" "}
              {target.status === "in_progress"
                ? "进行中"
                : target.status === "graded"
                  ? "已评分"
                  : "已提交"}
              {target.subQuestionnaireIndex != null
                ? ` · 子问卷 ${target.subQuestionnaireIndex}`
                : ""}
            </li>
          ))}
        </ul>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            本次选择 {summary.totalResponses} 份：进行中{" "}
            {summary.inProgressResponses} 份，已提交/已评分{" "}
            {summary.completedResponses}{" "}
            份。删除后相应数量减少，完成率和统计分析同步重算。
          </p>
          {releasedByForm.size > 0 && (
            <p>将释放名额：{quotaDescription}。预设发放份数不变。</p>
          )}
          <p>
            问卷仍开放且有名额时，答题人可重新打开原链接填写。子问卷将重新随机领取，不保证分配到原子问卷。名额可能被其他人领取。
          </p>
          <p>如需保留记录，请先导出 Excel。</p>
          {!single && (
            <p>
              整批删除在同一事务内完成；记录失效或删除失败时，本次整批不删除。
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deletion.isPending}>
            取消
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={deletion.isPending || targets.length === 0}
            onClick={() =>
              deletion.mutate({
                questionnaireId,
                responseIds: targets.map(target => target.id),
              })
            }
          >
            {deletion.isPending
              ? "正在删除…"
              : single
                ? "确认删除答卷"
                : `确认删除 ${targets.length} 份答卷`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
