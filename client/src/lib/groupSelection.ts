export function filterGroupLabels(labels: readonly string[], query: string) {
  const keywords = query
    .toLocaleLowerCase()
    .split(/[\s,，;；]+/)
    .filter(Boolean);
  return labels.filter(
    label =>
      keywords.length === 0 ||
      keywords.some(keyword => label.toLocaleLowerCase().includes(keyword))
  );
}

export function updateGroupSelection(
  selected: readonly string[],
  candidates: readonly string[],
  action: "select" | "deselect",
  blocked: ReadonlySet<string> = new Set()
) {
  if (action === "deselect") {
    const removed = new Set(candidates);
    return selected.filter(label => !removed.has(label));
  }
  return Array.from(
    new Set([...selected, ...candidates.filter(label => !blocked.has(label))])
  );
}
