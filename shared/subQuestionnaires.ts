import { z } from "zod";

export const subQuestionnairePlanSchema = z.object({
  version: z.literal(1),
  groupsPerForm: z.number().int().min(1).max(10000),
  forms: z
    .array(
      z.object({
        index: z.number().int().positive(),
        groupLabels: z.array(z.string().min(1)).min(1),
        pairIds: z.array(z.number().int().positive()).min(1),
        quota: z.number().int().min(1).max(10000),
      })
    )
    .min(1)
    .max(100),
});

export type SubQuestionnairePlan = z.infer<typeof subQuestionnairePlanSchema>;

export function readSubQuestionnairePlan(
  raw: unknown
): SubQuestionnairePlan | null {
  if (raw == null) return null;
  const plan = subQuestionnairePlanSchema.parse(
    typeof raw === "string" ? JSON.parse(raw) : raw
  );
  const labels = plan.forms.flatMap(form => form.groupLabels);
  const pairs = plan.forms.flatMap(form => form.pairIds);
  if (
    new Set(labels).size !== labels.length ||
    new Set(pairs).size !== pairs.length ||
    plan.forms.some((form, index) => form.index !== index + 1)
  ) {
    throw new Error("子问卷配置损坏，请联系管理员");
  }
  return plan;
}

export function buildSubQuestionnairePlan(
  groups: { label: string; pairIds: number[] }[],
  groupsPerForm: number,
  quota: number,
  random: () => number = Math.random
): SubQuestionnairePlan {
  if (
    !Number.isInteger(groupsPerForm) ||
    groupsPerForm < 1 ||
    groupsPerForm > 10000 ||
    groups.length === 0 ||
    Math.ceil(groups.length / groupsPerForm) > 100
  ) {
    throw new Error(
      "每张组别数必须为 1–10000 的整数，题库不能为空，生成子问卷最多 100 张"
    );
  }
  const shuffled = [...groups];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  const formCount = Math.ceil(groups.length / groupsPerForm);
  const forms = Array.from({ length: formCount }, (_, index) => {
    const selected = shuffled.slice(
      index * groupsPerForm,
      (index + 1) * groupsPerForm
    );
    return {
      index: index + 1,
      groupLabels: selected.map(group => group.label),
      pairIds: selected.flatMap(group => group.pairIds),
      quota,
    };
  });
  return readSubQuestionnairePlan({ version: 1, groupsPerForm, forms })!;
}

export function summarizeSubQuestionnaires(
  plan: SubQuestionnairePlan,
  responses: { subQuestionnaireIndex: number | null; status: string }[]
) {
  return plan.forms.map(form => {
    const assigned = responses.filter(
      response => response.subQuestionnaireIndex === form.index
    );
    const completed = assigned.filter(
      response =>
        response.status === "submitted" || response.status === "graded"
    ).length;
    return {
      ...form,
      assigned: assigned.length,
      completed,
      inProgress: assigned.length - completed,
      remaining: Math.max(0, form.quota - assigned.length),
    };
  });
}
