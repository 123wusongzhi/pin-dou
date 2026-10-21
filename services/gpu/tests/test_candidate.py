"""Experimental importance-weighted entry point, without changing production v2."""
from pathlib import Path
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from quantizer import ALGORITHM, CANDIDATE_ALGORITHM, GpuQuantizer, PALETTE_IDS


class CandidateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = GpuQuantizer()

    def test_uniform_patch_stays_uniform_without_filling_color_budget(self):
        for rgb in ([255, 255, 255], [74, 97, 110], [205, 162, 143], [80, 170, 240]):
            pixels = np.tile([*rgb, 255], (99, 1)).astype(np.uint8)
            baseline = self.engine.quantize(pixels, 11, 9, 20, list(PALETTE_IDS), "edge")
            candidate = self.engine.quantize_candidate(pixels, 11, 9, 20, list(PALETTE_IDS), "edge")
            self.assertEqual(candidate["cells"], baseline["cells"])
            self.assertEqual(len(candidate["paletteIds"]), 1)
            self.assertEqual(baseline["algorithm"], ALGORITHM)
            self.assertEqual(candidate["algorithm"], CANDIDATE_ALGORITHM)

    def test_transparency_hidden_rgb_and_restricted_palette(self):
        first = np.asarray([
            [74, 97, 110, 255], [0, 0, 0, 0], [255, 255, 255, 36],
            [0, 0, 0, 35], [74, 97, 110, 255], [0, 0, 0, 0],
        ], dtype=np.uint8)
        second = first.copy()
        second[first[:, 3] < 36, :3] = [255, 0, 255]
        allowed = ["M3", "D25", "T1"]
        a = self.engine.quantize_candidate(first, 3, 2, 2, allowed, "edge")
        b = self.engine.quantize_candidate(second, 3, 2, 2, allowed, "edge")
        self.assertEqual(a["cells"], b["cells"])
        self.assertEqual(a["cells"], ["M3", None, "T1", None, "M3", None])
        self.assertLessEqual(len(a["paletteIds"]), 2)
        self.assertTrue(set(a["paletteIds"]) <= set(allowed))
        empty = self.engine.quantize_candidate(np.zeros((6, 4), dtype=np.uint8), 3, 2, 16, allowed, "edge")
        self.assertEqual(empty["cells"], [None] * 6)
        self.assertEqual(empty["paletteIds"], [])

    def test_identical_rgb_is_not_split_by_different_neighborhoods(self):
        colors = np.asarray([[255, 255, 255, 255], [74, 97, 110, 255], [80, 170, 240, 255], [200, 70, 85, 255]], dtype=np.uint8)
        image = np.tile(colors[0], (17 * 13, 1))
        image[30:155] = colors[1]
        image[90:99] = colors[2]
        image[140:145] = colors[3]
        result = self.engine.quantize_candidate(image, 17, 13, 3, list(PALETTE_IDS), "edge")
        for color in colors:
            region = np.all(image == color, axis=1)
            self.assertEqual(len(set(np.asarray(result["cells"])[region])), 1)
        self.assertLessEqual(len(set(result["cells"])), 3)
        self.assertEqual(set(result["cells"]), set(result["paletteIds"]))

    def test_importance_is_bounded_and_ignores_transparent_neighbors(self):
        cp = self.engine.cp
        rgb = np.asarray([[255, 255, 255], [74, 97, 110], [250, 0, 0], [0, 0, 255]], dtype=np.uint8)
        labs = self.engine.rgb_to_lab(rgb)
        weights = cp.asnumpy(self.engine._candidate_importance(labs, np.ones(4, dtype=bool), 2, 2))
        self.assertTrue(np.isfinite(weights).all())
        self.assertGreaterEqual(weights.min(), .35)
        self.assertLessEqual(weights.max(), 3.)
        flat = self.engine.rgb_to_lab(np.tile([74, 97, 110], (4, 1)))
        weights_a = cp.asnumpy(self.engine._candidate_importance(flat, np.array([True, False, False, False]), 2, 2))
        weights_b = cp.asnumpy(self.engine._candidate_importance(labs[cp.asarray([1, 2, 3, 0])], np.array([True, False, False, False]), 2, 2))
        np.testing.assert_array_equal(weights_a, weights_b)


if __name__ == "__main__":
    unittest.main()
