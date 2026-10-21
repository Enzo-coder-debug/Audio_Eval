import { describe, expect, it } from "vitest";
import {
  filterGroupLabels,
  updateGroupSelection,
} from "../client/src/lib/groupSelection";

const labels = [
  "开心-001",
  "开心-002",
  "悲伤-003",
  "Query-A04",
  "query-B05",
  "组别,原始标点",
];

describe("特殊维度组别筛选", () => {
  it("空白筛选保留全部组别及原有顺序", () => {
    expect(filterGroupLabels(labels, " \t，,；; ")).toEqual(labels);
  });

  it("中文关键词进行包含匹配", () => {
    expect(filterGroupLabels(labels, "开心")).toEqual(["开心-001", "开心-002"]);
  });

  it("不区分大小写，不修改保存的组别文本", () => {
    expect(filterGroupLabels(labels, " QUERY-a ")).toEqual(["Query-A04"]);
  });

  it.each(["开心 悲伤", "开心,悲伤", "开心，悲伤", "开心；悲伤", "开心\n悲伤"])(
    "多个关键词匹配任一：%s",
    query => {
      expect(filterGroupLabels(labels, query)).toEqual(labels.slice(0, 3));
    }
  );

  it("数字按文本匹配，保留前导零", () => {
    expect(filterGroupLabels(labels, "001")).toEqual(["开心-001"]);
  });

  it("按普通文本而非正则匹配，找不到时返回空数组", () => {
    expect(filterGroupLabels(labels, ".*")).toEqual([]);
    expect(filterGroupLabels(labels, "不存在")).toEqual([]);
  });
});

describe("特殊维度批量选择", () => {
  it("全选筛选结果与现有选择合并，不覆盖筛选外已选项", () => {
    const selected = ["悲伤-003", "开心-001"];
    const result = updateGroupSelection(
      selected,
      filterGroupLabels(labels, "开心"),
      "select"
    );
    expect(result).toEqual(["悲伤-003", "开心-001", "开心-002"]);
    expect(selected).toEqual(["悲伤-003", "开心-001"]);
  });

  it("重复全选不产生重复项", () => {
    const selected = updateGroupSelection([], labels, "select");
    expect(updateGroupSelection(selected, labels, "select")).toEqual(selected);
  });

  it("取消筛选结果只移除命中的选择", () => {
    expect(
      updateGroupSelection(
        labels,
        filterGroupLabels(labels, "开心"),
        "deselect"
      )
    ).toEqual(labels.slice(2));
  });

  it("空筛选结果批量操作不影响已有选择", () => {
    expect(updateGroupSelection(labels, [], "select")).toEqual(labels);
    expect(updateGroupSelection(labels, [], "deselect")).toEqual(labels);
  });

  it("情绪类别全选跳过其他类别占用的组别", () => {
    const assignedElsewhere = new Set(["开心-002", "悲伤-003"]);
    expect(
      updateGroupSelection(["开心-001"], labels, "select", assignedElsewhere)
    ).toEqual(["开心-001", "Query-A04", "query-B05", "组别,原始标点"]);
  });

  it("仍允许取消冲突的历史选择，以修复重复分配", () => {
    expect(
      updateGroupSelection(
        ["开心-001", "开心-002"],
        ["开心-002"],
        "deselect",
        new Set(["开心-002"])
      )
    ).toEqual(["开心-001"]);
  });

  it("支持移除已不存在的选择而不影响有效组别", () => {
    expect(
      updateGroupSelection(["已删除", "开心-001"], ["已删除"], "deselect")
    ).toEqual(["开心-001"]);
  });

  it("800 组全选不限于列表的前 100 组", () => {
    const manyLabels = Array.from(
      { length: 800 },
      (_, index) => `组别-${String(index + 1).padStart(4, "0")}`
    );
    const matches = filterGroupLabels(manyLabels, "组别");
    const selected = updateGroupSelection([], matches, "select");
    expect(selected).toHaveLength(800);
    expect(selected).toContain("组别-0800");
    expect(
      updateGroupSelection(
        selected,
        filterGroupLabels(manyLabels, "组别-01"),
        "deselect"
      )
    ).toHaveLength(700);
  });

  it("跨情绪类别连续批选不会重复分配", () => {
    const happy = updateGroupSelection(
      [],
      filterGroupLabels(labels, "开心"),
      "select"
    );
    const other = updateGroupSelection([], labels, "select", new Set(happy));
    expect(other.some(label => happy.includes(label))).toBe(false);
    expect([...happy, ...other]).toHaveLength(labels.length);
  });
});
