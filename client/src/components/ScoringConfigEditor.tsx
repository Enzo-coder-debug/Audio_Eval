import {
  getScoreValues,
  getScoringConfig,
  scoringConfigSchema,
  type ScoringConfig,
} from "@shared/scoring";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

export function ScoringConfigSummary({
  dimension,
}: {
  dimension: { scoringConfig?: unknown };
}) {
  const config = getScoringConfig(dimension);
  if (config.mode === "gsb") return <p>GSB 三选一对比，不计算单音频分值。</p>;
  if (config.mode === "text")
    return (
      <p className="whitespace-pre-wrap break-words">
        {config.required ? "每个音频必填" : "选填"} · {config.prompt}
      </p>
    );
  return (
    <details className="w-full">
      <summary className="cursor-pointer">
        {config.min}～{config.max} 分 · 步长 {config.step} ·{" "}
        {config.rules.length} 档判定规则
      </summary>
      <ul className="mt-2 max-h-60 space-y-2 overflow-y-auto">
        {config.rules.map(rule => (
          <li className="whitespace-pre-wrap break-words" key={rule.score}>
            <strong>{rule.score} 分：</strong>
            {rule.description}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ScoringConfigEditor({
  value,
  onChange,
  textOnly,
}: {
  value: ScoringConfig;
  onChange: (value: ScoringConfig) => void;
  textOnly: boolean;
}) {
  const validation = scoringConfigSchema.safeParse(value);
  return (
    <section
      className="space-y-4 rounded-lg border bg-slate-50 p-4"
      aria-label="评分方法配置"
    >
      {!textOnly && (
        <div className="space-y-2">
          <Label htmlFor="scoring-method">打分方法</Label>
          <select
            id="scoring-method"
            className="h-10 w-full rounded-md border bg-white px-3"
            value={value.mode}
            onChange={event =>
              onChange(
                event.target.value === "gsb"
                  ? { mode: "gsb" }
                  : {
                      mode: "numeric",
                      min: 1,
                      max: 5,
                      step: 1,
                      rules: getScoreValues(1, 5, 1).map(score => ({
                        score,
                        description: "",
                      })),
                    }
              )
            }
          >
            <option value="gsb">GSB 对比 · 每组选择一项</option>
            <option value="numeric">量化打分 · 音频 A、B 分别评分</option>
          </select>
        </div>
      )}
      {value.mode === "numeric" && (
        <>
          <div className="grid grid-cols-3 gap-3">
            {(["min", "max", "step"] as const).map((field, index) => (
              <div key={field} className="space-y-2">
                <Label htmlFor={`scoring-${field}`}>
                  {["最低分", "最高分", "步长"][index]}
                </Label>
                <Input
                  id={`scoring-${field}`}
                  type="number"
                  step="any"
                  value={Number.isFinite(value[field]) ? value[field] : ""}
                  onChange={event => {
                    const next = {
                      ...value,
                      [field]:
                        event.target.value === ""
                          ? NaN
                          : Number(event.target.value),
                    };
                    onChange({
                      ...next,
                      rules: getScoreValues(next.min, next.max, next.step).map(
                        score => ({
                          score,
                          description:
                            value.rules.find(rule => rule.score === score)
                              ?.description ?? "",
                        })
                      ),
                    });
                  }}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-600">
            支持最多两位小数、2～101
            档分值，步长须整除区间。每档均须填写判定规则；A、B 允许同分。
          </p>
          <div className="max-h-72 space-y-3 overflow-y-auto pr-2">
            {value.rules.map((rule, index) => (
              <div key={rule.score} className="space-y-1">
                <Label htmlFor={`score-rule-${index}`}>
                  {rule.score} 分 · 判定规则 *
                </Label>
                <Textarea
                  id={`score-rule-${index}`}
                  value={rule.description}
                  maxLength={2000}
                  rows={2}
                  placeholder={`描述达到 ${rule.score} 分的具体标准`}
                  onChange={event =>
                    onChange({
                      ...value,
                      rules: value.rules.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, description: event.target.value }
                          : item
                      ),
                    })
                  }
                />
              </div>
            ))}
          </div>
        </>
      )}
      {value.mode === "text" && (
        <>
          <p className="text-sm font-medium">其他 · 开放文本（不计入分数）</p>
          <Label htmlFor="text-scoring-prompt">填写引导 *</Label>
          <Textarea
            id="text-scoring-prompt"
            value={value.prompt}
            maxLength={2000}
            onChange={event =>
              onChange({ ...value, prompt: event.target.value })
            }
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={value.required}
              onCheckedChange={checked =>
                onChange({ ...value, required: checked === true })
              }
            />
            音频 A、B 均须填写
          </label>
          <p className="text-xs text-slate-600">
            每个音频最多 5000 字，保存音频对应关系，可导出用于后续自然语言分析。
          </p>
        </>
      )}
      {!validation.success && (
        <p role="alert" className="text-sm text-red-600">
          {validation.error.issues[0].message}
        </p>
      )}
    </section>
  );
}
