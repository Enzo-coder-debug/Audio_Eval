import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";

vi.mock("./db", () => ({
  getQuestionnaireById: vi.fn(),
  getQuestionnaireByShareToken: vi.fn(),
  updateQuestionnaire: vi.fn(),
  getBlindTestPairsByQuestionnaire: vi.fn(),
  getEvaluationDimensionsByQuestionnaire: vi.fn(),
  deleteResponsesByQuestionnaire: vi.fn(),
  deleteBlindTestPairsByQuestionnaire: vi.fn(),
  deleteEvaluationDimensionsByQuestionnaire: vi.fn(),
  updateAudioFile: vi.fn(),
}));

const questionnaire = {
  id: 1,
  creatorId: 1,
  title: "背景编辑测试",
  evaluationCopywriting: "原测评背景",
  scoringStandard: "原评分标准",
  status: "published",
  shareToken: "existing-share-token",
};
const caller = appRouter.createCaller({
  user: { id: 1, role: "admin" },
  req: { headers: {} },
  res: {},
} as TrpcContext);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.getQuestionnaireById).mockResolvedValue(questionnaire as any);
  vi.mocked(db.getBlindTestPairsByQuestionnaire).mockResolvedValue([]);
  vi.mocked(db.getEvaluationDimensionsByQuestionnaire).mockResolvedValue([]);
});

describe("创建后编辑测评背景", () => {
  it.each(["draft", "published", "offline"])(
    "%s 问卷只更新背景，保留多行内容，不修改其他数据",
    async status => {
      vi.mocked(db.getQuestionnaireById).mockResolvedValue({
        ...questionnaire,
        status,
      } as any);

      await expect(
        caller.questionnaire.update({
          id: 1,
          evaluationCopywriting: "  新背景\n\n请比较情绪表达。  ",
        })
      ).resolves.toMatchObject({ success: true, dimensionsUpdated: false });

      expect(db.updateQuestionnaire).toHaveBeenCalledOnce();
      expect(db.updateQuestionnaire).toHaveBeenCalledWith(1, {
        evaluationCopywriting: "新背景\n\n请比较情绪表达。",
      });
      expect(db.deleteResponsesByQuestionnaire).not.toHaveBeenCalled();
      expect(db.deleteBlindTestPairsByQuestionnaire).not.toHaveBeenCalled();
      expect(
        db.deleteEvaluationDimensionsByQuestionnaire
      ).not.toHaveBeenCalled();
      expect(db.updateAudioFile).not.toHaveBeenCalled();
    }
  );

  it("保存后分享问卷读取新背景，链接和发布状态不变", async () => {
    let stored = { ...questionnaire };
    vi.mocked(db.updateQuestionnaire).mockImplementation(
      async (_id, updates) => {
        stored = { ...stored, ...updates };
        return {} as any;
      }
    );
    vi.mocked(db.getQuestionnaireByShareToken).mockImplementation(
      async () => stored as any
    );

    await caller.questionnaire.update({
      id: 1,
      evaluationCopywriting: "更新后的公开测评背景",
    });
    const publicCaller = appRouter.createCaller({
      user: null,
      req: { headers: {} },
      res: {},
    } as TrpcContext);
    await expect(
      publicCaller.questionnaire.getByShareToken({
        shareToken: questionnaire.shareToken,
      })
    ).resolves.toMatchObject({
      evaluationCopywriting: "更新后的公开测评背景",
      shareToken: questionnaire.shareToken,
      status: "published",
      scoringStandard: questionnaire.scoringStandard,
    });
  });

  it.each(["", "   ", "\n\t"])("拒绝空背景 %j", async evaluationCopywriting => {
    await expect(
      caller.questionnaire.update({ id: 1, evaluationCopywriting })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.updateQuestionnaire).not.toHaveBeenCalled();
  });

  it("未提交背景字段时不影响重命名等已有操作", async () => {
    await caller.questionnaire.update({ id: 1, title: "新问卷名称" });
    expect(db.updateQuestionnaire).toHaveBeenCalledWith(1, {
      title: "新问卷名称",
    });
  });

  it("允许为历史空背景问卷补充内容", async () => {
    vi.mocked(db.getQuestionnaireById).mockResolvedValue({
      ...questionnaire,
      evaluationCopywriting: null,
    } as any);
    await caller.questionnaire.update({
      id: 1,
      evaluationCopywriting: "补充背景",
    });
    expect(db.updateQuestionnaire).toHaveBeenCalledWith(1, {
      evaluationCopywriting: "补充背景",
    });
  });

  it.each([undefined, { ...questionnaire, creatorId: 2 }])(
    "拒绝不存在或其他管理员的问卷 %#",
    async result => {
      vi.mocked(db.getQuestionnaireById).mockResolvedValue(result as any);
      await expect(
        caller.questionnaire.update({ id: 1, evaluationCopywriting: "新背景" })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(db.updateQuestionnaire).not.toHaveBeenCalled();
    }
  );

  it.each([null, { id: 1, role: "user" }])(
    "匿名和非管理员用户不可编辑 %#",
    async user => {
      const unprivileged = appRouter.createCaller({
        user,
        req: { headers: {} },
        res: {},
      } as TrpcContext);
      await expect(
        unprivileged.questionnaire.update({
          id: 1,
          evaluationCopywriting: "新背景",
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(db.updateQuestionnaire).not.toHaveBeenCalled();
    }
  );

  it("数据库写入失败不误报保存成功", async () => {
    vi.mocked(db.updateQuestionnaire).mockRejectedValue(
      new Error("write failed")
    );
    await expect(
      caller.questionnaire.update({ id: 1, evaluationCopywriting: "新背景" })
    ).rejects.toThrow("write failed");
  });
});
