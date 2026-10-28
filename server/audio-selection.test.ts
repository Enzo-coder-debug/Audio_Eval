import { describe, expect, it } from "vitest";
import {
  audioModelKey,
  filterAudios,
  getAudioModelOptions,
  getAudioPage,
  updateAudioSelection,
  type SearchableAudio,
} from "../client/src/lib/audioSelection";

const audios: SearchableAudio[] = [
  {
    id: 1,
    fileName: "case0001_高兴_I型.wav",
    modelName: "LiveTTS-I型",
    groupLabel: "开心组",
  },
  {
    id: 2,
    fileName: "case0001_高兴_II型.wav",
    modelName: "LiveTTS-II型",
    groupLabel: "开心组",
  },
  {
    id: 3,
    fileName: "case0002_期待_I型.wav",
    modelName: "LiveTTS-I型",
    groupLabel: "期盼组",
  },
  { id: 4, fileName: "Sample[04].wav", modelName: null, groupLabel: null },
  {
    id: 5,
    fileName: "case0005_中立.wav",
    modelName: " ",
    groupLabel: "中性组",
  },
  {
    id: 6,
    fileName: "case0006.wav",
    modelName: "all",
    groupLabel: "特殊模型名",
  },
];
const defaults = { model: "all", query: "", selectedOnly: false };
const filter = (query: string, model = "all") =>
  filterAudios(audios, { ...defaults, model, query }, new Set()).map(
    audio => audio.id
  );

describe("音频模型与关键词组合检索", () => {
  it("空筛选保留全部记录和原始顺序，不修改输入", () => {
    const copy = structuredClone(audios);
    expect(filterAudios(audios, defaults, new Set())).toEqual(audios);
    expect(filter(" \t，,；; ")).toEqual(audios.map(audio => audio.id));
    expect(audios).toEqual(copy);
  });

  it("模型按完整名称匹配，I 型不混入 II 型", () => {
    expect(filter("", audioModelKey("LiveTTS-I型"))).toEqual([1, 3]);
    expect(filter("", audioModelKey("LiveTTS-II型"))).toEqual([2]);
  });

  it.each([
    { query: "高兴", expected: [1, 2] },
    { query: "LIVETTS", expected: [1, 2, 3] },
    { query: "期盼", expected: [3] },
    { query: "0001", expected: [1, 2] },
    { query: "[04]", expected: [4] },
    { query: ".*", expected: [] },
    { query: "不存在", expected: [] },
  ])("关键词 $query 匹配文件名、模型名或已保存组别", ({ query, expected }) => {
    expect(filter(query)).toEqual(expected);
  });

  it.each([
    "高兴 期待",
    "高兴,期待",
    "高兴，期待",
    "高兴;期待",
    "高兴；期待",
    "高兴\n期待",
  ])("多个关键词匹配任一：%s", query => {
    expect(filter(query)).toEqual([1, 2, 3]);
  });

  it("模型和关键词取交集，不扩大到其他模型", () => {
    expect(filter("高兴 期待", audioModelKey("LiveTTS-I型"))).toEqual([1, 3]);
    expect(filter("期盼", audioModelKey("LiveTTS-II型"))).toEqual([]);
  });

  it("未填写模型包括 null、空白；保留字模型不会触发全部模型", () => {
    expect(filter("", audioModelKey(null))).toEqual([4, 5]);
    expect(filter("", audioModelKey("all"))).toEqual([6]);
    expect(filter("", audioModelKey("__all__"))).toEqual([]);
  });

  it("仅看已选与模型关键词同时满足，失效 ID 不出现", () => {
    expect(
      filterAudios(
        audios,
        {
          model: audioModelKey("LiveTTS-I型"),
          query: "高兴 期待",
          selectedOnly: true,
        },
        new Set([2, 3, 999])
      ).map(audio => audio.id)
    ).toEqual([3]);
  });

  it("模型选项统计整表，不因检索丢失选项；空白归为未填写", () => {
    const options = getAudioModelOptions(audios);
    expect(options).toHaveLength(4);
    expect(
      options.find(option => option.value === audioModelKey("LiveTTS-I型"))
    ).toMatchObject({ count: 2, label: "LiveTTS-I型" });
    expect(
      options.find(option => option.value === audioModelKey(null))
    ).toMatchObject({ count: 2, label: "未填写模型名称" });
    expect(new Set(options.map(option => option.value)).size).toBe(4);
    expect(getAudioModelOptions([])).toEqual([]);
  });
});

describe("跨筛选音频批量勾选", () => {
  it("跨模型选择累加、不覆盖已有选择、不产生重复 ID", () => {
    const previous = [1, 3];
    const next = updateAudioSelection(
      previous,
      filter("", audioModelKey("LiveTTS-II型")),
      "select"
    );
    expect(next).toEqual([1, 3, 2]);
    expect(updateAudioSelection(next, [1, 2, 3, 2], "select")).toEqual(next);
    expect(previous).toEqual([1, 3]);
  });

  it("取消筛选结果保留筛选外已选项；零结果不清空勾选", () => {
    expect(
      updateAudioSelection([1, 2, 3, 4], filter("高兴"), "deselect")
    ).toEqual([3, 4]);
    expect(updateAudioSelection([1, 3], [], "select")).toEqual([1, 3]);
    expect(updateAudioSelection([1, 3], [], "deselect")).toEqual([1, 3]);
  });

  it("清除筛选只改变可见列表，不改变勾选集合", () => {
    const selected = new Set([1, 3]);
    expect(
      filterAudios(audios, { ...defaults, selectedOnly: true }, selected).map(
        audio => audio.id
      )
    ).toEqual([1, 3]);
    expect(filterAudios(audios, defaults, selected)).toEqual(audios);
    expect([...selected]).toEqual([1, 3]);
  });

  it("800 个音频可全选筛选结果，操作不限于当前 100 个", () => {
    const many = Array.from({ length: 800 }, (_, index) => ({
      id: index + 1,
      fileName: `case${String(index + 1).padStart(4, "0")}.wav`,
      modelName: index % 2 ? "B" : "A",
      groupLabel: "组别",
    }));
    const matching = filterAudios(
      many,
      { ...defaults, model: audioModelKey("A") },
      new Set()
    );
    expect(matching).toHaveLength(400);
    const first = getAudioPage(matching, 1);
    expect(first.pageAudios).toHaveLength(100);
    expect(first.totalPages).toBe(4);
    const selected = updateAudioSelection(
      [800],
      matching.map(audio => audio.id),
      "select"
    );
    expect(selected).toHaveLength(401);
    expect(selected).toContain(799);
    expect(
      getAudioPage(matching, 4).pageAudios.every(audio =>
        selected.includes(audio.id)
      )
    ).toBe(true);
    expect(
      updateAudioSelection(
        selected,
        matching.map(audio => audio.id),
        "deselect"
      )
    ).toEqual([800]);
  });
});

describe("音频分页边界", () => {
  it("空结果与越界页数不会出现空白末页", () => {
    expect(getAudioPage([], 8)).toEqual({
      currentPage: 1,
      totalPages: 1,
      pageAudios: [],
    });
    expect(getAudioPage(audios, 20).pageAudios).toEqual(audios);
    expect(getAudioPage(audios, 0).currentPage).toBe(1);
  });

  it("末页精确分页，数据减少时收缩到最后有效页", () => {
    const rows = Array.from({ length: 201 }, (_, index) => index);
    expect(getAudioPage(rows, 3)).toEqual({
      currentPage: 3,
      totalPages: 3,
      pageAudios: [200],
    });
    expect(getAudioPage(rows.slice(0, 150), 3)).toEqual({
      currentPage: 2,
      totalPages: 2,
      pageAudios: rows.slice(100, 150),
    });
  });
});
