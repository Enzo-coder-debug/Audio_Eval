export type EmotionCategory = {
  name: string;
  groupLabels: string[];
};

type ScopedDimension = {
  dimensionType?: string;
  targetGroups?: unknown;
  targetGroupLabels?: string | null;
  emotionCategories?: unknown;
};

export function getEmotionCategories(value: unknown): EmotionCategory[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is EmotionCategory =>
    item != null && typeof item.name === "string" && Array.isArray(item.groupLabels)
    && item.groupLabels.every((label: unknown) => typeof label === "string")
  );
}

export function isDimensionApplicable(dimension: ScopedDimension, groupLabel: string): boolean {
  const label = groupLabel.trim();
  if (dimension.dimensionType === "emotion_accuracy") {
    return Boolean(label) && getEmotionCategories(dimension.emotionCategories)
      .some(category => category.groupLabels.includes(label));
  }
  if (dimension.dimensionType !== "similarity") return true;
  let groups = dimension.targetGroups;
  if (!Array.isArray(groups)) {
    try { groups = JSON.parse(dimension.targetGroupLabels || "[]"); } catch { groups = []; }
  }
  return Boolean(label) && Array.isArray(groups) && groups.includes(label);
}