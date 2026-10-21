export function deriveGroupLabel(fileName: string): string {
  const basename = fileName.split(/[\\/]/).pop()?.trim() ?? "";
  const dot = basename.lastIndexOf(".");
  return (dot > 0 ? basename.slice(0, dot) : basename).trim();
}

export function buildFilenameGroupUpdates(
  audios: {
    id: number;
    fileName: string;
    groupLabel: string | null;
    modelName: string | null;
  }[]
) {
  return audios
    .filter(
      audio => audio.modelName !== "__reference__" && !audio.groupLabel?.trim()
    )
    .map(audio => {
      const groupLabel = deriveGroupLabel(audio.fileName);
      if (!groupLabel || groupLabel.length > 255) {
        throw new Error(
          `音频 ${audio.id} 的文件名无法生成有效组别，请先人工设置该音频组别`
        );
      }
      return { audioFileId: audio.id, groupLabel };
    });
}
