import { z } from "zod";

const dimensionIdsSchema = z
  .array(z.number().int().positive())
  .min(1, "至少需要一个测评维度")
  .refine(ids => new Set(ids).size === ids.length, "测评维度不能重复");

export const dimensionOrderSchema = z
  .object({
    questionnaireId: z.number().int().positive(),
    expectedDimensionIds: dimensionIdsSchema,
    orderedDimensionIds: dimensionIdsSchema,
  })
  .strict()
  .refine(input => {
    const expectedIds = new Set(input.expectedDimensionIds);
    return (
      input.orderedDimensionIds.length === expectedIds.size &&
      input.orderedDimensionIds.every(id => expectedIds.has(id))
    );
  }, "排序必须包含当前问卷的全部测评维度，不能新增或遗漏");

export function moveDimension(
  dimensionIds: readonly number[],
  dimensionId: number,
  direction: -1 | 1
) {
  const orderedIds = [...dimensionIds];
  const currentIndex = orderedIds.indexOf(dimensionId);
  const targetIndex = currentIndex + direction;
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= orderedIds.length)
    return orderedIds;
  [orderedIds[currentIndex], orderedIds[targetIndex]] = [
    orderedIds[targetIndex],
    orderedIds[currentIndex],
  ];
  return orderedIds;
}
