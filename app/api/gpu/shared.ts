import { readFile } from "node:fs/promises";

export const MAX_BODY_BYTES = 300 * 1024;

export function gpuError(error: string, status: number) {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export function sameOrigin(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    const url = new URL(origin);
    const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0].trim()
      || new URL(request.url).protocol.replace(":", "");
    return ["http:", "https:"].includes(url.protocol)
      && url.origin === origin
      && url.host.toLowerCase() === host.toLowerCase()
      && url.protocol === `${protocol}:`;
  }
  catch {
    return false;
  }
}

export async function gpuService() {
  const base = process.env.GPU_SERVICE_URL;
  const tokenFile = process.env.GPU_SERVICE_TOKEN_FILE;
  if (!base || !tokenFile) throw new Error("GPU service not configured");
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid GPU service URL");
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (token.length < 32 || /[\r\n]/.test(token)) throw new Error("Invalid GPU service token");
  return { base: base.replace(/\/+$/, ""), token };
}

export async function boundedJson(request: Request | Response, limit = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > limit) throw new Error("Payload too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Empty payload");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Payload too large");
      }
      chunks.push(value);
    }
  }
  finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
