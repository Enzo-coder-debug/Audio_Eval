import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import { summarizeResponses } from "../shared/responseStats";
import { MAX_RESPONSE_DELETE_BATCH } from "../shared/responseDeletion";

vi.mock("./db", () => ({
  deleteQuestionnaireResponse: vi.fn(),
  deleteQuestionnaireResponses: vi.fn(),
}));

function caller(user: { id: number; role: string } | null) {
  return appRouter.createCaller({
    user,
    req: { headers: {} },
    res: {},
  } as TrpcContext);
}

beforeEach(() => vi.resetAllMocks());

describe("管理员删除单份答卷", () => {
  it("将问卷、答卷和当前管理员身份一起交给事务校验", async () => {
    vi.mocked(db.deleteQuestionnaireResponse).mockResolvedValue({
      success: true,
      responseId: 23,
      releasedQuota: 1,
    } as any);
    await expect(
      caller({ id: 41, role: "admin" }).response.delete({
        questionnaireId: 12,
        responseId: 23,
      })
    ).resolves.toMatchObject({ success: true, releasedQuota: 1 });
    expect(db.deleteQuestionnaireResponse).toHaveBeenCalledOnce();
    expect(db.deleteQuestionnaireResponse).toHaveBeenCalledWith(12, 23, 41);
  });

  it.each([null, { id: 41, role: "user" }])(
    "非管理员不能删除答卷：%j",
    async user => {
      await expect(
        caller(user).response.delete({ questionnaireId: 12, responseId: 23 })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(db.deleteQuestionnaireResponse).not.toHaveBeenCalled();
    }
  );

  it.each([
    { questionnaireId: 0, responseId: 1 },
    { questionnaireId: 1, responseId: -1 },
    { questionnaireId: 1.5, responseId: 1 },
    { questionnaireId: 1, responseId: 2.5 },
  ])("拒绝非法 ID：%j", async input => {
    await expect(
      caller({ id: 41, role: "admin" }).response.delete(input)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.deleteQuestionnaireResponse).not.toHaveBeenCalled();
  });

  it.each(["FORBIDDEN", "NOT_FOUND"] as const)(
    "保留事务中的权限或不存在错误：%s",
    async code => {
      vi.mocked(db.deleteQuestionnaireResponse).mockRejectedValue(
        new TRPCError({ code })
      );
      await expect(
        caller({ id: 41, role: "admin" }).response.delete({
          questionnaireId: 12,
          responseId: 23,
        })
      ).rejects.toMatchObject({ code });
    }
  );
});

describe("批量删除答卷接口", () => {
  it("一次调用传递全部 ID 与当前管理员，不能伪造管理员身份", async () => {
    vi.mocked(db.deleteQuestionnaireResponses).mockResolvedValue({
      success: true,
      responseIds: [23, 24],
      deletedCount: 2,
      releasedQuota: 2,
    } as any);
    await expect(
      caller({ id: 41, role: "admin" }).response.deleteBatch({
        questionnaireId: 12,
        responseIds: [23, 24],
        creatorId: 999,
      } as any)
    ).resolves.toMatchObject({ deletedCount: 2, releasedQuota: 2 });
    expect(db.deleteQuestionnaireResponses).toHaveBeenCalledOnce();
    expect(db.deleteQuestionnaireResponses).toHaveBeenCalledWith(
      12,
      [23, 24],
      41
    );
    expect(db.deleteQuestionnaireResponse).not.toHaveBeenCalled();
  });

  it.each([null, { id: 41, role: "user" }])(
    "非管理员不能批量删除：%j",
    async user => {
      await expect(
        caller(user).response.deleteBatch({
          questionnaireId: 12,
          responseIds: [23, 24],
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(db.deleteQuestionnaireResponses).not.toHaveBeenCalled();
    }
  );

  it.each([
    { questionnaireId: 0, responseIds: [1] },
    { questionnaireId: 1, responseIds: [] },
    { questionnaireId: 1, responseIds: [1, 1] },
    { questionnaireId: 1, responseIds: [1, -2] },
    { questionnaireId: 1, responseIds: [0] },
    { questionnaireId: 1, responseIds: [1.5] },
  ])("整批拒绝空选、重复或非法 ID：%j", async input => {
    await expect(
      caller({ id: 41, role: "admin" }).response.deleteBatch(input)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.deleteQuestionnaireResponses).not.toHaveBeenCalled();
  });

  it("接受批次上限，超过上限不触发删除", async () => {
    const ids = Array.from(
      { length: MAX_RESPONSE_DELETE_BATCH },
      (_, index) => index + 1
    );
    vi.mocked(db.deleteQuestionnaireResponses).mockResolvedValue({
      success: true,
      deletedCount: ids.length,
    } as any);
    await caller({ id: 41, role: "admin" }).response.deleteBatch({
      questionnaireId: 12,
      responseIds: ids,
    });
    expect(db.deleteQuestionnaireResponses).toHaveBeenCalledWith(12, ids, 41);
    vi.mocked(db.deleteQuestionnaireResponses).mockClear();
    await expect(
      caller({ id: 41, role: "admin" }).response.deleteBatch({
        questionnaireId: 12,
        responseIds: [...ids, MAX_RESPONSE_DELETE_BATCH + 1],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.deleteQuestionnaireResponses).not.toHaveBeenCalled();
  });

  it.each(["FORBIDDEN", "NOT_FOUND", "INTERNAL_SERVER_ERROR"] as const)(
    "整批失败不误报成功：%s",
    async code => {
      vi.mocked(db.deleteQuestionnaireResponses).mockRejectedValue(
        new TRPCError({ code })
      );
      await expect(
        caller({ id: 41, role: "admin" }).response.deleteBatch({
          questionnaireId: 12,
          responseIds: [23, 24],
        })
      ).rejects.toMatchObject({ code });
    }
  );
});

describe("答卷数量和评分统计", () => {
  it("已提交与已评分都计入完成数，量化答卷不虚构总分", () => {
    expect(
      summarizeResponses([
        { status: "in_progress", totalScore: null },
        { status: "submitted", totalScore: null },
        { status: "graded", totalScore: "8.00" },
        { status: "graded", totalScore: "0.00" },
      ])
    ).toEqual({
      totalResponses: 4,
      completedResponses: 3,
      inProgressResponses: 1,
      completionRate: 75,
      averageScore: 4,
      highestScore: 8,
      lowestScore: 0,
    });
  });

  it("删空后数量与完成率归零，旧分数统计不保留", () => {
    expect(summarizeResponses([])).toEqual({
      totalResponses: 0,
      completedResponses: 0,
      inProgressResponses: 0,
      completionRate: 0,
      averageScore: null,
      highestScore: null,
      lowestScore: null,
    });
  });

  it("无有效总分时仍准确统计提交次数", () => {
    expect(
      summarizeResponses([
        { status: "submitted" },
        { status: "graded", totalScore: null },
        { status: "graded", totalScore: "not-a-number" },
      ])
    ).toMatchObject({
      totalResponses: 3,
      completedResponses: 3,
      completionRate: 100,
      averageScore: null,
    });
  });
});
