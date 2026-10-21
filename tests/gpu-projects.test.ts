// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createSamplePattern } from "../lib/beads";
import { createBackupBlob, normalizeProject, readBackupProjects } from "../lib/projects";
import { DEFAULT_SETTINGS, DEFAULT_TRANSFORM, type Project } from "../lib/types";

function project(): Project {
  return {
    id: "gpu-project",
    name: "GPU 图纸",
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
    source: new Blob(["source"], { type: "image/png" }),
    sourceName: "source.png",
    sourceType: "image/png",
    sourceVariant: "original",
    transform: DEFAULT_TRANSFORM,
    settings: { ...DEFAULT_SETTINGS },
    pattern: createSamplePattern(),
  };
}

describe("GPU 图纸兼容与备份", () => {
  it("旧作品和默认设置继续使用本地标准算法", () => {
    expect(DEFAULT_SETTINGS.engine).toBeUndefined();
    expect(DEFAULT_SETTINGS.gpuSampling).toBeUndefined();
    expect(normalizeProject(project()).settings.engine).toBeUndefined();
    expect(normalizeProject(project()).settings.gpuSampling).toBeUndefined();
  });

  it("备份还原引擎、生成基线和手工改动", async () => {
    const value = project();
    value.settings.engine = "gpu";
    value.settings.gpuSampling = "natural";
    value.pattern.generatedCells = [...value.pattern.cells];
    value.pattern.cells = [...value.pattern.cells];
    value.pattern.cells[0] = "H7";
    value.pattern.generationInfo = { engine: "gpu", device: "Test GPU", algorithm: "mard-optimized-v2", sampling: "natural-v1", durationMs: 8 };
    const blob = await createBackupBlob([value]);
    const [restored] = await readBackupProjects(new File([blob], "backup.pindou.json"));
    expect(restored.settings.engine).toBe("gpu");
    expect(restored.settings.gpuSampling).toBe("natural");
    expect(restored.pattern.generatedCells).toEqual(value.pattern.generatedCells);
    expect(restored.pattern.cells).toEqual(value.pattern.cells);
    expect(restored.pattern.generationInfo).toEqual(value.pattern.generationInfo);
  });

  it("旧GPU备份缺少采样字段时继续保留原细节设置及格子", async () => {
    const value = project();
    value.settings.engine = "gpu";
    value.pattern.generationInfo = { engine: "gpu", algorithm: "mard-optimized-v2" };
    const backup = await createBackupBlob([value]);
    const [restored] = await readBackupProjects(new File([backup], "old-gpu.pindou.json"));
    expect(restored.settings.gpuSampling).toBeUndefined();
    expect(restored.pattern.generationInfo?.sampling).toBeUndefined();
    expect(restored.pattern.cells).toEqual(value.pattern.cells);
  });

  it("拒绝未知采样值，避免备份静默切换处理", async () => {
    const backup = JSON.parse(await (await createBackupBlob([project()])).text());
    backup.projects[0].settings.gpuSampling = "unknown";
    await expect(readBackupProjects(new File([JSON.stringify(backup)], "invalid.pindou.json")))
      .rejects.toThrow("备份内容不完整");
  });
});
