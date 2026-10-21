import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import { storagePut } from "./storage";
import {
  buildFilenameGroupUpdates,
  deriveGroupLabel,
} from "../shared/audioGroupLabels";

vi.mock("./db", () => ({
  getQuestionnaireById: vi.fn(),
  createQuestionnaire: vi.fn(),
  createEvaluationDimensions: vi.fn(),
  createAudioFile: vi.fn(),
  createBlindTestPairs: vi.fn(),
  fillMissingAudioGroupLabels: vi.fn(),
}));
vi.mock("./storage", () => ({
  storagePut: vi.fn(),
  buildAudioObjectKey: vi.fn(() => "test-key"),
  buildPublicUrl: vi.fn(),
}));

const caller = appRouter.createCaller({
  user: { id: 1, role: "admin" },
  req: { headers: {} },
  res: {},
} as TrpcContext);
const audio = {
  fileName: "开心.001.wav",
  fileData: "",
  mimeType: "audio/wav" as const,
  fileSizeBytes: 0,
  modelName: "模型I",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.getQuestionnaireById).mockResolvedValue({
    id: 1,
    creatorId: 1,
    title: "测试问卷",
  } as any);
  vi.mocked(db.createQuestionnaire).mockResolvedValue([{ insertId: 1 }] as any);
  vi.mocked(db.createAudioFile).mockResolvedValue([{ insertId: 10 }] as any);
  vi.mocked(db.fillMissingAudioGroupLabels).mockResolvedValue({
    updatedCount: 800,
  });
  vi.mocked(storagePut).mockResolvedValue({
    key: "test-key",
    url: "/test.wav",
  });
});

describe("文件名默认组别", () => {
  it.each([
    ["开心.001.wav", "开心.001"],
    ["001.MP3", "001"],
    ["模型I/开心.wav", "开心"],
    ["模型II\\开心.wav", "开心"],
    ["  开心 .m4a  ", "开心"],
    ["无扩展名", "无扩展名"],
    [".hidden", ".hidden"],
  ])("%s 推导为 %s", (filename, expected) => {
    expect(deriveGroupLabel(filename)).toBe(expected);
  });

  it.each([undefined, "人工分组", "", "  "])(
    "追加上传：省略时默认，显式传入时尊重用户设置 %j",
    async groupLabel => {
      await caller.audio.addToQuestionnaire({
        questionnaireId: 1,
        audios: [{ ...audio, groupLabel }],
      });
      expect(db.createAudioFile).toHaveBeenCalledWith(
        expect.objectContaining({
          groupLabel:
            groupLabel === undefined ? "开心.001" : groupLabel.trim() || null,
        })
      );
    }
  );

  it("旧版整批上传接口同样以文件名推导组别和配对", async () => {
    vi.mocked(db.createAudioFile)
      .mockResolvedValueOnce([{ insertId: 10 }] as any)
      .mockResolvedValueOnce([{ insertId: 11 }] as any);
    await caller.audio.upload({
      title: "测试问卷",
      evaluationCopywriting: "",
      audios: [audio, { ...audio, modelName: "模型II" }],
    });
    expect(db.createAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({ groupLabel: "开心.001" })
    );
    expect(db.createBlindTestPairs).toHaveBeenCalledWith([
      expect.objectContaining({ questionnaireId: 1, pairIndex: 0 }),
    ]);
  });

  it("新增与追加上传都在上传前拒绝过长的自定义组别", async () => {
    const audios = [{ ...audio, groupLabel: "组".repeat(256) }];
    await expect(
      caller.audio.addToQuestionnaire({ questionnaireId: 1, audios })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.audio.upload({
        title: "测试问卷",
        evaluationCopywriting: "",
        audios,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(storagePut).not.toHaveBeenCalled();
    expect(db.createQuestionnaire).not.toHaveBeenCalled();
  });
});

describe("历史音频按文件名补齐", () => {
  it("800 个音频生成 400 个同名组别，保留中文和前导零", () => {
    const audios = Array.from({ length: 800 }, (_, index) => ({
      id: index + 1,
      fileName: `开心-${String(index % 400).padStart(3, "0")}.wav`,
      modelName: index < 400 ? "模型I" : "模型II",
      groupLabel: null,
    }));
    const items = buildFilenameGroupUpdates(audios);
    expect(items).toHaveLength(800);
    expect(new Set(items.map(item => item.groupLabel)).size).toBe(400);
    expect(items[0].groupLabel).toBe("开心-000");
    expect(items[400].groupLabel).toBe("开心-000");
  });

  it("仅补 null/空白组别，保留已有组别，排除参考音频", () => {
    const audios = [
      { id: 1, fileName: "001.wav", groupLabel: null, modelName: "I" },
      { id: 2, fileName: "002.mp3", groupLabel: "  ", modelName: "II" },
      { id: 3, fileName: "003.wav", groupLabel: "人工组别", modelName: "I" },
      {
        id: 4,
        fileName: "参考.wav",
        groupLabel: null,
        modelName: "__reference__",
      },
    ];
    expect(buildFilenameGroupUpdates(audios)).toEqual([
      { audioFileId: 1, groupLabel: "001" },
      { audioFileId: 2, groupLabel: "002" },
    ]);
    expect(
      buildFilenameGroupUpdates(
        audios.map(item => ({
          ...item,
          groupLabel: item.groupLabel?.trim() ? item.groupLabel : "已补齐",
        }))
      )
    ).toEqual([]);
  });

  it.each(["", "   ", "路径/", "组".repeat(256)])(
    "无效文件名 %j 不静默写入空组别或截断",
    fileName => {
      expect(() =>
        buildFilenameGroupUpdates([
          { id: 1, fileName, groupLabel: null, modelName: "I" },
        ])
      ).toThrow("无法生成有效组别");
    }
  );

  it("仅为管理员所属问卷执行补齐并返回数量", async () => {
    await expect(
      caller.audio.fillMissingGroupLabels({ questionnaireId: 1 })
    ).resolves.toEqual({ updatedCount: 800 });
    expect(db.fillMissingAudioGroupLabels).toHaveBeenCalledWith(1);
  });

  it.each([undefined, { id: 1, creatorId: 2 }])(
    "拒绝缺失或他人的问卷 %#",
    async questionnaire => {
      vi.mocked(db.getQuestionnaireById).mockResolvedValue(
        questionnaire as any
      );
      await expect(
        caller.audio.fillMissingGroupLabels({ questionnaireId: 1 })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(db.fillMissingAudioGroupLabels).not.toHaveBeenCalled();
    }
  );

  it("普通用户无权触发补齐", async () => {
    const userCaller = appRouter.createCaller({
      user: { id: 1, role: "user" },
      req: { headers: {} },
      res: {},
    } as TrpcContext);
    await expect(
      userCaller.audio.fillMissingGroupLabels({ questionnaireId: 1 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.fillMissingAudioGroupLabels).not.toHaveBeenCalled();
  });
});
