import type { GenerationSettings, Pattern, SourceTransform } from "./types";
import { quantizeOnComputer } from "./gpu-client";
import { sampleComputerSource } from "./gpu-sampling";
import {
  cleanSmallRegions,
  loadImage,
  mardPalette,
  mergeSimilarColors,
  mirrorCells,
  patternLayout,
  transformedCanvas,
} from "./pattern";
import { DEFAULT_TRANSFORM } from "./types";

// The legacy imageToPattern remains independent of this opt-in GPU channel.
export async function imageToPatternOnComputer(
  dataUrl: string,
  fileName: string,
  settings: GenerationSettings,
  transform: SourceTransform = DEFAULT_TRANSFORM,
  restoreSourceUrl?: string,
): Promise<Pattern> {
  const started = performance.now();
  const source = transformedCanvas(await loadImage(dataUrl), transform);
  const layout = patternLayout(source.width, source.height, settings.longestEdge);
  const { width, height, contentWidth, contentHeight, x, y } = layout;
  const availableIds = mardPalette(
    settings.paletteSize,
    settings.excludedColorIds,
  ).map(color => color.id);

  async function convert(canvas: HTMLCanvasElement) {
    const result = await quantizeOnComputer(
      sampleComputerSource(canvas, contentWidth, contentHeight, settings.processingMode, settings.gpuSampling),
      contentWidth,
      contentHeight,
      Math.max(1, Math.min(291, Math.round(settings.maxColors))),
      settings.processingMode,
      availableIds,
    );
    let content = result.cells;
    if (settings.processingMode === "edge")
      content = cleanSmallRegions(content, contentWidth, 1, 3);
    else if (settings.processingMode === "dominant")
      content = cleanSmallRegions(content, contentWidth, 4, 18);
    content = mergeSimilarColors(content, Math.max(0, Math.min(30, settings.colorMerge)));
    let cells: Array<string | null> = Array(width * height).fill(null);
    for (let row = 0; row < contentHeight; row += 1) {
      const start = row * contentWidth;
      cells.splice((row + y) * width + x, contentWidth, ...content.slice(start, start + contentWidth));
    }
    if (settings.mirror) cells = mirrorCells(cells, width);
    return { cells, device: result.device, algorithm: result.algorithm };
  }

  // One request at a time: the desktop service intentionally bounds GPU work.
  const primary = await convert(source);
  const background = restoreSourceUrl
    ? await convert(transformedCanvas(await loadImage(restoreSourceUrl), transform))
    : undefined;
  return {
    id: crypto.randomUUID(),
    name: fileName.replace(/\.[^.]+$/, "") || "我的图纸",
    width,
    height,
    cells: primary.cells,
    backgroundCells: background?.cells,
    createdAt: new Date().toISOString(),
    sourcePreview: restoreSourceUrl ?? dataUrl,
    contentBounds: { x, y, width: contentWidth, height: contentHeight },
    generationInfo: {
      engine: "gpu",
      device: primary.device,
      algorithm: primary.algorithm,
      sampling: settings.processingMode === "edge"
        ? settings.gpuSampling === "natural" ? "natural-v1" : "detail-v1"
        : settings.processingMode === "dominant" ? "dominant-v1" : "average-v1",
      durationMs: performance.now() - started,
    },
  };
}
