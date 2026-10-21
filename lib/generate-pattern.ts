import type { GenerationSettings, Pattern, SourceTransform } from "./types";
import { imageToPattern } from "./pattern";
import { DEFAULT_TRANSFORM } from "./types";

export async function generatePattern(
  dataUrl: string,
  fileName: string,
  settings: GenerationSettings,
  transform: SourceTransform = DEFAULT_TRANSFORM,
  restoreSourceUrl?: string,
): Promise<Pattern> {
  const pattern: Pattern = settings.engine === "gpu"
    ? await (await import("./gpu-pattern")).imageToPatternOnComputer(
        dataUrl,
        fileName,
        settings,
        transform,
        restoreSourceUrl,
      )
    : await imageToPattern(dataUrl, fileName, settings, transform, restoreSourceUrl);
  return {
    ...pattern,
    generatedCells: [...pattern.cells],
    generationInfo: pattern.generationInfo ?? { engine: "local" },
  };
}
