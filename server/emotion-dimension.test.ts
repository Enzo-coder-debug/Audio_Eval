import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getEmotionCategories, isDimensionApplicable } from "../shared/evaluationDimensions";
import * as db from "./db";

vi.mock("./db", () => ({
  getQuestionnaireById: vi.fn(),
  getAudioFilesByQuestionnaire: vi.fn(),
  createEvaluationDimension: vi.fn(),
  getEvaluationDimensionById: vi.fn(),
  updateEvaluationDimension: vi.fn(),
  getResponseById: vi.fn(),
  getBlindTestPairsByQuestionnaire: vi.fn(),
  getEvaluationDimensionsByQuestionnaire: vi.fn(),
  getAudioFileById: vi.fn(),
  deleteAnswersByResponse: vi.fn(),
  createAnswers: vi.fn(),
  savePublicAnswerSnapshot: vi.fn(),
  updateResponse: vi.fn(),
}));

const categories = [{ name: "开心", groupLabels: ["A"] }, { name: "悲伤", groupLabels: ["B"] }];
const dimension = { id: 10, questionnaireId: 1, dimensionType: "emotion_accuracy", emotionCategories: categories };
const caller = appRouter.createCaller({
  user: { id: 1, role: "admin" }, req: { headers: {} }, res: {},
} as TrpcContext);
const createInput = { questionnaireId: 1, dimensionName: "情绪准确度", orderIndex: 0, dimensionType: "emotion_accuracy" as const };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.getQuestionnaireById).mockResolvedValue({ id: 1, creatorId: 1 } as any);
  vi.mocked(db.getAudioFilesByQuestionnaire).mockResolvedValue([
    { groupLabel: "A", modelName: "model1" }, { groupLabel: "B", modelName: "model2" },
    { groupLabel: "reference", modelName: "__reference__" },
  ] as any);
  vi.mocked(db.createEvaluationDimension).mockResolvedValue([{ insertId: 10 }] as any);
  vi.mocked(db.getEvaluationDimensionById).mockResolvedValue(dimension as any);
});

describe("情绪准确度配置", () => {
  it("保存多种情绪及对应组别", async () => {
    await expect(caller.dimension.create({ ...createInput, emotionCategories: categories })).resolves.toEqual({ success: true, dimensionId: 10 });
    expect(db.createEvaluationDimension).toHaveBeenCalledWith(expect.objectContaining({ emotionCategories: categories, referenceAudioFileId: null }));
  });
  it.each([
    undefined, [], [{ name: "", groupLabels: ["A"] }], [{ name: "开心", groupLabels: [] }],
    [{ name: "开心", groupLabels: ["A"] }, { name: "开心", groupLabels: ["B"] }],
    [{ name: "开心", groupLabels: ["A"] }, { name: "悲伤", groupLabels: ["A"] }],
    [{ name: "开心", groupLabels: ["missing"] }], [{ name: "开心", groupLabels: ["reference"] }],
  ].map(emotionCategories => ({ emotionCategories })))("拒绝不完整或冲突的配置 %#", async ({ emotionCategories }) => {
    await expect(caller.dimension.create({ ...createInput, emotionCategories })).rejects.toThrow();
    expect(db.createEvaluationDimension).not.toHaveBeenCalled();
  });
  it("修改其他字段时保留类别，切换普通维度时清空", async () => {
    await caller.dimension.update({ id: 10, dimensionName: "新版名称" });
    expect(db.updateEvaluationDimension).toHaveBeenLastCalledWith(10, expect.objectContaining({ emotionCategories: categories }));
    await caller.dimension.update({ id: 10, dimensionType: "normal" });
    expect(db.updateEvaluationDimension).toHaveBeenLastCalledWith(10, expect.objectContaining({ emotionCategories: null }));
  });
  it("编辑时可以重新配置情绪", async () => {
    const updated = [{ name: "惊讶", groupLabels: ["B"] }];
    await caller.dimension.update({ id: 10, emotionCategories: updated });
    expect(db.updateEvaluationDimension).toHaveBeenCalledWith(10, expect.objectContaining({ emotionCategories: updated }));
  });
});

describe("按组适用范围", () => {
  it("情绪维度仅适用于指定组别，普通和相似度维度保持兼容", () =>{
    expect(isDimensionApplicable(dimension, " A ")).toBe(true);
    expect(isDimensionApplicable(dimension, "C")).toBe(false);
    expect(isDimensionApplicable(dimension, "")).toBe(false);
    expect(isDimensionApplicable({ dimensionType: "normal" }, "")).toBe(true);
    expect(isDimensionApplicable({ dimensionType: "similarity", targetGroups: ["A"] }, "A")).toBe(true);
    expect(isDimensionApplicable({ dimensionType: "similarity", targetGroupLabels: '["A"]' }, "B")).toBe(false);
    expect(isDimensionApplicable({ dimensionType: "similarity", targetGroupLabels: "invalid" }, "A")).toBe(false);
    expect(getEmotionCategories([null, {}, { name: "开心", groupLabels: [1] }])).toEqual([]);
  });
  it("提交必须覆盖匹配的情绪维度，不要求非匹配组作答", async () => {
    vi.mocked(db.getResponseById).mockResolvedValue({ id: 1, questionnaireId: 1 } as any);
    vi.mocked(db.getBlindTestPairsByQuestionnaire).mockResolvedValue([
      { id: 20, leftAudioFileId: 1, rightAudioFileId: 2 },
      { id: 21, leftAudioFileId: 3, rightAudioFileId: 4 },
    ] as any);
    vi.mocked(db.getEvaluationDimensionsByQuestionnaire).mockResolvedValue([dimension] as any);
    vi.mocked(db.getAudioFileById).mockImplementation(async id => ({ groupLabel: id <= 2 ? "A" : "C" } as any));
    await expect(caller.response.submitPublic({ responseId: 1, answers: [] })).rejects.toThrow("答卷不完整");
    expect(db.savePublicAnswerSnapshot).not.toHaveBeenCalled();
    await caller.response.submitPublic({ responseId: 1, answers: [{ blindTestPairId: 20, evaluationDimensionId: 10, blindTestChoice: "same" }] });
    expect(db.savePublicAnswerSnapshot).toHaveBeenCalledOnce();
  });
});
