import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/types";

const mocks = vi.hoisted(() => ({
  sample: vi.fn(),
  quantize: vi.fn(),
}));
vi.mock("../lib/gpu-sampling", () => ({ sampleComputerSource: mocks.sample }));
vi.mock("../lib/gpu-client", () => ({ quantizeOnComputer: mocks.quantize }));
vi.mock("../lib/pattern", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/pattern")>(),
  loadImage: vi.fn().mockResolvedValue({ width: 8, height: 8 }),
  transformedCanvas: vi.fn().mockReturnValue({ width: 8, height: 8 }),
}));

const { imageToPatternOnComputer } = await import("../lib/gpu-pattern");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sample.mockImplementation((_canvas, width, height) =>
    Uint8ClampedArray.from(Array.from({ length: width * height }, () => [255, 255, 255, 255]).flat()));
  mocks.quantize.mockImplementation(async (_pixels, width, height) => ({
    cells: Array(width * height).fill("T1"), device: "Test GPU", algorithm: "mard-optimized-v2",
  }));
});

describe("GPU pattern sampling integration", () => {
  it("passes natural sampling for primary and restoration images and records the actual profile", async () => {
    const settings = { ...DEFAULT_SETTINGS, longestEdge: 16, engine: "gpu" as const, gpuSampling: "natural" as const };
    const result = await imageToPatternOnComputer("source", "input.png", settings, undefined, "restore");
    expect(mocks.sample).toHaveBeenCalledTimes(2);
    for (const args of mocks.sample.mock.calls) expect(args.slice(1)).toEqual([16, 16, "edge", "natural"]);
    expect(result.generationInfo).toMatchObject({ engine: "gpu", algorithm: "mard-optimized-v2", sampling: "natural-v1" });
    expect(result.backgroundCells).toEqual(result.cells);
  });

  it("records the original detail profile for old settings without a profile", async () => {
    const result = await imageToPatternOnComputer("source", "input.png", { ...DEFAULT_SETTINGS, longestEdge: 16 });
    expect(mocks.sample.mock.calls[0][4]).toBeUndefined();
    expect(result.generationInfo?.sampling).toBe("detail-v1");
  });

  it.each(["dominant", "average"] as const)("labels %s accurately even when natural is saved", async (processingMode) => {
    const result = await imageToPatternOnComputer("source", "input.png", {
      ...DEFAULT_SETTINGS, longestEdge: 16, gpuSampling: "natural", processingMode,
    });
    expect(result.generationInfo?.sampling).toBe(`${processingMode}-v1`);
    expect(mocks.quantize.mock.calls[0][4]).toBe(processingMode);
  });
});
