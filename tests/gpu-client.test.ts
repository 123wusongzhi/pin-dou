import { afterEach, describe, expect, it, vi } from "vitest";
import { quantizeOnComputer, validateGpuResult } from "../lib/gpu-client";

const pixels = new Uint8ClampedArray([20, 20, 20, 255, 0, 0, 0, 0]);
const result = {
  cells: ["H7", null],
  paletteIds: ["H7"],
  device: "Test GPU",
  algorithm: "fixed-palette-v1",
  durationMs: 12,
  meanDeltaE: 1.2,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("电脑 GPU 配色客户端", () => {
  it("向同源接口发送采样像素和允许色号并保留透明格", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal("fetch", fetch);
    await expect(quantizeOnComputer(pixels, 2, 1, 1, "average", ["H7"])).resolves.toEqual(result);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/gpu/quantize");
    const body = JSON.parse(init.body as string);
    expect([...Buffer.from(body.pixels, "base64")]).toEqual([...pixels]);
    expect(body.paletteIds).toEqual(["H7"]);
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it.each([
    { ...result, cells: ["H7"] },
    { ...result, cells: ["T1", null] },
    { ...result, cells: [null, null] },
    { ...result, cells: ["H7", "H7"] },
    { ...result, paletteIds: ["H7", "T1"] },
    { ...result, durationMs: Number.NaN },
  ])("拒绝不完整、越界颜色或不符合透明度的结果", (invalid) => {
    expect(() => validateGpuResult(invalid, pixels, 2, 1, 1, ["H7"])).toThrow("结果无效");
  });

  it("服务繁忙时提示重试且不产生替代图纸", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: "busy" }, { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    await expect(quantizeOnComputer(pixels, 2, 1, 1, "average", ["H7"])).rejects.toThrow("另一张图");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("取消请求时保留取消原因", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(quantizeOnComputer(pixels, 2, 1, 1, "average", ["H7"], controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
