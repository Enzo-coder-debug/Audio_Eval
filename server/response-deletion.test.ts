import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import { summarizeResponses } from "../shared/responseStats";

vi.mock("./db", () => ({ deleteQuestionnaireResponse: vi.fn() }));

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
