import { BEAD_COLORS } from "../../../../lib/beads";
import { validateGpuResult } from "../../../../lib/gpu-client";
import { boundedJson, gpuError, gpuService, MAX_BODY_BYTES, sameOrigin } from "../shared";

export const runtime = "nodejs";
export const maxDuration = 50;

const COLOR_IDS = new Set(BEAD_COLORS.map(color => color.id));

export async function POST(request: Request) {
  if (!sameOrigin(request)) return gpuError("请求来源无效。", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return gpuError("请提交有效的图片数据。", 415);
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES)
    return gpuError("图片数据过大。", 413);
  let payload: Record<string, unknown>;
  let pixels: Uint8ClampedArray;
  try {
    const value = await boundedJson(request);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    payload = value as Record<string, unknown>;
    const { width, height, maxColors, paletteIds, processingMode } = payload;
    if (
      !Number.isInteger(width) || !Number.isInteger(height)
      || (width as number) < 1 || (height as number) < 1
      || (width as number) > 192 || (height as number) > 192
      || !Number.isInteger(maxColors) || (maxColors as number) < 1 || (maxColors as number) > 291
      || !Array.isArray(paletteIds) || !paletteIds.length || paletteIds.length > 291
      || new Set(paletteIds).size !== paletteIds.length
      || paletteIds.some(id => typeof id !== "string" || !COLOR_IDS.has(id))
      || !["edge", "dominant", "average"].includes(processingMode as string)
      || typeof payload.pixels !== "string"
      || payload.pixels.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.pixels)
    ) throw new Error();
    pixels = new Uint8ClampedArray(Buffer.from(payload.pixels, "base64"));
    if (pixels.length !== (width as number) * (height as number) * 4) throw new Error();
  }
  catch {
    return gpuError("图片尺寸、色号或像素数据无效。", 400);
  }
  let config: Awaited<ReturnType<typeof gpuService>>;
  try {
    config = await gpuService();
  }
  catch {
    return gpuError("电脑高质量服务尚未配置，可切换为浏览器标准。", 503);
  }
  try {
    const response = await fetch(`${config.base}/v1/quantize`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        width: payload.width,
        height: payload.height,
        pixels: payload.pixels,
        maxColors: payload.maxColors,
        paletteIds: payload.paletteIds,
        processingMode: payload.processingMode,
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
      cache: "no-store",
    });
    if (response.status === 429)
      return gpuError("电脑正在处理另一张图，请稍后重试。", 429);
    if (!response.ok)
      return gpuError("电脑配色服务未能完成，请稍后重试或切换为浏览器标准。", 502);
    const result = validateGpuResult(
      await boundedJson(response),
      pixels,
      payload.width as number,
      payload.height as number,
      payload.maxColors as number,
      payload.paletteIds as string[],
    );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  }
  catch {
    return gpuError("电脑配色未完成或连接中断，原图纸已保留。可重试或切换为浏览器标准。", 502);
  }
}
