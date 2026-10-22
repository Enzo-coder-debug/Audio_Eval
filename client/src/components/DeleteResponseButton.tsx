import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
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
  response: {
    id: number;
    visitorName: string | null;
    status: string;
    subQuestionnaireIndex: number | null;
  };
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const deletion = trpc.response.delete.useMutation({
    onSuccess: async result => {
      utils.response.listQuestionnaire.setData(
        { questionnaireId },
        current =>
          current && {
            ...current,
            responses: current.responses.filter(
              item => item.id !== response.id
            ),
          }
      );
      setOpen(false);
      onDeleted();
      toast.success(
        result.releasedQuota
          ? "答卷已删除，已释放 1 个子问卷名额"
          : "答卷已删除，统计已更新"
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
        if (!deletion.isPending) setOpen(value);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          aria-label={`删除 ${response.visitorName || "匿名"} 的答卷 #${response.id}`}
        >
          <Trash2 className="mr-1 h-4 w-4" />
          删除答卷
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除这份答卷？</AlertDialogTitle>
          <AlertDialogDescription>
            将永久删除「{response.visitorName || "匿名"}」的答卷 #{response.id}{" "}
            及其全部作答和评分，无法撤销。问卷、音频和其他人的答卷不受影响。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            总答卷数将减少 1；
            {response.status === "in_progress" ? "进行中数量" : "已提交数量"}
            也将减少 1，完成率和统计分析同步重算。
          </p>
          {response.subQuestionnaireIndex != null && (
            <p>
              子问卷 {response.subQuestionnaireIndex} 将释放 1
              个名额，预设发放份数不变。
            </p>
          )}
          <p>
            问卷仍开放且有名额时，答题人可重新打开原链接填写。子问卷将重新随机领取，不保证分配到原子问卷。名额可能被其他人领取。
          </p>
          <p>如需保留记录，请先导出 Excel。</p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deletion.isPending}>
            取消
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={deletion.isPending}
            onClick={() =>
              deletion.mutate({ questionnaireId, responseId: response.id })
            }
          >
            {deletion.isPending ? "正在删除…" : "确认删除答卷"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
