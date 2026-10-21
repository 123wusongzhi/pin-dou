import type { GpuSamplingProfile, ProcessingMode } from "./types";
import { rgbToLab } from "./beads";
import { sampleSource } from "./pattern";

const LINEAR = Float64Array.from({ length: 256 }, (_, value) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
});

function encode(value: number) {
  return Math.round(255 * (value <= 0.0031308
    ? value * 12.92
    : 1.055 * value ** (1 / 2.4) - 0.055));
}

/**
 * Detail-weighted area sampling for the new channel only.
 * The linear-light mean anchors each tile. Samples away from that mean get
 * more weight so a thin outline is not discarded by a white majority bucket.
 * A floor limits amplification of almost-uniform noise; alpha is independent.
 */
export function sampleDetailTiles(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const scale = Math.sqrt(pixels.length / (width * height * 4));
  if (!Number.isInteger(scale) || scale < 1 || width < 1 || height < 1)
    throw new Error("取样图片像素不完整。");
  const stride = width * scale;
  const result = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let red = 0, green = 0, blue = 0, coverage = 0;
      for (let row = 0; row < scale; row += 1) {
        for (let column = 0; column < scale; column += 1) {
          const offset = ((y * scale + row) * stride + x * scale + column) * 4;
          if (pixels[offset + 3] < 12) continue;
          const alpha = pixels[offset + 3] / 255;
          red += LINEAR[pixels[offset]] * alpha;
          green += LINEAR[pixels[offset + 1]] * alpha;
          blue += LINEAR[pixels[offset + 2]] * alpha;
          coverage += alpha;
        }
      }
      if (!coverage) continue;
      const meanR = red / coverage, meanG = green / coverage, meanB = blue / coverage;
      red = 0;
      green = 0;
      blue = 0;
      let total = 0;
      for (let row = 0; row < scale; row += 1) {
        for (let column = 0; column < scale; column += 1) {
          const offset = ((y * scale + row) * stride + x * scale + column) * 4;
          if (pixels[offset + 3] < 12) continue;
          const r = LINEAR[pixels[offset]], g = LINEAR[pixels[offset + 1]], b = LINEAR[pixels[offset + 2]];
          const deviation = Math.sqrt(((r - meanR) ** 2 + (g - meanG) ** 2 + (b - meanB) ** 2) / 3);
          const weight = pixels[offset + 3] / 255 * (0.04 + deviation) ** 0.7;
          red += r * weight;
          green += g * weight;
          blue += b * weight;
          total += weight;
        }
      }
      const target = (y * width + x) * 4;
      result.set([
        encode(red / total),
        encode(green / total),
        encode(blue / total),
        Math.round(255 * coverage / scale ** 2),
      ], target);
    }
  }
  return result;
}

const smooth = (low: number, high: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};
const luminance = (rgb: number[]) => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;

/**
 * Optional natural sampling; the default profile keeps the original detail path.
 * Keep the linear-light area mean as a brightness anchor. A supported real
 * source-color representative can recover some color separation, but never
 * replaces a whole tile. Smooth weights avoid a hard bright/colored switch.
 */
export function sampleNaturalTiles(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const detail = sampleDetailTiles(pixels, width, height);
  const scale = Math.sqrt(pixels.length / (width * height * 4));
  const stride = width * scale;
  const result = new Uint8ClampedArray(detail);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const buckets = new Map<number, { weight: number; sum: number[]; offsets: number[] }>();
      const sum = [0, 0, 0];
      let coverage = 0;
      for (let row = 0; row < scale; row += 1) {
        for (let column = 0; column < scale; column += 1) {
          const offset = ((y * scale + row) * stride + x * scale + column) * 4;
          if (pixels[offset + 3] < 12) continue;
          const weight = pixels[offset + 3] / 255;
          const key = ((pixels[offset] >> 5) << 6)
            | ((pixels[offset + 1] >> 5) << 3) | (pixels[offset + 2] >> 5);
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = { weight: 0, sum: [0, 0, 0], offsets: [] };
            buckets.set(key, bucket);
          }
          coverage += weight;
          bucket.weight += weight;
          bucket.offsets.push(offset);
          for (let channel = 0; channel < 3; channel += 1) {
            const value = LINEAR[pixels[offset + channel]] * weight;
            sum[channel] += value;
            bucket.sum[channel] += value;
          }
        }
      }
      if (!coverage) continue;
      const mean = sum.map(value => value / coverage);
      const meanLab = rgbToLab(mean.map(encode) as [number, number, number]);
      const neutralLight = smooth(70, 88, meanLab[0])
        * (1 - smooth(10, 22, Math.hypot(meanLab[1], meanLab[2])));
      const target = (y * width + x) * 4;
      // Keep at least 30% of the detail signal in bright neutral tiles so thin
      // hat/cape outlines still contribute; avoid the darker full-detail bias.
      const meanWeight = 0.35 + 0.35 * neutralLight;
      let color = mean.map((value, channel) =>
        value * meanWeight + LINEAR[detail[target + channel]] * (1 - meanWeight));
      let best: { weight: number; sum: number[]; offsets: number[] } | undefined;
      let bestScore = -Infinity;
      for (const bucket of buckets.values()) {
        if (bucket.weight < Math.max(2, coverage * 0.1)) continue;
        const lab = rgbToLab(bucket.sum.map(value => encode(value / bucket.weight)) as [number, number, number]);
        const score = bucket.weight * (1
          + 0.35 * Math.min(Math.hypot(lab[1], lab[2]) / 35, 1)
          + 0.2 * Math.min(Math.max(0, meanLab[0] - lab[0]) / 30, 1));
        if (score > bestScore) {
          bestScore = score;
          best = bucket;
        }
      }
      if (best) {
        const bucketMean = best.sum.map(value => value / best.weight);
        let representative = best.offsets[0], distance = Infinity;
        for (const offset of best.offsets) {
          const current = bucketMean.reduce((total, value, channel) =>
            total + (LINEAR[pixels[offset + channel]] - value) ** 2, 0);
          if (current < distance) {
            distance = current;
            representative = offset;
          }
        }
        const strength = 0.3 * (1 - neutralLight) * smooth(0.1, 0.6, best.weight / coverage);
        color = color.map((value, channel) =>
          value * (1 - strength) + LINEAR[pixels[representative + channel]] * strength);
      }
      // Relative luminance guard bounds added darkness independently of the
      // bucket winner. No cross-tile blur, sharpening, or synthetic black.
      const meanY = luminance(mean), colorY = luminance(color);
      const minimumY = meanY * (0.72 + 0.13 * neutralLight);
      if (colorY < minimumY && meanY > colorY) {
        const restore = (minimumY - colorY) / (meanY - colorY);
        color = color.map((value, channel) => value + (mean[channel] - value) * restore);
      }
      result.set(color.map(encode), target);
    }
  }
  return result;
}

export function sampleComputerSource(
  source: HTMLCanvasElement,
  width: number,
  height: number,
  mode: ProcessingMode,
  profile: GpuSamplingProfile = "detail",
) {
  if (mode !== "edge") return sampleSource(source, width, height, mode);
  const canvas = document.createElement("canvas");
  canvas.width = width * 8;
  canvas.height = height * 8;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("当前浏览器无法处理图片。");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const sample = profile === "natural" ? sampleNaturalTiles : sampleDetailTiles;
  return sample(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
    width,
    height,
  );
}
