import type { GpuHealth } from "@/lib/gpu-client";
import type { GpuSamplingProfile, ProcessingMode, QuantizationEngine } from "@/lib/types";

export function GpuEngineControl({
  engine,
  health,
  processingMode,
  gpuSampling,
  disabled = false,
  onChange,
  onRefresh,
  onSamplingChange,
}: {
  engine?: QuantizationEngine;
  health: GpuHealth | null;
  processingMode: ProcessingMode;
  gpuSampling?: GpuSamplingProfile;
  disabled?: boolean;
  onChange: (engine: QuantizationEngine) => void;
  onRefresh: () => void;
  onSamplingChange: (profile: GpuSamplingProfile) => void;
}) {
  const selected = engine ?? "local";
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 rounded-xl border border-border bg-muted/40 p-3">
      <legend className="px-1 text-sm font-semibold">图纸配色</legend>
      <div
        className="grid grid-cols-2 gap-2"
        role="group"
        aria-label="选择图纸配色方式"
      >
        {([
          { id: "gpu", label: "电脑GPU高质量" },
          { id: "local", label: "浏览器标准" },
        ] as const).map(option => (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected === option.id}
            disabled={disabled || (option.id === "gpu" && !health?.available && selected !== "gpu")}
            onClick={() => onChange(option.id)}
            className={`min-h-11 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${selected === option.id ? "border-primary bg-accent text-accent-foreground" : "border-border bg-background text-foreground"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">
        {selected === "gpu"
          ? "由电脑 GPU 优化实体豆色组合，手机也能使用；电脑需保持在线。"
          : "在当前浏览器中完成配色，适合离线使用。"}
      </p>
      {selected === "gpu"
        ? processingMode === "edge"
          ? (
              <div className="grid min-w-0 gap-2 border-t border-border pt-2">
                <div
                  className="grid grid-cols-2 gap-2"
                  role="group"
                  aria-label="轮廓增强采样方式"
                >
                  {([
                    { id: "natural", label: "自然平衡" },
                    { id: "detail", label: "原细节增强" },
                  ] as const).map(option => (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={(gpuSampling ?? "detail") === option.id}
                      disabled={disabled}
                      onClick={() => onSamplingChange(option.id)}
                      className={`min-h-11 rounded-lg border px-2 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${(gpuSampling ?? "detail") === option.id ? "border-primary bg-accent text-accent-foreground" : "border-border bg-background text-foreground"}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="m-0 text-xs leading-relaxed text-muted-foreground">
                  {gpuSampling === "natural"
                    ? "自然平衡减轻浅色发灰，平衡轮廓与亮度；可切回原细节增强对比。"
                    : "保留原有轮廓与细节处理。自然平衡可减轻浅色发灰。"}
                  仅用于轮廓增强模式。
                </p>
              </div>
            )
          : (
              <p className="m-0 border-t border-border pt-2 text-xs leading-relaxed text-muted-foreground">
                自然平衡与原细节增强仅用于轮廓增强模式；当前模式使用原有采样。
              </p>
            )
        : null}
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
        <span
          className="min-w-0 break-words text-muted-foreground"
          role="status"
        >
          {health === null
            ? "正在检查电脑服务…"
            : health.available
              ? `电脑已连接${health.device ? ` · ${health.device}` : ""}`
              : "电脑服务未连接，可使用浏览器标准"}
        </span>
        <button
          type="button"
          disabled={disabled || health === null}
          onClick={onRefresh}
          className="min-h-11 shrink-0 rounded-md px-2 font-medium text-primary disabled:opacity-50"
        >
          检查连接
        </button>
      </div>
    </fieldset>
  );
}
