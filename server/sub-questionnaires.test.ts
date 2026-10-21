import { describe, expect, it } from "vitest";
import {
  buildSubQuestionnairePlan,
  readSubQuestionnairePlan,
  summarizeSubQuestionnaires,
} from "../shared/subQuestionnaires";

const groups = Array.from({ length: 400 }, (_, index) => ({
  label: `组别-${String(index + 1).padStart(4, "0")}`,
  pairIds: [index * 3 + 1, index * 3 + 2, index * 3 + 3],
}));

describe("固定子问卷分组与名额", () => {
  it("400 组固定分成 8 张，每张 50 组、20 份，同组全部配对不拆开", () => {
    const plan = buildSubQuestionnairePlan(groups, 50, 20, () => 0.25);
    expect(plan.forms).toHaveLength(8);
    expect(
      plan.forms.every(
        form =>
          form.groupLabels.length === 50 &&
          form.pairIds.length === 150 &&
          form.quota === 20
      )
    ).toBe(true);
    expect(new Set(plan.forms.flatMap(form => form.groupLabels)).size).toBe(
      400
    );
    expect(new Set(plan.forms.flatMap(form => form.pairIds)).size).toBe(1200);
    for (const group of groups) {
      const form = plan.forms.find(item =>
        item.groupLabels.includes(group.label)
      )!;
      expect(group.pairIds.every(pairId => form.pairIds.includes(pairId))).toBe(
        true
      );
    }
    expect(groups[0].label).toBe("组别-0001");
  });

  it("不能整除时余数组别单独成卷，不遗漏", () => {
    const plan = buildSubQuestionnairePlan(groups.slice(0, 13), 5, 2);
    expect(plan.forms.map(form => form.groupLabels.length)).toEqual([5, 5, 3]);
  });

  it("每张组数超过题库时只生成一张实际组数的子问卷", () => {
    const plan = buildSubQuestionnairePlan(groups.slice(0, 7), 50, 20);
    expect(plan.forms).toHaveLength(1);
    expect(plan.forms[0].groupLabels).toHaveLength(7);
    expect(plan.forms[0].quota).toBe(20);
  });

  it.each([0, -1, 1.5, 10001, 1, NaN])(
    "拒绝无效组别数或超出100张限制 %s",
    count => {
      expect(() => buildSubQuestionnairePlan(groups, count, 20)).toThrow();
    }
  );

  it.each([0, -1, 0.5, 10001])("拒绝无效份数 %s", quota => {
    expect(() => buildSubQuestionnairePlan(groups, 50, quota)).toThrow();
  });

  it("不允许零组或空配对生成可领取子问卷", () => {
    expect(() => buildSubQuestionnairePlan([], 1, 1)).toThrow();
    expect(() =>
      buildSubQuestionnairePlan([{ label: "x", pairIds: [] }], 1, 1)
    ).toThrow();
  });

  it("兼容存量空方案、JSON 字符串，并拒绝损坏/重复内容", () => {
    const plan = buildSubQuestionnairePlan(groups, 50, 20);
    expect(readSubQuestionnairePlan(null)).toBeNull();
    expect(readSubQuestionnairePlan(undefined)).toBeNull();
    expect(readSubQuestionnairePlan(JSON.stringify(plan))).toEqual(plan);
    expect(() => readSubQuestionnairePlan("broken")).toThrow();
    expect(() =>
      readSubQuestionnairePlan({
        ...plan,
        forms: [plan.forms[0], plan.forms[0]],
      })
    ).toThrow();
  });

  it("进行中、已提交、已评分均计入限额，满额不出现负数", () => {
    const plan = buildSubQuestionnairePlan(groups, 50, 2);
    const summary = summarizeSubQuestionnaires(plan, [
      { subQuestionnaireIndex: 1, status: "in_progress" },
      { subQuestionnaireIndex: 1, status: "submitted" },
      { subQuestionnaireIndex: 1, status: "graded" },
      { subQuestionnaireIndex: 2, status: "in_progress" },
      { subQuestionnaireIndex: null, status: "submitted" },
    ]);
    expect(summary[0]).toMatchObject({
      assigned: 3,
      inProgress: 1,
      completed: 2,
      remaining: 0,
    });
    expect(summary[1]).toMatchObject({ assigned: 1, remaining: 1 });
    expect(summary[2]).toMatchObject({ assigned: 0, remaining: 2 });
  });
});
