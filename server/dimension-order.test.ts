import { beforeEach, describe, expect, it, vi } from "vitest";
import { dimensionOrderSchema, moveDimension } from "../shared/dimensionOrder";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";

vi.mock("./db", () => ({ reorderEvaluationDimensions: vi.fn() }));

const input = {
  questionnaireId: 7,
  expectedDimensionIds: [11, 12, 13],
  orderedDimensionIds: [13, 11, 12],
};
const makeCaller = (user: { id: number; role: string } | null) =>
  appRouter.createCaller({
    user,
    req: { headers: {} },
    res: {},
  } as TrpcContext);

beforeEach(() => vi.resetAllMocks());

describe("测评维度上下移动", () => {
  it.each([
    { id: 12, direction: -1 as const, expected: [12, 11, 13] },
    { id: 12, direction: 1 as const, expected: [11, 13, 12] },
    { id: 11, direction: -1 as const, expected: [11, 12, 13] },
    { id: 13, direction: 1 as const, expected: [11, 12, 13] },
    { id: 99, direction: -1 as const, expected: [11, 12, 13] },
  ])(
    "移动 $id / $direction，边界不变且不修改原列表",
    ({ id, direction, expected }) => {
      const original = [11, 12, 13];
      expect(moveDimension(original, id, direction)).toEqual(expected);
      expect(original).toEqual([11, 12, 13]);
    }
  );

  it("支持空列表和单个维度", () => {
    expect(moveDimension([], 1, 1)).toEqual([]);
    expect(moveDimension([1], 1, 1)).toEqual([1]);
    expect(moveDimension([1], 1, -1)).toEqual([1]);
  });
});

describe("排序接口权限和完整列表校验", () => {
  it("保存完整顺序，并使用登录管理员身份", async () => {
    const result = {
      success: true,
      orderedDimensionIds: input.orderedDimensionIds,
    };
    vi.mocked(db.reorderEvaluationDimensions).mockResolvedValue(result);
    await expect(
      makeCaller({ id: 42, role: "admin" }).dimension.reorder(input)
    ).resolves.toEqual(result);
    expect(db.reorderEvaluationDimensions).toHaveBeenCalledWith(input, 42);
  });

  it.each([null, { id: 42, role: "user" }])(
    "非管理员不能排序：%j",
    async user => {
      await expect(
        makeCaller(user).dimension.reorder(input)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(db.reorderEvaluationDimensions).not.toHaveBeenCalled();
    }
  );

  it.each([
    { questionnaireId: 0 },
    { orderedDimensionIds: [] },
    { expectedDimensionIds: [] },
    { orderedDimensionIds: [11, 11, 12] },
    { expectedDimensionIds: [11, 11, 12] },
    { orderedDimensionIds: [11, 12] },
    { orderedDimensionIds: [11, 12, 99] },
    { orderedDimensionIds: [11, 12, 13, 14] },
    { orderedDimensionIds: [11, 12, -1] },
    { orderedDimensionIds: [11, 12, 0.5] },
    { creatorId: 100 },
    { scoringConfig: { mode: "gsb" } },
  ])("拒绝非法或包含额外字段的请求：%j", async patch => {
    const invalid = { ...input, ...patch };
    expect(dimensionOrderSchema.safeParse(invalid).success).toBe(false);
    await expect(
      makeCaller({ id: 42, role: "admin" }).dimension.reorder(invalid)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.reorderEvaluationDimensions).not.toHaveBeenCalled();
  });
});
