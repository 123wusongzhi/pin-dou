import { boundedJson, gpuError, gpuService, sameOrigin } from "../shared";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!sameOrigin(request)) return gpuError("请求来源无效。", 403);
  try {
    const { base, token } = await gpuService();
    const response = await fetch(`${base}/health`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error("Unavailable");
    const value = await boundedJson(response, 4096) as Record<string, unknown>;
    return Response.json({
      available: value.available === true || value.status === "ok",
      device: typeof value.device === "string" ? value.device.slice(0, 160) : undefined,
      algorithm: typeof value.algorithm === "string" ? value.algorithm.slice(0, 120) : undefined,
    }, { headers: { "cache-control": "no-store" } });
  }
  catch {
    return Response.json({ available: false }, { headers: { "cache-control": "no-store" } });
  }
}
