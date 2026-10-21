import { readFile } from "node:fs/promises";
import { PIXEL_ART_PROMPT } from "@/lib/ai-prompt";

export const runtime = "nodejs";
export const maxDuration = 300;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const BRIDGE_TIMEOUT = 300_000;

async function bridge() {
  const base = process.env.DSH_IMAGE_BRIDGE_URL;
  const tokenFile = process.env.DSH_IMAGE_BRIDGE_TOKEN_FILE;
  if (!base || !tokenFile) throw new Error("DSH 图片通道尚未配置。");
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (token.length < 32) throw new Error("DSH 图片通道认证未配置。");
  return { base: base.replace(/\/$/u, ""), token };
}

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET() {
  try {
    const { base, token } = await bridge();
    const response = await fetch(`${base}/health`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    return Response.json({ available: response.ok }, { headers: { "cache-control": "no-store" } });
  }
  catch {
    return Response.json({ available: false }, { headers: { "cache-control": "no-store" } });
  }
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && (!host || origin !== `${new URL(request.url).protocol}//${host}`))
    return errorResponse("图片请求来源无效。", 403);

  let image: FormDataEntryValue | null;
  try { image = (await request.formData()).get("image"); }
  catch { return errorResponse("图片请求无法读取。", 400); }
  if (!(image instanceof File) || !IMAGE_TYPES.has(image.type) || image.size === 0 || image.size > MAX_IMAGE_BYTES)
    return errorResponse("图片格式不支持或文件过大。", 400);

  let config: Awaited<ReturnType<typeof bridge>>;
  try { config = await bridge(); }
  catch { return errorResponse("DSH 图片通道尚未就绪，请稍后重试。", 503); }

  let response: Response;
  try {
    response = await fetch(`${config.base}/image`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: PIXEL_ART_PROMPT,
        size: "auto",
        images: [{ mediaType: image.type, base64: Buffer.from(await image.arrayBuffer()).toString("base64") }],
      }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT),
    });
  }
  catch {
    return errorResponse("无法连接本机 DSH 图片通道。", 502);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    return errorResponse(payload.error || `DSH 图片处理失败（${response.status}）。`, response.status);
  }
  if (response.headers.get("content-type") !== "image/png")
    return errorResponse("DSH 未返回 PNG 图片。", 502);
  const output = await response.arrayBuffer();
  if (output.byteLength === 0 || output.byteLength > 48 * 1024 * 1024)
    return errorResponse("DSH 返回的图片无效。", 502);
  return new Response(output, {
    headers: {
      "cache-control": "no-store",
      "content-type": "image/png",
      "x-image-actual-size": response.headers.get("x-image-actual-size") || "",
      "x-image-size-status": response.headers.get("x-image-size-status") || "",
      "x-image-reported-model": response.headers.get("x-image-reported-model") || "",
    },
  });
}
