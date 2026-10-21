import { getScoringConfig, type EvaluationAnswerValue } from "@shared/scoring";
import { Textarea } from "@/components/ui/textarea";

export function ScoringAnswerFields({
  dimension,
  value,
  onChange,
  disabled,
}: {
  dimension: { id: number; dimensionName: string; scoringConfig?: unknown };
  value?: EvaluationAnswerValue;
  onChange: (value: EvaluationAnswerValue) => void;
  disabled?: boolean;
}) {
  const config = getScoringConfig(dimension);
  if (config.mode === "gsb")
    return (
      <div
        className="flex flex-wrap gap-2"
        role="radiogroup"
        aria-label={`${dimension.dimensionName} GSB 评分`}
      >
        {(["left_better", "same", "right_better"] as const).map(
          (choice, index) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={value?.blindTestChoice === choice}
              disabled={disabled}
              onClick={() => onChange({ blindTestChoice: choice })}
              className={`rounded-full border-2 px-4 py-2 text-sm disabled:opacity-50 ${value?.blindTestChoice === choice ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-200 bg-white"}`}
            >
              {["左边更好", "差不多", "右边更好"][index]}
            </button>
          )
        )}
      </div>
    );
  return (
    <div className="space-y-3">
      {config.mode === "text" && (
        <p className="whitespace-pre-wrap break-words text-sm text-slate-600">
          {config.prompt}（{config.required ? "必填" : "选填"}）
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {(["left", "right"] as const).map((side, index) => {
          const audioName = index === 0 ? "音频 A（左侧）" : "音频 B（右侧）";
          const scoreKey = side === "left" ? "leftScore" : "rightScore";
          const textKey = side === "left" ? "leftText" : "rightText";
          const selectedScore = value?.audioEvaluation?.[scoreKey];
          return (
            <div
              key={side}
              className="min-w-0 space-y-3 rounded-lg border bg-slate-50 p-4"
            >
              <p className="text-sm font-semibold">{audioName}</p>
              {config.mode === "numeric" ? (
                <>
                  <div
                    className="flex max-h-48 flex-wrap gap-2 overflow-y-auto"
                    role="radiogroup"
                    aria-label={`${dimension.dimensionName} ${audioName}评分`}
                  >
                    {[...config.rules]
                      .sort((first, second) => first.score - second.score)
                      .map(rule => (
                        <button
                          key={rule.score}
                          type="button"
                          role="radio"
                          title={rule.description}
                          aria-label={`${rule.score} 分：${rule.description}`}
                          aria-checked={selectedScore === rule.score}
                          disabled={disabled}
                          onClick={() =>
                            onChange({
                              audioEvaluation: {
                                ...value?.audioEvaluation,
                                [scoreKey]: rule.score,
                              },
                            })
                          }
                          className={`min-h-11 min-w-11 rounded-md border px-3 py-2 font-medium disabled:opacity-50 ${selectedScore === rule.score ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white"}`}
                        >
                          {rule.score}
                        </button>
                      ))}
                  </div>
                  <p
                    className="whitespace-pre-wrap break-words text-sm text-slate-600"
                    aria-live="polite"
                  >
                    {selectedScore === undefined
                      ? "请选择分值"
                      : `${selectedScore} 分：${config.rules.find(rule => rule.score === selectedScore)?.description}`}
                  </p>
                </>
              ) : (
                <>
                  <Textarea
                    aria-label={`${dimension.dimensionName} ${audioName}观察`}
                    value={value?.audioEvaluation?.[textKey] ?? ""}
                    maxLength={5000}
                    rows={4}
                    disabled={disabled}
                    placeholder="记录该音频的表现、异常片段或改进建议"
                    onChange={event =>
                      onChange({
                        audioEvaluation: {
                          ...value?.audioEvaluation,
                          [textKey]: event.target.value,
                        },
                      })
                    }
                  />
                  <p className="text-right text-xs text-slate-500">
                    {value?.audioEvaluation?.[textKey]?.length ?? 0} / 5000
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>
      {config.mode === "numeric" && (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            查看全部判定规则（{config.min}～{config.max} 分，步长 {config.step}
            ）
          </summary>
          <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto text-sm">
            {[...config.rules]
              .sort((first, second) => first.score - second.score)
              .map(rule => (
                <li
                  className="whitespace-pre-wrap break-words"
                  key={rule.score}
                >
                  <strong>{rule.score} 分：</strong>
                  {rule.description}
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}
