import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AUDIO_PAGE_SIZE,
  type getAudioModelOptions,
} from "@/lib/audioSelection";

export type AudioFilters = {
  model: string;
  query: string;
  selectedOnly: boolean;
};

export function AudioSelectionToolbar({
  filters,
  onFiltersChange,
  modelOptions,
  totalCount,
  matchingCount,
  selectedCount,
  selectedMatchingCount,
  disabled,
  onSelectMatches,
  onDeselectMatches,
  onClearSelection,
}: {
  filters: AudioFilters;
  onFiltersChange: (filters: AudioFilters) => void;
  modelOptions: ReturnType<typeof getAudioModelOptions>;
  totalCount: number;
  matchingCount: number;
  selectedCount: number;
  selectedMatchingCount: number;
  disabled: boolean;
  onSelectMatches: () => void;
  onDeselectMatches: () => void;
  onClearSelection: () => void;
}) {
  const hiddenSelectedCount = selectedCount - selectedMatchingCount;
  return (
    <section
      aria-label="音频筛选与批量选择"
      className="mb-4 space-y-3 rounded-lg border bg-slate-50/60 p-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full space-y-1.5 sm:w-64">
          <Label htmlFor="audio-model-filter">模型名称</Label>
          <Select
            value={filters.model}
            onValueChange={model => onFiltersChange({ ...filters, model })}
            disabled={disabled}
          >
            <SelectTrigger id="audio-model-filter" className="w-full bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部模型（{totalCount}）</SelectItem>
              {filters.model !== "all" &&
                !modelOptions.some(
                  option => option.value === filters.model
                ) && (
                  <SelectItem value={filters.model}>
                    所选模型已无音频（0）
                  </SelectItem>
                )}
              {modelOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}（{option.count}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5 basis-64">
          <Label htmlFor="audio-keyword-filter">关键词检索</Label>
          <Input
            id="audio-keyword-filter"
            type="search"
            className="bg-white"
            placeholder="文件名、模型名称、已保存组别；空格或逗号分隔多个词"
            value={filters.query}
            disabled={disabled}
            onChange={event =>
              onFiltersChange({ ...filters, query: event.target.value })
            }
          />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox
            checked={filters.selectedOnly}
            disabled={disabled}
            onCheckedChange={checked =>
              onFiltersChange({ ...filters, selectedOnly: checked === true })
            }
          />
          仅看已选
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={
            disabled ||
            (filters.model === "all" && !filters.query && !filters.selectedOnly)
          }
          onClick={() =>
            onFiltersChange({ model: "all", query: "", selectedOnly: false })
          }
        >
          清除筛选
        </Button>
      </div>
      <p className="text-xs text-slate-500">
        模型与关键词同时满足；关键词不区分大小写，多个词匹配任一。切换筛选或翻页保留勾选；每页最多{" "}
        {AUDIO_PAGE_SIZE} 个音频。
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600" role="status">
          匹配 {matchingCount} / {totalCount} 个音频 · 已选 {selectedCount}{" "}
          个（当前筛选内 {selectedMatchingCount} 个）
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || matchingCount === selectedMatchingCount}
            onClick={onSelectMatches}
          >
            全选筛选结果（{matchingCount}）
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || selectedMatchingCount === 0}
            onClick={onDeselectMatches}
          >
            取消筛选结果（{selectedMatchingCount}）
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || selectedCount === 0}
            onClick={onClearSelection}
          >
            清空全部勾选
          </Button>
        </div>
      </div>
      {hiddenSelectedCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-amber-700">
          <span>
            有 {hiddenSelectedCount}{" "}
            个已选音频不在当前筛选结果中；批量编辑组别和移除仍会包含它们。
          </span>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            disabled={disabled}
            onClick={() =>
              onFiltersChange({ model: "all", query: "", selectedOnly: true })
            }
          >
            查看全部已选（{selectedCount}）
          </Button>
        </div>
      )}
    </section>
  );
}

export function AudioPagination({
  page,
  totalPages,
  pageCount,
  matchingCount,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  pageCount: number;
  matchingCount: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="my-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
      <span>
        第 {page} / {totalPages} 页 · 本页 {pageCount} 个 · 筛选结果共{" "}
        {matchingCount} 个；表头勾选包含全部筛选结果。
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 1}
          onClick={() => onPageChange(page - 1)}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page === totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
