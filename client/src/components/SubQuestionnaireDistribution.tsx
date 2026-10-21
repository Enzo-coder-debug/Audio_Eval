import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { filterGroupLabels } from "@/lib/groupSelection";

export function SubQuestionnaireDistribution({
  questionnaireId,
  published,
  onChange,
}: {
  questionnaireId: number;
  published: boolean;
  onChange: () => void;
}) {
  const [groupsPerForm, setGroupsPerForm] = useState("50");
  const [quota, setQuota] = useState("20");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [confirmation, setConfirmation] = useState<"enable" | "disable" | null>(
    null
  );
  const { data, isLoading, error, refetch } =
    trpc.questionnaire.distribution.useQuery(
      { questionnaireId },
      { refetchInterval: 15000 }
    );
  const storedGroups = data?.groupsPerForm;
  const storedQuota = data?.forms[0]?.quota;
  useEffect(() => {
    if (storedGroups != null) setGroupsPerForm(String(storedGroups));
    if (storedQuota != null) setQuota(String(storedQuota));
  }, [storedGroups, storedQuota]);
  const mutation = trpc.questionnaire.configureDistribution.useMutation({
    onSuccess: () => {
      toast.success(
        confirmation === "disable"
          ? "已停用分组发放，恢复全部组别"
          : "子问卷已固定分组，可发布共享链接发放"
      );
      setConfirmation(null);
      refetch();
      onChange();
    },
    onError: failure => toast.error(failure.message),
  });
  if (isLoading)
    return <p className="text-sm text-slate-500">正在读取发放方案…</p>;
  if (error || !data)
    return (
      <p role="alert" className="text-sm text-red-600">
        {error?.message || "发放方案读取失败"}
      </p>
    );
  const groupSize = Number(groupsPerForm);
  const count = Math.ceil(data.groupCount / groupSize);
  const limit = Number(quota);
  const valid =
    Number.isInteger(groupSize) &&
    groupSize > 0 &&
    groupSize <= 10000 &&
    count > 0 &&
    count <= 100 &&
    Number.isInteger(limit) &&
    limit > 0 &&
    limit <= 10000;
  const locked = published || data.responseCount > 0;
  const lastGroupSize = valid ? data.groupCount - (count - 1) * groupSize : 0;
  const selected = data.forms.find(form => form.index === selectedIndex);
  const matching = filterGroupLabels(selected?.groupLabels ?? [], filter);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>固定分组 · 限额发放</CardTitle>
          <CardDescription>
            先将组别分成固定、不重叠的子问卷；答题人通过同一个分享链接，从未领满的子问卷中等概率领取一张。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">
            当前题库：<strong>{data.groupCount}</strong> 个有效组别，
            <strong>{data.pairCount}</strong>{" "}
            对音频。同一组内的全部模型配对放在同一张子问卷。
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="distribution-count">每张子问卷组别数</Label>
              <Input
                id="distribution-count"
                type="number"
                min={1}
                max={10000}
                step={1}
                value={groupsPerForm}
                disabled={locked || mutation.isPending}
                onChange={event => setGroupsPerForm(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="distribution-quota">每张子问卷发放份数</Label>
              <Input
                id="distribution-quota"
                type="number"
                min={1}
                max={10000}
                step={1}
                value={quota}
                disabled={locked || mutation.isPending}
                onChange={event => setQuota(event.target.value)}
              />
            </div>
          </div>
          {valid ? (
            <p className="rounded-md bg-blue-50 p-3 text-sm text-blue-800">
              {data.groupCount} 组 → {count} 张子问卷，每张最多 {groupSize} 组 ×{" "}
              {limit} 份，总计 {count * limit} 份。
              {lastGroupSize !== groupSize &&
                `最后一张为 ${lastGroupSize} 组，仍发放 ${limit} 份。`}
            </p>
          ) : (
            <p className="text-sm text-slate-500">
              请先生成盲测配对，填写 1–10000 的整数组别数与发放份数；最多生成
              100 张子问卷。
            </p>
          )}
          <p className="text-xs text-slate-500">
            名额口径：进行中 +
            已提交。开始作答即占用名额，不自动释放；同一浏览器、同一姓名续答不重复扣减，提交后不能重复领取。匿名发放无法防止换浏览器或换姓名重复参与。
          </p>
          {locked && (
            <p className="text-sm text-amber-700">
              {data.responseCount > 0
                ? "已有答卷，分组方案已锁定。需要重新分组或调整份数，请复制问卷后配置。"
                : "请先下线问卷，再生成或调整分组方案。"}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={locked || !valid || mutation.isPending}
              onClick={() => setConfirmation("enable")}
            >
              {data.enabled ? "重新生成分组方案" : "生成并启用子问卷"}
            </Button>
            {data.enabled && (
              <Button
                variant="outline"
                disabled={locked || mutation.isPending}
                onClick={() => setConfirmation("disable")}
              >
                停用分组发放
              </Button>
            )}
            <Button variant="outline" onClick={() => refetch()}>
              刷新进度
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            启用后替代原“每人随机抽取组别”模式，锁定音频、组别及配对，避免已分配内容变化。
          </p>
        </CardContent>
      </Card>
      {data.enabled && (
        <Card>
          <CardHeader>
            <CardTitle>子问卷发放进度</CardTitle>
            <CardDescription>
              已固定 {data.forms.length} 张 · 总名额{" "}
              {data.forms.reduce((total, form) => total + form.quota, 0)} 份 ·
              剩余{" "}
              {data.forms.reduce((total, form) => total + form.remaining, 0)} 份
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>子问卷</TableHead>
                  <TableHead>组别 / 配对</TableHead>
                  <TableHead>限额</TableHead>
                  <TableHead>进行中</TableHead>
                  <TableHead>已提交</TableHead>
                  <TableHead>剩余</TableHead>
                  <TableHead>内容</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.forms.map(form => (
                  <TableRow key={form.index}>
                    <TableCell>子问卷 {form.index}</TableCell>
                    <TableCell>
                      {form.groupLabels.length} / {form.pairIds.length}
                    </TableCell>
                    <TableCell>{form.quota}</TableCell>
                    <TableCell>{form.inProgress}</TableCell>
                    <TableCell>{form.completed}</TableCell>
                    <TableCell>
                      {form.remaining === 0 ? "已领满" : form.remaining}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSelectedIndex(form.index);
                          setFilter("");
                        }}
                      >
                        查看组别
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Dialog
        open={selectedIndex != null}
        onOpenChange={open => {
          if (!open) setSelectedIndex(null);
        }}
      >
        <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>子问卷 {selectedIndex} · 固定组别</DialogTitle>
            <DialogDescription>
              {selected?.groupLabels.length ?? 0} 个组别，
              {selected?.pairIds.length ?? 0} 对音频，发放{" "}
              {selected?.quota ?? 0} 份
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="筛选子问卷组别"
            placeholder="输入关键词筛选组别"
            value={filter}
            onChange={event => setFilter(event.target.value)}
          />
          <ScrollArea type="always" className="h-72 min-h-0">
            <div className="space-y-2 pr-4">
              {matching.slice(0, 200).map(label => (
                <p
                  key={label}
                  className="break-all rounded bg-slate-50 px-3 py-2 text-sm"
                >
                  {label}
                </p>
              ))}
              {matching.length === 0 && (
                <p className="text-sm text-slate-500">没有匹配的组别</p>
              )}
            </div>
          </ScrollArea>
          <p className="text-xs text-slate-500">
            匹配 {matching.length} 组
            {matching.length > 200 ? "，显示前 200 组，请缩小筛选范围" : ""}
          </p>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmation != null}
        onOpenChange={open => {
          if (!open && !mutation.isPending) setConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation === "disable"
                ? "停用分组发放？"
                : "固定本次分组方案？"}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "disable"
                ? "删除未使用的分组方案，恢复发放全部组别，不删除音频或配对。"
                : `将按每张最多 ${groupSize} 组，随机分成 ${count} 张固定子问卷（最后一张 ${lastGroupSize} 组），每张 ${limit} 份。覆盖旧方案及原随机抽样设置；一旦有人开始作答，将不能重新分组。`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setConfirmation(null)}
            >
              取消
            </Button>
            <Button
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate({
                  questionnaireId,
                  groupsPerForm: confirmation === "disable" ? 1 : groupSize,
                  quota: confirmation === "disable" ? 1 : limit,
                  enabled: confirmation === "enable",
                })
              }
            >
              {mutation.isPending ? "保存中…" : "确认"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
