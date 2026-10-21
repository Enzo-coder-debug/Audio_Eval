import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";

vi.mock("./db", () => ({
  getQuestionnaireById: vi.fn(),
  getAudioFilesByQuestionnaire: vi.fn(),
  updateAudioGroupLabels: vi.fn(),
  updateAudioFile: vi.fn(),
  rebuildBlindTestPairsForQuestionnaire: vi.fn(),
  deleteAnswersByResponse: vi.fn(),
}));

const caller = appRouter.createCaller({
  user: { id: 1, role: "admin" },
  req: { headers: {} },
  res: {},
} as TrpcContext);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.getQuestionnaireById).mockResolvedValue({
    id: 1,
    creatorId: 1,
  } as any);
  vi.mocked(db.getAudioFilesByQuestionnaire).mockResolvedValue([
    { id: 10, questionnaireId: 1, modelName: "model-a", groupLabel: "A" },
    { id: 11, questionnaireId: 1, modelName: "model-b", groupLabel: "A" },
    { id: 12, questionnaireId: 1, modelName: "model-a", groupLabel: "B" },
    { id: 13, questionnaireId: 1, modelName: "__reference__" },
  ] as any);
  vi.mocked(db.updateAudioGroupLabels).mockResolvedValue(undefined);
});

describe("批量编辑音频组别", () => {
  it("仅提交勾选音频，去除首尾空白，统一批量保存", async () => {
    await expect(
      caller.audio.updateGroupLabels({
        questionnaireId: 1,
        items: [
          { audioFileId: 10, groupLabel: "  开心  " },
          { audioFileId: 11, groupLabel: "  开心  " },
        ],
      })
    ).resolves.toEqual({ success: true });

    expect(db.updateAudioGroupLabels).toHaveBeenCalledOnce();
    expect(db.updateAudioGroupLabels).toHaveBeenCalledWith(1, [
      { audioFileId: 10, groupLabel: "开心" },
      { audioFileId: 11, groupLabel: "开心" },
    ]);
    expect(db.updateAudioFile).not.toHaveBeenCalled();
    expect(db.rebuildBlindTestPairsForQuestionnaire).not.toHaveBeenCalled();
    expect(db.deleteAnswersByResponse).not.toHaveBeenCalled();
  });

  it("允许清空所选组别，并兼容逐行编辑后批量保存不同组别", async () => {
    await caller.audio.updateGroupLabels({
      questionnaireId: 1,
      items: [
        { audioFileId: 10, groupLabel: "  " },
        { audioFileId: 11, groupLabel: " B " },
      ],
    });

    expect(db.updateAudioGroupLabels).toHaveBeenCalledWith(1, [
      { audioFileId: 10, groupLabel: "" },
      { audioFileId: 11, groupLabel: "B" },
    ]);
  });

  it.each([13, 999])(
    "参考音频或不属于当前问卷的音频 %i 导致整批拒绝",
    async audioFileId => {
      await expect(
        caller.audio.updateGroupLabels({
          questionnaireId: 1,
          items: [
            { audioFileId: 10, groupLabel: "new" },
            { audioFileId, groupLabel: "new" },
          ],
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(db.updateAudioGroupLabels).not.toHaveBeenCalled();
      expect(db.updateAudioFile).not.toHaveBeenCalled();
    }
  );

  it("拒绝重复提交同一音频", async () => {
    await expect(
      caller.audio.updateGroupLabels({
        questionnaireId: 1,
        items: [
          { audioFileId: 10, groupLabel: "A" },
          { audioFileId: 10, groupLabel: "B" },
        ],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.updateAudioGroupLabels).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [{ audioFileId: 10, groupLabel: "组".repeat(256) }],
    [{ audioFileId: -1, groupLabel: "A" }],
    [{ audioFileId: 1.5, groupLabel: "A" }],
  ])("拒绝无效输入 %#", async items => {
    await expect(
      caller.audio.updateGroupLabels({ questionnaireId: 1, items })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.updateAudioGroupLabels).not.toHaveBeenCalled();
  });

  it("允许保存 255 个字符的组别", async () => {
    const groupLabel = "组".repeat(255);
    await caller.audio.updateGroupLabels({
      questionnaireId: 1,
      items: [{ audioFileId: 10, groupLabel }],
    });
    expect(db.updateAudioGroupLabels).toHaveBeenCalledWith(1, [
      { audioFileId: 10, groupLabel },
    ]);
  });

  it.each([undefined, { id: 1, creatorId: 2 }])(
    "拒绝修改他人或不存在的问卷 %#",
    async questionnaire => {
      vi.mocked(db.getQuestionnaireById).mockResolvedValue(
        questionnaire as any
      );
      await expect(
        caller.audio.updateGroupLabels({
          questionnaireId: 1,
          items: [{ audioFileId: 10, groupLabel: "A" }],
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(db.updateAudioGroupLabels).not.toHaveBeenCalled();
    }
  );

  it("普通用户无权编辑组别", async () => {
    const userCaller = appRouter.createCaller({
      user: { id: 1, role: "user" },
      req: { headers: {} },
      res: {},
    } as TrpcContext);
    await expect(
      userCaller.audio.updateGroupLabels({
        questionnaireId: 1,
        items: [{ audioFileId: 10, groupLabel: "A" }],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.updateAudioGroupLabels).not.toHaveBeenCalled();
  });

  it("批量写入失败时返回错误，不误报成功", async () => {
    vi.mocked(db.updateAudioGroupLabels).mockRejectedValue(
      new Error("write failed")
    );
    await expect(
      caller.audio.updateGroupLabels({
        questionnaireId: 1,
        items: [{ audioFileId: 10, groupLabel: "A" }],
      })
    ).rejects.toThrow("write failed");
  });
});
