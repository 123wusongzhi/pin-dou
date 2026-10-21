import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleComputerSource, sampleDetailTiles, sampleNaturalTiles } from "../lib/gpu-sampling";
import { samplePixelTiles } from "../lib/pattern";

function tile(color: number[], size = 8) {
  return Uint8ClampedArray.from(Array.from({ length: size * size }, () => color).flat());
}

describe("GPU channel detail sampling", () => {
  it("preserves a uniform source color and coverage", () => {
    expect([...sampleDetailTiles(tile([194, 103, 58, 128]), 1, 1)])
      .toEqual([194, 103, 58, 128]);
  });

  it("retains contrast from a thin dark outline instead of selecting the white majority", () => {
    const pixels = tile([255, 255, 255, 255]);
    for (let y = 0; y < 8; y++) pixels.set([20, 20, 20, 255], (y * 8 + 3) * 4);
    const detail = sampleDetailTiles(pixels, 1, 1);
    const average = samplePixelTiles(pixels, 1, 1, "average");
    const dominant = samplePixelTiles(pixels, 1, 1, "dominant");
    expect(dominant[0]).toBe(255);
    expect(detail[0]).toBeLessThan(average[0] - 15);
    expect(detail[0]).toBeGreaterThan(170);
    expect(detail[3]).toBe(255);
  });

  it("does not leak RGB hidden under transparency into edge colors", () => {
    const pixels = tile([0, 0, 0, 0]);
    pixels.set([255, 0, 0, 255], 0);
    expect([...sampleDetailTiles(pixels, 1, 1)]).toEqual([255, 0, 0, 4]);
    expect([...sampleDetailTiles(tile([255, 0, 0, 0]), 1, 1)]).toEqual([0, 0, 0, 0]);
  });
});

describe("natural sampling", () => {
  it("preserves uniform source colors and alpha without inventing transparent RGB", () => {
    expect([...sampleNaturalTiles(tile([194, 103, 58, 128]), 1, 1)])
      .toEqual([194, 103, 58, 128]);
    expect([...sampleNaturalTiles(tile([255, 0, 255, 0]), 1, 1)])
      .toEqual([0, 0, 0, 0]);
    const pixels = tile([255, 0, 255, 0]);
    pixels.set([24, 116, 196, 255], 0);
    expect([...sampleNaturalTiles(pixels, 1, 1)]).toEqual([24, 116, 196, 4]);
  });

  it("keeps a white tile brighter than detail sampling while retaining a thin dark line signal", () => {
    const pixels = tile([255, 255, 255, 255]);
    for (let y = 0; y < 8; y++) pixels.set([20, 20, 20, 255], (y * 8 + 3) * 4);
    const natural = sampleNaturalTiles(pixels, 1, 1);
    const detail = sampleDetailTiles(pixels, 1, 1);
    const average = samplePixelTiles(pixels, 1, 1, "average");
    expect(natural[0]).toBeGreaterThan(detail[0]);
    expect(natural[0]).toBeLessThan(average[0]);
    expect(natural[0]).toBeGreaterThan(220);
    expect(natural[0]).toBe(natural[1]);
    expect(natural[1]).toBe(natural[2]);
    expect(natural[3]).toBe(detail[3]);
  });

  it("retains a supported blue feature more distinctly than the weighted mixture", () => {
    const pixels = tile([192, 192, 192, 255]);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 4; x++) pixels.set([40, 106, 180, 255], (y * 8 + x) * 4);
    }
    const natural = sampleNaturalTiles(pixels, 1, 1);
    const detail = sampleDetailTiles(pixels, 1, 1);
    expect(natural[2] - natural[0]).toBeGreaterThan(detail[2] - detail[0]);
    expect(natural[0]).toBeGreaterThan(40);
    expect(natural[2]).toBeLessThanOrEqual(192);
  });

  it("does not turn a small dark speck into a black tile", () => {
    const pixels = tile([246, 246, 246, 255]);
    pixels.set([0, 0, 0, 255], 0);
    const natural = sampleNaturalTiles(pixels, 1, 1);
    expect(natural[0]).toBeGreaterThan(235);
    expect(natural[1]).toBe(natural[0]);
    expect(natural[2]).toBe(natural[0]);
  });
});

describe("GPU sampling profiles", () => {
  afterEach(() => vi.unstubAllGlobals());

  function canvasInput() {
    const pixels = tile([255, 255, 255, 255]);
    for (let y = 0; y < 8; y++) pixels.set([20, 20, 20, 255], (y * 8 + 3) * 4);
    const context = { drawImage: vi.fn(), getImageData: () => ({ data: pixels }) };
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => context }) });
    return { pixels, source: { width: 8, height: 8 } as HTMLCanvasElement };
  }

  it("keeps omitted and explicit detail profiles on the original sampling result", () => {
    const { source, pixels } = canvasInput();
    expect(sampleComputerSource(source, 1, 1, "edge")).toEqual(sampleDetailTiles(pixels, 1, 1));
    expect(sampleComputerSource(source, 1, 1, "edge", "detail")).toEqual(sampleDetailTiles(pixels, 1, 1));
  });

  it("changes edge sampling only after the natural profile is selected", () => {
    const { source, pixels } = canvasInput();
    const result = sampleComputerSource(source, 1, 1, "edge", "natural");
    expect(result).toEqual(sampleNaturalTiles(pixels, 1, 1));
    expect(result).not.toEqual(sampleDetailTiles(pixels, 1, 1));
  });

  it.each(["dominant", "average"] as const)("keeps %s identical even when a natural preference is saved", (mode) => {
    const { source, pixels } = canvasInput();
    expect(sampleComputerSource(source, 1, 1, mode, "natural")).toEqual(samplePixelTiles(pixels, 1, 1, mode));
    expect(sampleComputerSource(source, 1, 1, mode, "natural")).toEqual(sampleComputerSource(source, 1, 1, mode));
  });
});
