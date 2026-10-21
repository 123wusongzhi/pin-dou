import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pattern } from "../lib/types";
import { DEFAULT_SETTINGS, DEFAULT_TRANSFORM } from "../lib/types";

const engines = vi.hoisted(() => ({
  local: vi.fn(),
  gpu: vi.fn(),
}));
vi.mock("../lib/pattern", () => ({ imageToPattern: engines.local }));
vi.mock("../lib/gpu-pattern", () => ({ imageToPatternOnComputer: engines.gpu }));

const { generatePattern } = await import("../lib/generate-pattern");
const pattern: Pattern = {
  id: "example",
  name: "example",
  width: 2,
  height: 1,
  cells: ["T1", "H7"],
  createdAt: "2026-10-20T00:00:00Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  engines.local.mockResolvedValue(pattern);
  engines.gpu.mockResolvedValue({
    ...pattern,
    generationInfo: { engine: "gpu", algorithm: "mard-optimized-v1", device: "test GPU" },
  });
});

describe("independent conversion channels", () => {
  it("keeps old settings on the legacy algorithm and preserves all arguments", async () => {
    const settings = { ...DEFAULT_SETTINGS };
    delete settings.engine;
    const generated = await generatePattern("source", "input.png", settings, DEFAULT_TRANSFORM, "restore");
    expect(engines.local).toHaveBeenCalledWith("source", "input.png", settings, DEFAULT_TRANSFORM, "restore");
    expect(engines.gpu).not.toHaveBeenCalled();
    expect(generated.cells).toEqual(pattern.cells);
    expect(generated.generationInfo?.engine).toBe("local");
  });

  it("uses the GPU channel only when explicitly selected", async () => {
    const result = await generatePattern("source", "input.png", { ...DEFAULT_SETTINGS, engine: "gpu" });
    expect(engines.gpu).toHaveBeenCalledOnce();
    expect(engines.local).not.toHaveBeenCalled();
    expect(result.generationInfo).toMatchObject({ engine: "gpu", device: "test GPU" });
  });

  it("does not enable the GPU channel when only a saved natural sampling preference exists", async () => {
    const settings = { ...DEFAULT_SETTINGS, gpuSampling: "natural" as const };
    await generatePattern("source", "input.png", settings);
    expect(engines.local).toHaveBeenCalledWith("source", "input.png", settings, DEFAULT_TRANSFORM, undefined);
    expect(engines.gpu).not.toHaveBeenCalled();
  });

  it("keeps an independent generation baseline for later manual edits", async () => {
    const result = await generatePattern("source", "input.png", DEFAULT_SETTINGS);
    result.cells = [...result.cells];
    result.cells[0] = "C7";
    expect(result.generatedCells).toEqual(["T1", "H7"]);
  });

  it("does not silently replace a failed GPU job with the legacy algorithm", async () => {
    engines.gpu.mockRejectedValue(new Error("GPU unavailable"));
    await expect(generatePattern("source", "input.png", { ...DEFAULT_SETTINGS, engine: "gpu" }))
      .rejects.toThrow("GPU unavailable");
    expect(engines.local).not.toHaveBeenCalled();
  });
});
