"""Real GPU checks. These intentionally fail instead of silently skipping without CUDA."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

import numpy as np

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from quantizer import ALGORITHM, GpuQuantizer, PALETTE_IDS, PALETTE_INDEX


class CudaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = GpuQuantizer()
        cls.cp = cls.engine.cp
        print(json.dumps({"cudaDevice": cls.engine.device, "cudaRuntime": cls.cp.cuda.runtime.runtimeGetVersion()}))

    def test_all_34_ciede2000_reference_pairs_and_symmetry(self):
        reference = np.asarray(json.loads(
            Path(__file__).with_name("ciede2000-reference.json").read_text(encoding="utf-8"),
        ))
        actual = self.cp.asnumpy(self.engine.paired_distances(reference[:, :3], reference[:, 3:6]))
        reverse = self.cp.asnumpy(self.engine.paired_distances(reference[:, 3:6], reference[:, :3]))
        np.testing.assert_allclose(actual, reference[:, 6], rtol=0, atol=0.00005)
        np.testing.assert_allclose(actual, reverse, rtol=0, atol=1e-11)

    def test_random_lab_pairs_against_existing_js_color_diff(self):
        rng = np.random.default_rng(78129)
        left = rng.uniform([0, -100, -100], [100, 100, 100], size=(256, 3))
        right = rng.uniform([0, -100, -100], [100, 100, 100], size=(256, 3))
        script = """
const {diff} = require('color-diff');
let input=''; process.stdin.on('data',part=>input+=part); process.stdin.on('end',()=>{
const [left,right]=JSON.parse(input);
console.log(JSON.stringify(left.map(([L,a,b],i)=>diff({L,a,b},{L:right[i][0],a:right[i][1],b:right[i][2]}))));
});
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=REPO_ROOT,
            input=json.dumps([left.tolist(), right.tolist()]),
            capture_output=True, text=True, check=True,
        )
        expected = np.asarray(json.loads(result.stdout))
        actual = self.cp.asnumpy(self.engine.paired_distances(left, right))
        np.testing.assert_allclose(actual, expected, rtol=1e-11, atol=1e-10)

    def test_transparency_allowed_palette_non_square_and_empty(self):
        pixels = np.array([[0, 0, 0, 255], [255, 255, 255, 36], [10, 25, 30, 35]], dtype=np.uint8)
        result = self.engine.quantize(pixels, 3, 1, 2, ["T1", "H7"], "edge")
        self.assertEqual(result["cells"], ["H7", "T1", None])
        self.assertLess(result["meanDeltaE"], 1e-10)
        one = self.engine.quantize(pixels, 3, 1, 20, ["H7"], "average")
        self.assertEqual(one["cells"], ["H7", "H7", None])
        empty = self.engine.quantize(np.zeros((6, 4), dtype=np.uint8), 2, 3, 3, list(PALETTE_IDS), "dominant")
        self.assertEqual(empty["cells"], [None] * 6)
        self.assertEqual(empty["paletteIds"], [])
        self.assertEqual(empty["meanDeltaE"], 0)

    def test_muted_blue_gray_does_not_become_vivid_blue(self):
        pixels = np.array([[74, 97, 110, 255], [74, 96, 109, 255]], dtype=np.uint8)
        labs = self.engine.rgb_to_lab(pixels[:, :3])
        muted = self.engine.palette_lab[self.cp.asarray([PALETTE_INDEX["M3"]] * 2)]
        expected_error = float(self.engine.paired_distances(labs, muted).mean().get())
        # One color exercises palette selection. Two exercises final assignment
        # when both the tempting vivid color and muted color are retained.
        for limit in (1, 2):
            result = self.engine.quantize(pixels, 2, 1, limit, ["D25", "M3"], "dominant")
            self.assertEqual(result["cells"], ["M3", "M3"])
            self.assertEqual(result["algorithm"], ALGORITHM)
            self.assertAlmostEqual(result["meanDeltaE"], expected_error, places=10)
        full = self.engine.quantize(pixels, 2, 1, 291, list(PALETTE_IDS), "dominant")
        self.assertEqual(full["cells"], ["M3", "M3"])

    def test_guard_preserves_exact_white_skin_red_and_blue_palette_colors(self):
        ids = ["T1", "H7", "E5", "F10", "C6", "D25"]
        from quantizer import PALETTE
        pixels = np.asarray([PALETTE[PALETTE_INDEX[color]]["rgb"] + [255] for color in ids], dtype=np.uint8)
        result = self.engine.quantize(pixels, len(ids), 1, len(ids), list(PALETTE_IDS), "average")
        self.assertEqual(result["cells"], ids)
        self.assertLess(result["meanDeltaE"], 1e-10)

    def test_guard_is_continuous_across_source_chroma_25(self):
        cp = self.cp
        samples = cp.asarray([[50., 0., -24.9999], [50., 0., -25.], [50., 0., -25.0001]])
        palette = cp.asarray([[50., 0., -65.], [50., 0., -25.]])
        raw = self.engine.distance_matrix(samples, palette)
        penalty = cp.asnumpy(self.engine._matching_cost(raw, samples, palette) - raw)
        self.assertGreater(penalty[0, 2], 0)
        self.assertLess(np.abs(np.diff(penalty[0])).max(), 0.001)
        np.testing.assert_array_equal(penalty[1], np.zeros(3))

    def test_guarded_objective_against_existing_algorithm_without_postprocessing(self):
        rng = np.random.default_rng(572)
        cases = []
        for name, width, height, limit in [
            ("random-12", 16, 16, 12), ("random-4", 21, 13, 4), ("random-1", 7, 11, 1),
        ]:
            pixels = np.column_stack([
                rng.integers(0, 256, size=(width * height, 3), dtype=np.uint8),
                np.full(width * height, 255, dtype=np.uint8),
            ])
            cases.append({"name": name, "width": width, "height": height, "limit": limit, "pixels": pixels.tolist()})
        gray = np.repeat(np.linspace(0, 255, 256, dtype=np.uint8)[:, None], 3, axis=1)
        gray = np.column_stack([gray, np.full(256, 255, dtype=np.uint8)])
        cases.append({"name": "gray-ramp", "width": 16, "height": 16, "limit": 6, "pixels": gray.tolist()})
        script = """
const esbuild = require('esbuild');
const source = esbuild.buildSync({entryPoints:['lib/pattern.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['heic2any']}).outputFiles[0].text;
const mod={exports:{}}; new Function('require','module','exports',source)(require,mod,mod.exports);
let input='';process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>{
console.log(JSON.stringify(JSON.parse(input).map(test=>mod.exports.imageDataToCells(new Uint8ClampedArray(test.pixels.flat()),test.width,test.height,test.limit,'average',undefined,0))));
});
"""
        previous = subprocess.run(
            ["node", "-e", script], cwd=REPO_ROOT, input=json.dumps(cases),
            capture_output=True, text=True, check=True,
        )
        previous_results = json.loads(previous.stdout)
        measurements = []
        for case, old_cells in zip(cases, previous_results):
            with self.subTest(name=case["name"]):
                pixels = np.asarray(case["pixels"], dtype=np.uint8)
                result = self.engine.quantize(
                    pixels, case["width"], case["height"], case["limit"], list(PALETTE_IDS), "average",
                )
                labs = self.engine.rgb_to_lab(pixels[:, :3])
                old_indices = self.cp.asarray([PALETTE_INDEX[color] for color in old_cells])
                old_labs = self.engine.palette_lab[old_indices]
                old_error = float(self.engine.paired_distances(labs, old_labs).mean().get())
                costs = self.engine._matching_cost(
                    self.engine.distance_matrix(labs, self.engine.palette_lab), labs, self.engine.palette_lab,
                )
                new_indices = self.cp.asarray([PALETTE_INDEX[color] for color in result["cells"]])
                columns = self.cp.arange(len(pixels))
                old_cost = float(costs[old_indices, columns].mean().get())
                new_cost = float(costs[new_indices, columns].mean().get())
                self.assertLessEqual(new_cost, old_cost + 1e-7)
                actual_error = float(self.engine.paired_distances(labs, self.engine.palette_lab[new_indices]).mean().get())
                self.assertAlmostEqual(result["meanDeltaE"], actual_error, places=10)
                self.assertLessEqual(len(set(result["cells"])), case["limit"])
                self.assertTrue(set(result["cells"]).issubset(result["paletteIds"]))
                measurements.append({
                    "case": case["name"], "oldMeanDeltaE": old_error,
                    "gpuMeanDeltaE": result["meanDeltaE"], "gpuDurationMs": result["durationMs"],
                    "oldGuardedCost": old_cost, "gpuGuardedCost": new_cost,
                })
        print(json.dumps({"syntheticQualityChecks": measurements}))


if __name__ == "__main__":
    unittest.main()
