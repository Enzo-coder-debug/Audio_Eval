import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatResponsePairAudioLabel } from "../client/src/lib/responseAudioLabels";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";

vi.mock("./db", () => ({
  getQuestionnaireById: vi.fn(),
  getQuestionnaireResponses: vi.fn(),
  getBlindTestPairsByQuestionnaire: vi.fn(),
  getAudioFileById: vi.fn(),
  getAnswersByResponse: vi.fn(),
  updateAudioFile: vi.fn(),
  deleteResponsesByQuestionnaire: vi.fn(),
  deleteBlindTestPairsByQuestionnaire: vi.fn(),
}));

describe("答卷详情与导出保留原文件名", () => {
  it.each([
    "LiveTTS_V3_外呼_001.wav",
    "001.MP3",
    "客服.提示.V3.0008.m4a",
    "LiveTTS_V3",
    "欢迎语.wav",
    "模型A/外呼_0001.wav",
    "  外呼_001.wav  ",
  ])("完整展示 %s，不按末尾数字生成别名", fileName => {
    expect(
      formatResponsePairAudioLabel({
        leftFileName: fileName,
        rightFileName: fileName,
      })
    ).toBe(fileName);
  });

  it("末尾编号相同的不同文件不合并为同一个音频标签", () => {
    expect(
      formatResponsePairAudioLabel({
        leftFileName: "LiveTTS_V3_外呼_001.wav",
        rightFileName: "baseline_外呼_001.wav",
      })
    ).toBe("LiveTTS_V3_外呼_001.wav vs baseline_外呼_001.wav");
  });

  it("文件扩展名不同时仍区分两个完整名称", () => {
    expect(
      formatResponsePairAudioLabel({
        leftFileName: "外呼_001.wav",
        rightFileName: "外呼_001.mp3",
      })
    ).toBe("外呼_001.wav vs 外呼_001.mp3");
  });

  it.each([null, undefined, {}])("配对信息缺失时不编造原文件名 %j", pair => {
    expect(formatResponsePairAudioLabel(pair)).toBe(
      "左侧音频（文件名缺失） vs 右侧音频（文件名缺失）"
    );
  });

  it("单侧名称缺失时保留另一侧原名", () => {
    expect(
      formatResponsePairAudioLabel({
        leftFileName: " ",
        rightFileName: "LiveTTS_V3_001.wav",
      })
    ).toBe("左侧音频（文件名缺失） vs LiveTTS_V3_001.wav");
  });
});

describe("管理员历史答卷读取原始音频元数据", () => {
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
      title: "外呼LiveTTS V3 GSB问卷",
    } as any);
    vi.mocked(db.getQuestionnaireResponses).mockResolvedValue([
      { id: 5, questionnaireId: 1, status: "graded" },
    ] as any);
    vi.mocked(db.getBlindTestPairsByQuestionnaire).mockResolvedValue([
      { id: 8, pairIndex: 0, leftAudioFileId: 10, rightAudioFileId: 11 },
    ] as any);
    vi.mocked(db.getAudioFileById).mockImplementation(
      async audioId =>
        ({
          id: audioId,
          fileName:
            audioId === 10
              ? "LiveTTS_V3_外呼_001.wav"
              : "baseline_外呼_001.wav",
          modelName: audioId === 10 ? "LiveTTS V3" : "baseline",
        }) as any
    );
    vi.mocked(db.getAnswersByResponse).mockResolvedValue([
      { id: 20, responseId: 5, blindTestPairId: 8, blindTestChoice: "same" },
    ] as any);
  });

  it("从音频表读取完整文件名，保持历史配对与作答不变", async () => {
    const result = await caller.response.listQuestionnaire({
      questionnaireId: 1,
    });
    expect(result.pairsInfo[0]).toMatchObject({
      id: 8,
      leftFileName: "LiveTTS_V3_外呼_001.wav",
      rightFileName: "baseline_外呼_001.wav",
    });
    expect(formatResponsePairAudioLabel(result.pairsInfo[0])).toBe(
      "LiveTTS_V3_外呼_001.wav vs baseline_外呼_001.wav"
    );
    expect(result.responses[0].answers).toEqual([
      { id: 20, responseId: 5, blindTestPairId: 8, blindTestChoice: "same" },
    ]);
    expect(db.updateAudioFile).not.toHaveBeenCalled();
    expect(db.deleteResponsesByQuestionnaire).not.toHaveBeenCalled();
    expect(db.deleteBlindTestPairsByQuestionnaire).not.toHaveBeenCalled();
  });

  it("不向非问卷所属管理员泄露文件名或答卷", async () => {
    vi.mocked(db.getQuestionnaireById).mockResolvedValue({
      id: 1,
      creatorId: 2,
    } as any);
    await expect(
      caller.response.listQuestionnaire({ questionnaireId: 1 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.getAudioFileById).not.toHaveBeenCalled();
    expect(db.getQuestionnaireResponses).not.toHaveBeenCalled();
  });
});
