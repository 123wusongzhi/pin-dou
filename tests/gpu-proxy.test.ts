import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/gpu/health/route";
import { POST } from "../app/api/gpu/quantize/route";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const token = "test-server-secret-0123456789-abcdef";
const payload = {
  width: 2,
  height: 1,
  pixels: Buffer.from([0, 0, 0, 255, 0, 0, 0, 0]).toString("base64"),
  maxColors: 1,
  paletteIds: ["H7"],
  processingMode: "average",
};
const output = {
  cells: ["H7", null],
  paletteIds: ["H7"],
  device: "Test GPU",
  algorithm: "fixed-palette-v1",
  durationMs: 5,
  meanDeltaE: 0,
};

function request(body: unknown = payload, origin = "http://127.0.0.1:3001") {
  return new Request("http://container:3000/api/gpu/quantize", {
    method: "POST",
    headers: {
      "host": "127.0.0.1:3001",
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("GPU_SERVICE_URL", "http://host.docker.internal:8766");
  vi.stubEnv("GPU_SERVICE_TOKEN_FILE", "/run/secrets/gpu-token");
  vi.mocked(readFile).mockResolvedValue(token);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("电脑 GPU 同源代理", () => {
  it("使用外部 Host 验证来源，并只向电脑服务发送密钥", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json(output));
    vi.stubGlobal("fetch", upstream);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(output);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://host.docker.internal:8766/v1/quantize");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${token}` });
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it("拒绝跨来源和过大请求，尚未调用电脑服务", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    expect((await POST(request(payload, "http://example.com"))).status).toBe(403);
    expect((await POST(request({ ...payload, pixels: "A".repeat(310_000) }))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    { ...payload, width: 193 },
    { ...payload, width: 1.5 },
    { ...payload, pixels: "AQID" },
    { ...payload, paletteIds: ["INVALID"] },
    { ...payload, paletteIds: ["H7", "H7"] },
    { ...payload, maxColors: 0 },
    { ...payload, processingMode: "invalid" },
  ])("拒绝无效的量化输入", async (invalid) => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    expect((await POST(request(invalid))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("不透传上游错误中的凭据或内部信息", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: token }, { status: 500 })));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(token);
  });

  it("保留繁忙状态，并拒绝上游错误的透明格结果", async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "busy" }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ ...output, cells: ["H7", "H7"] }));
    vi.stubGlobal("fetch", upstream);
    expect((await POST(request())).status).toBe(429);
    expect((await POST(request())).status).toBe(502);
  });

  it("健康检查只公开服务可用性与设备信息", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      available: true,
      device: "Test GPU",
      algorithm: "fixed-palette-v1",
      token,
    })));
    const response = await GET(new Request("http://container:3000/api/gpu/health"));
    expect(await response.json()).toEqual({
      available: true,
      device: "Test GPU",
      algorithm: "fixed-palette-v1",
    });
  });
});
