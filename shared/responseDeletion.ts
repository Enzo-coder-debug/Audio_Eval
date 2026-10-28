import { z } from "zod";

export const MAX_RESPONSE_DELETE_BATCH = 500;

export const responseDeletionIdsSchema = z
  .array(z.number().int().positive())
  .min(1, "请先选择要删除的答卷")
  .max(
    MAX_RESPONSE_DELETE_BATCH,
    `每批最多删除 ${MAX_RESPONSE_DELETE_BATCH} 份答卷`
  )
  .refine(ids => new Set(ids).size === ids.length, "不能重复选择同一份答卷");

export type ResponseDeletionTarget = {
  id: number;
  visitorName: string | null;
  status: string;
  subQuestionnaireIndex: number | null;
};
