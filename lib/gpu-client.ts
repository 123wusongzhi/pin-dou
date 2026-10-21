import type { ProcessingMode } from "./types";
import { BEAD_COLORS } from "./beads";

export type GpuHealth = {
  available: boolean;
  device?: string;
  algorithm?: string;
};

export type GpuQuantization = {
  cells: Array<string | null>;
  paletteIds: string[];
  device: string;
  algorithm: string;
  durationMs: number;
  meanDeltaE: number;
};

const COLOR_IDS = new Set(BEAD_COLORS.map(color => color.id));
const UNAVAILABLE = "电脑高质量服务暂不可用，请检查电脑服务，或切换为浏览器标准。";

export function validateGpuResult(
  value: unknown,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  maxColors: number,
  availableColorIds: string[],
): GpuQuantization {
  const invalid = () => new Error("电脑返回的配色结果无效，原图纸已保留。");
  if (!value || typeof value !== "object") throw invalid();
  const result = value as Partial<GpuQuantization>;
  const allowed = new Set(availableColorIds);
  if (
    !Array.isArray(result.cells) || result.cells.length !== width * height
    || !Array.isArray(result.paletteIds) || result.paletteIds.length > maxColors
    || new Set(result.paletteIds).size !== result.paletteIds.length
    || result.paletteIds.some(id => typeof id !== "string" || !allowed.has(id) || !COLOR_IDS.has(id))
    || typeof result.device !== "string" || !result.device || result.device.length > 160
    || typeof result.algorithm !== "string" || !result.algorithm || result.algorithm.length > 120
    || typeof result.durationMs !== "number" || !Number.isFinite(result.durationMs) || result.durationMs < 0
    || typeof result.meanDeltaE !== "number" || !Number.isFinite(result.meanDeltaE) || result.meanDeltaE < 0
  ) throw invalid();
  const selected = new Set(result.paletteIds);
  for (let index = 0; index < result.cells.length; index += 1) {
    const id = result.cells[index];
    if (pixels[index * 4 + 3] < 36 ? id !== null : typeof id !== "string" || !selected.has(id))
      throw invalid();
  }
  return {
    cells: result.cells,
    paletteIds: result.paletteIds,
    device: result.device,
    algorithm: result.algorithm,
    durationMs: result.durationMs,
    meanDeltaE: result.meanDeltaE,
  };
}

export async function getGpuHealth(signal?: AbortSignal): Promise<GpuHealth> {
  try {
    const response = await fetch("/api/gpu/health", { signal, cache: "no-store" });
    if (!response.ok) return { available: false };
    const result: unknown = await response.json();
    if (!result || typeof result !== "object") return { available: false };
    const health = result as GpuHealth;
    return {
      available: health.available === true,
      device: typeof health.device === "string" ? health.device.slice(0, 160) : undefined,
      algorithm: typeof health.algorithm === "string" ? health.algorithm.slice(0, 120) : undefined,
    };
  }
  catch (error) {
    if (signal?.aborted) throw error;
    return { available: false };
  }
}

export async function quantizeOnComputer(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  maxColors: number,
  processingMode: ProcessingMode,
  availableColorIds: string[],
  signal?: AbortSignal,
): Promise<GpuQuantization> {
  if (
    !Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1 || width > 192 || height > 192
    || pixels.length !== width * height * 4
    || !Number.isInteger(maxColors) || maxColors < 1 || maxColors > 291
    || !["edge", "dominant", "average"].includes(processingMode)
    || !availableColorIds.length || availableColorIds.length > 291
    || new Set(availableColorIds).size !== availableColorIds.length
    || availableColorIds.some(id => !COLOR_IDS.has(id))
  ) throw new Error("待配色的图片数据不完整。");
  signal?.throwIfAborted();
  let binary = "";
  for (const byte of pixels) binary += String.fromCharCode(byte);
  let response: Response;
  try {
    response = await fetch("/api/gpu/quantize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        width,
        height,
        pixels: btoa(binary),
        maxColors,
        paletteIds: availableColorIds,
        processingMode,
      }),
      signal,
    });
  }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(UNAVAILABLE);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(
      response.status === 429
        ? "电脑正在处理另一张图，请稍后重试。"
        : typeof payload?.error === "string" ? payload.error : UNAVAILABLE,
    );
  }
  return validateGpuResult(
    await response.json(),
    pixels,
    width,
    height,
    maxColors,
    availableColorIds,
  );
}
