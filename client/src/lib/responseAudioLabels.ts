type ResponsePairAudioNames = {
  leftFileName?: string | null;
  rightFileName?: string | null;
};

export function formatResponsePairAudioLabel(
  pair: ResponsePairAudioNames | null | undefined
) {
  const left = pair?.leftFileName?.trim()
    ? pair.leftFileName
    : "左侧音频（文件名缺失）";
  const right = pair?.rightFileName?.trim()
    ? pair.rightFileName
    : "右侧音频（文件名缺失）";
  return left === right ? left : `${left} vs ${right}`;
}
