export type SearchableAudio = {
  id: number;
  fileName: string;
  modelName: string | null;
  groupLabel: string | null;
};

export const AUDIO_PAGE_SIZE = 100;

export function audioModelKey(modelName: string | null) {
  return `model:${JSON.stringify(modelName?.trim() || "")}`;
}

export function getAudioModelOptions(audios: readonly SearchableAudio[]) {
  const models = new Map<
    string,
    { value: string; label: string; count: number }
  >();
  for (const audio of audios) {
    const value = audioModelKey(audio.modelName);
    const current = models.get(value);
    models.set(value, {
      value,
      label: audio.modelName?.trim() || "未填写模型名称",
      count: (current?.count ?? 0) + 1,
    });
  }
  return Array.from(models.values()).sort((left, right) =>
    left.label.localeCompare(right.label, "zh-CN", { numeric: true })
  );
}

export function filterAudios<Audio extends SearchableAudio>(
  audios: readonly Audio[],
  filters: { model: string; query: string; selectedOnly: boolean },
  selectedIds: ReadonlySet<number>
) {
  const keywords = filters.query
    .toLocaleLowerCase()
    .split(/[\s,，;；]+/)
    .filter(Boolean);
  return audios.filter(audio => {
    if (
      filters.model !== "all" &&
      audioModelKey(audio.modelName) !== filters.model
    )
      return false;
    if (filters.selectedOnly && !selectedIds.has(audio.id)) return false;
    const fields = [
      audio.fileName,
      audio.modelName ?? "",
      audio.groupLabel ?? "",
    ].map(value => value.toLocaleLowerCase());
    return (
      keywords.length === 0 ||
      keywords.some(keyword => fields.some(field => field.includes(keyword)))
    );
  });
}

export function updateAudioSelection(
  selectedIds: readonly number[],
  candidateIds: readonly number[],
  action: "select" | "deselect"
) {
  if (action === "deselect") {
    const removed = new Set(candidateIds);
    return selectedIds.filter(id => !removed.has(id));
  }
  return Array.from(new Set([...selectedIds, ...candidateIds]));
}

export function getAudioPage<Audio>(audios: readonly Audio[], page: number) {
  const totalPages = Math.max(1, Math.ceil(audios.length / AUDIO_PAGE_SIZE));
  const currentPage = Math.max(1, Math.min(page, totalPages));
  return {
    currentPage,
    totalPages,
    pageAudios: audios.slice(
      (currentPage - 1) * AUDIO_PAGE_SIZE,
      currentPage * AUDIO_PAGE_SIZE
    ),
  };
}
