import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { filterGroupLabels, updateGroupSelection } from "@/lib/groupSelection";

type GroupLabelPickerProps = {
  label: string;
  availableLabels: readonly string[];
  selectedLabels: readonly string[];
  onChange: (labels: string[]) => void;
  assignedElsewhere?: ReadonlyMap<string, string>;
  disabled?: boolean;
};

const PAGE_SIZE = 100;
const NO_ASSIGNMENTS = new Map<string, string>();

export function GroupLabelPicker({
  label,
  availableLabels,
  selectedLabels,
  onChange,
  assignedElsewhere = NO_ASSIGNMENTS,
  disabled = false,
}: GroupLabelPickerProps) {
  const pickerId = useId();
  const [query, setQuery] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const availableSet = useMemo(
    () => new Set(availableLabels),
    [availableLabels]
  );
  const selectedSet = useMemo(() => new Set(selectedLabels), [selectedLabels]);
  const missingLabels = useMemo(
    () => selectedLabels.filter(value => !availableSet.has(value)),
    [selectedLabels, availableSet]
  );
  const matchingLabels = useMemo(() => {
    const labels = Array.from(new Set([...availableLabels, ...missingLabels]));
    return filterGroupLabels(labels, query).filter(
      value => !selectedOnly || selectedSet.has(value)
    );
  }, [availableLabels, missingLabels, query, selectedOnly, selectedSet]);
  const selectableLabels = matchingLabels.filter(
    value => availableSet.has(value) && !assignedElsewhere.has(value)
  );
  const unselectedCount = selectableLabels.filter(
    value => !selectedSet.has(value)
  ).length;
  const selectedMatching = matchingLabels.filter(value =>
    selectedSet.has(value)
  );
  const blockedCount = matchingLabels.filter(value =>
    assignedElsewhere.has(value)
  ).length;
  const totalPages = Math.max(1, Math.ceil(matchingLabels.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageLabels = matchingLabels.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  return (
    <section role="group" aria-label={label} className="min-w-0 space-y-3">
      <Input
        type="search"
        aria-label={`${label}筛选`}
        placeholder="搜索组别；多个关键词用空格或逗号分隔"
        value={query}
        disabled={disabled}
        onChange={event => {
          setQuery(event.target.value);
          setPage(1);
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-slate-600" aria-live="polite">
          已选 {selectedSet.size} / 共 {availableSet.size} 组 · 筛选结果{" "}
          {matchingLabels.length} 组
        </span>
        <label
          htmlFor={`${pickerId}-selected`}
          className="flex cursor-pointer items-center gap-2"
        >
          <Checkbox
            id={`${pickerId}-selected`}
            checked={selectedOnly}
            disabled={disabled}
            onCheckedChange={checked => {
              setSelectedOnly(checked === true);
              setPage(1);
            }}
          />
          仅看已选
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || unselectedCount === 0}
          onClick={() =>
            onChange(
              updateGroupSelection(selectedLabels, selectableLabels, "select")
            )
          }
        >
          全选筛选结果（{selectableLabels.length}）
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || selectedMatching.length === 0}
          onClick={() =>
            onChange(
              updateGroupSelection(selectedLabels, matchingLabels, "deselect")
            )
          }
        >
          取消筛选结果（{selectedMatching.length}）
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || selectedSet.size === 0}
          onClick={() => onChange([])}
        >
          清空已选
        </Button>
      </div>
      <p className="text-xs text-slate-500">
        关键词匹配任意一个即可；批量操作覆盖全部筛选结果（不只当前页），其他组别的选择保持不变。
        {blockedCount > 0 &&
          ` 其中 ${blockedCount} 组已分配给其他情绪，全选时自动跳过。`}
      </p>
      {missingLabels.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-red-600"
          role="status"
        >
          有 {missingLabels.length} 个已选组别已不存在，请移除后保存。
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() =>
              onChange(
                updateGroupSelection(selectedLabels, missingLabels, "deselect")
              )
            }
          >
            移除失效组别
          </Button>
        </div>
      )}
      <ScrollArea
        key={`${currentPage}-${query}-${selectedOnly}`}
        type="always"
        className="h-60 min-w-0 rounded-md border bg-slate-50/50"
      >
        <div className="p-2 pr-4" role="group" aria-label={`${label}列表`}>
          {pageLabels.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm text-slate-500">
              {availableLabels.length === 0 && missingLabels.length === 0
                ? "暂无组别，请先到「音频管理」为音频指定组别。"
                : "没有匹配的组别，请调整关键词或取消「仅看已选」。"}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {pageLabels.map((value, index) => {
                const selected = selectedSet.has(value);
                const missing = !availableSet.has(value);
                const owner = assignedElsewhere.get(value);
                const unavailable = missing || assignedElsewhere.has(value);
                const rowId = `${pickerId}-group-${index}`;
                return (
                  <label
                    key={value}
                    htmlFor={rowId}
                    className={`flex min-w-0 items-start gap-2 rounded-md p-2 text-sm ${selected ? "bg-blue-50" : "hover:bg-slate-100"} ${unavailable && !selected ? "cursor-not-allowed text-slate-400" : "cursor-pointer"}`}
                  >
                    <Checkbox
                      id={rowId}
                      className="mt-0.5"
                      checked={selected}
                      aria-label={`选择组别 ${value}`}
                      disabled={disabled || (unavailable && !selected)}
                      onCheckedChange={checked =>
                        onChange(
                          updateGroupSelection(
                            selectedLabels,
                            [value],
                            checked === true ? "select" : "deselect",
                            unavailable ? new Set([value]) : undefined
                          )
                        )
                      }
                    />
                    <span className="min-w-0 break-all">
                      {value}
                      {missing && (
                        <span className="block text-xs text-red-600">
                          组别已不存在，可取消选择
                        </span>
                      )}
                      {owner !== undefined && (
                        <span className="block text-xs text-slate-500">
                          已分配给「{owner}」
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            第 {currentPage} / {totalPages} 页，每页最多 {PAGE_SIZE} 组
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
            >
              上一页
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || currentPage === totalPages}
              onClick={() => setPage(currentPage + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
