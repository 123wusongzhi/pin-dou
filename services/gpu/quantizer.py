"""CUDA-only fixed-palette quantization. No CPU computation fallback."""

from __future__ import annotations

import json
from pathlib import Path
from time import perf_counter

import numpy as np

ALGORITHM = "mard-optimized-v2"
PALETTE = json.loads(Path(__file__).with_name("palette.json").read_text(encoding="utf-8"))["colors"]
PALETTE_IDS = tuple(color["id"] for color in PALETTE)
PALETTE_INDEX = {color_id: index for index, color_id in enumerate(PALETTE_IDS)}
THREADS = 256
SWAP_ROUNDS = 2
SWAP_CANDIDATES = 24
CHROMA_GUARD_STRENGTH = 0.2
CHROMA_GUARD_SCALE = 20.0
CHROMA_GUARD_ALLOWANCE = 8.0
CHROMA_GUARD_SOFTNESS = 4.0
CANDIDATE_ALGORITHM = "mard-natural-v3-candidate"


class GpuQuantizer:
    def __init__(self):
        # Import/driver failures deliberately reach the service's unavailable state.
        import cupy as cp

        self.cp = cp
        if cp.cuda.runtime.getDeviceCount() < 1:
            raise RuntimeError("No CUDA device was detected.")
        self.device_id = 0
        with cp.cuda.Device(self.device_id):
            properties = cp.cuda.runtime.getDeviceProperties(self.device_id)
            device_name = properties["name"]
            self.device = device_name.decode() if isinstance(device_name, bytes) else device_name
            module = cp.RawModule(
                code=Path(__file__).with_name("ciede2000.cu").read_text(encoding="utf-8"),
                options=("--std=c++11",),
            )
            self.matrix_kernel = module.get_function("distance_matrix")
            self.paired_kernel = module.get_function("paired_distances")
            self.gains_kernel = module.get_function("marginal_gains")
            self.swaps_kernel = module.get_function("swap_gains")
            self.palette_lab = self.rgb_to_lab(cp.asarray([color["rgb"] for color in PALETTE]))
            self.palette_distances = self.distance_matrix(self.palette_lab, self.palette_lab)
            self._warmup()

    def rgb_to_lab(self, rgb):
        """Match lib/beads.ts, including its sRGB/D65 matrix constants."""
        cp = self.cp
        values = cp.asarray(rgb, dtype=cp.float64) / 255.0
        linear = cp.where(values <= 0.04045, values / 12.92, ((values + 0.055) / 1.055) ** 2.4)
        matrix = cp.asarray(
            [[0.4124 / 0.95047, 0.2126, 0.0193 / 1.08883],
             [0.3576 / 0.95047, 0.7152, 0.1192 / 1.08883],
             [0.1805 / 0.95047, 0.0722, 0.9505 / 1.08883]],
            dtype=cp.float64,
        )
        xyz = linear @ matrix
        curved = cp.where(xyz > 0.008856, cp.cbrt(xyz), 7.787 * xyz + 16.0 / 116.0)
        return cp.ascontiguousarray(cp.stack(
            [116 * curved[:, 1] - 16, 500 * (curved[:, 0] - curved[:, 1]),
             200 * (curved[:, 1] - curved[:, 2])],
            axis=1,
        ))

    def distance_matrix(self, samples, palette):
        cp = self.cp
        output = cp.empty((len(palette), len(samples)), dtype=cp.float64)
        self.matrix_kernel(
            ((output.size + THREADS - 1) // THREADS,), (THREADS,),
            (cp.ascontiguousarray(samples), cp.ascontiguousarray(palette), output,
             np.int32(len(samples)), np.int32(len(palette))),
        )
        return output

    def paired_distances(self, left, right):
        cp = self.cp
        left = cp.ascontiguousarray(cp.asarray(left, dtype=cp.float64))
        right = cp.ascontiguousarray(cp.asarray(right, dtype=cp.float64))
        output = cp.empty(len(left), dtype=cp.float64)
        self.paired_kernel(
            ((len(left) + THREADS - 1) // THREADS,), (THREADS,),
            (left, right, output, np.int32(len(left))),
        )
        return output

    def _matching_cost(self, distances, samples, palette):
        """Keep muted source colors from becoming much more saturated.

        CIEDE2000 alone can prefer a vivid blue over a nearby muted blue-gray
        in a sparse fixed palette. This is an additional optimization cost,
        not a change to the standard Delta E calculation. The source-chroma
        weight decays continuously; there is no saturation cutoff.
        """
        cp = self.cp
        source_chroma = cp.hypot(samples[:, 1], samples[:, 2])[None, :]
        palette_chroma = cp.hypot(palette[:, 1], palette[:, 2])[:, None]
        excess = cp.maximum(palette_chroma - source_chroma - CHROMA_GUARD_ALLOWANCE, 0.0)
        weight = CHROMA_GUARD_STRENGTH * cp.exp(-cp.square(source_chroma / CHROMA_GUARD_SCALE))
        # The squared hinge has zero slope at its onset and does not penalize
        # exact source matches or ordinary small chroma differences.
        penalty = weight * cp.square(excess) / (excess + CHROMA_GUARD_SOFTNESS)
        return cp.ascontiguousarray(distances + penalty)

    def _warmup(self):
        cp = self.cp
        reference = self.paired_distances([[50, 2.6772, -79.7751]], [[50, 0, -82.7485]])
        if abs(float(reference[0].get()) - 2.0425) > 0.00005:
            raise RuntimeError("CUDA CIEDE2000 warmup did not match the reference value.")
        # Warm representative reduction sizes as well as the custom CUDA kernels.
        # A fresh CuPy install otherwise compiles these during the first request.
        rng = np.random.default_rng(5070)
        for size in (32, 192):
            pixels = np.column_stack([
                rng.integers(0, 256, size=(size * size, 3), dtype=np.uint8),
                np.full(size * size, 255, dtype=np.uint8),
            ])
            self.quantize(pixels, size, size, 12, list(PALETTE_IDS), "average")
        cp.cuda.get_current_stream().synchronize()

    def _gains(self, distances, weights, best):
        cp = self.cp
        scores = cp.empty(len(distances), dtype=cp.float64)
        self.gains_kernel(
            (len(distances),), (THREADS,),
            (distances, weights, best, scores, np.int32(distances.shape[1])),
        )
        return scores

    def _legacy_palette(self, distances, weights, allowed_indices, first_positions, limit):
        """Frequency/distance heuristic seed; final assignment uses original RGB."""
        cp = self.cp
        nearest = cp.argmin(distances, axis=0)
        histogram = cp.bincount(nearest, weights=weights, minlength=len(distances))
        first = cp.full(len(distances), np.iinfo(np.int64).max, dtype=cp.int64)
        cp.minimum.at(first, nearest, first_positions)
        used = cp.argsort(first)
        used = used[histogram[used] > 0]
        if len(used) <= limit:
            return used
        selected = [int(used[cp.argmax(histogram[used])].get())]
        color_distances = self.palette_distances[allowed_indices[:, None], allowed_indices[None, :]]
        best = color_distances[selected[0]].copy()
        for _ in range(1, limit):
            scores = best * cp.sqrt(histogram)
            scores[histogram == 0] = -1
            scores[cp.asarray(selected)] = -1
            chosen = int(used[cp.argmax(scores[used])].get())
            selected.append(chosen)
            best = cp.minimum(best, color_distances[chosen])
        return cp.asarray(selected, dtype=cp.int32)

    def _select_palette(self, distances, weights, allowed_indices, first_positions, limit):
        cp = self.cp
        color_count = len(distances)
        if limit >= color_count:
            return cp.arange(color_count, dtype=cp.int32)
        selected = [int(cp.argmin((distances * weights[None, :]).sum(axis=1)).get())]
        best = distances[selected[0]].copy()
        for _ in range(1, limit):
            gains = self._gains(distances, weights, best)
            gains[cp.asarray(selected)] = -cp.inf
            chosen = int(cp.argmax(gains).get())
            if float(gains[chosen].get()) <= 1e-10:
                break
            selected.append(chosen)
            best = cp.minimum(best, distances[chosen])
        selected = cp.asarray(selected, dtype=cp.int32)
        legacy = self._legacy_palette(distances, weights, allowed_indices, first_positions, limit)
        legacy_cost = (cp.min(distances[legacy], axis=0) * weights).sum()
        if float(legacy_cost.get()) < float((best * weights).sum().get()):
            selected = legacy

        for _ in range(SWAP_ROUNDS):
            chosen_distances = distances[selected]
            owners = cp.argmin(chosen_distances, axis=0).astype(cp.int64)
            best = cp.min(chosen_distances, axis=0)
            if len(selected) == 1:
                second = cp.full(best.shape, cp.inf, dtype=cp.float64)
            else:
                second = cp.partition(chosen_distances, 1, axis=0)[1].copy()
            gains = self._gains(distances, weights, best)
            gains[selected] = -cp.inf
            candidates = cp.argsort(gains)[-min(SWAP_CANDIDATES, color_count - len(selected)):]
            candidates = candidates.astype(cp.int32)
            if not len(candidates) or float(cp.max(gains).get()) <= 1e-10:
                break
            scores = cp.empty(len(selected) * len(candidates), dtype=cp.float64)
            self.swaps_kernel(
                (len(scores),), (THREADS,),
                (distances, weights, best, second, owners, candidates, scores,
                 np.int32(distances.shape[1]), np.int32(len(candidates))),
            )
            winner = int(cp.argmax(scores).get())
            if float(scores[winner].get()) <= 1e-8:
                break
            selected[winner // len(candidates)] = candidates[winner % len(candidates)]
        return selected

    def quantize(self, pixels, width, height, max_colors, palette_ids, processing_mode):
        started = perf_counter()
        cp = self.cp
        # CUDA current devices/streams are thread-local; requests run in a worker thread.
        with cp.cuda.Device(self.device_id):
            array = np.asarray(pixels, dtype=np.uint8).reshape(width * height, 4)
            opaque = array[:, 3] >= 36
            cells = np.empty(width * height, dtype=object)
            cells[:] = None
            if not np.any(opaque):
                return {
                    "cells": cells.tolist(), "paletteIds": [], "device": self.device,
                    "algorithm": ALGORITHM, "durationMs": (perf_counter() - started) * 1000,
                    "meanDeltaE": 0.0,
                }
            # Deduplication is exact, and weights retain every visible cell's contribution.
            colors, first_positions, inverse, counts = np.unique(
                array[opaque, :3], axis=0, return_index=True, return_inverse=True, return_counts=True,
            )
            allowed = cp.asarray([PALETTE_INDEX[color_id] for color_id in palette_ids], dtype=cp.int32)
            samples = self.rgb_to_lab(colors)
            palette = self.palette_lab[allowed]
            distances = self.distance_matrix(samples, palette)
            if not bool(cp.isfinite(distances).all().get()):
                raise RuntimeError("CUDA produced non-finite color distances.")
            matching_cost = self._matching_cost(distances, samples, palette)
            weights = cp.asarray(counts, dtype=cp.float64)
            selected = self._select_palette(
                matching_cost, weights, allowed, cp.asarray(first_positions, dtype=cp.int64),
                min(max_colors, len(allowed)),
            )
            assignment = cp.argmin(matching_cost[selected], axis=0)
            assigned_indices = selected[assignment]
            indices = cp.asnumpy(assigned_indices)
            actual_ids = np.asarray(palette_ids, dtype=object)[indices]
            cells[opaque] = actual_ids[inverse]
            # Report standard Delta E of the actual assignments, not the
            # guarded objective or the nearest raw-distance alternative.
            assigned_error = distances[assigned_indices, cp.arange(len(colors))]
            mean_error = float((assigned_error * weights).sum().get()) / int(counts.sum())
            cp.cuda.get_current_stream().synchronize()
            return {
                "cells": cells.tolist(),
                "paletteIds": [palette_ids[index] for index in cp.asnumpy(selected).tolist()],
                "device": self.device, "algorithm": ALGORITHM,
                "durationMs": round((perf_counter() - started) * 1000, 3),
                "meanDeltaE": mean_error,
            }

    def _candidate_importance(self, labs, opaque, width, height):
        """Bounded source-only importance; no face coordinates or target colors.

        Returns one weight per visible cell, in row-major order. Transparent
        neighbors never create contrast and never contribute to hue frequency.
        This is used only by the explicitly experimental candidate entry point.
        """
        cp = self.cp
        visible = cp.asarray(opaque).reshape(height, width)
        grid = labs.reshape(height, width, 3)
        contrast = cp.zeros((height, width), dtype=cp.float64)
        if width > 1:
            horizontal = self.paired_distances(grid[:, :-1].reshape(-1, 3), grid[:, 1:].reshape(-1, 3))
            horizontal = horizontal.reshape(height, width - 1)
            horizontal *= visible[:, :-1] & visible[:, 1:]
            contrast[:, :-1] = cp.maximum(contrast[:, :-1], horizontal)
            contrast[:, 1:] = cp.maximum(contrast[:, 1:], horizontal)
        if height > 1:
            vertical = self.paired_distances(grid[:-1].reshape(-1, 3), grid[1:].reshape(-1, 3))
            vertical = vertical.reshape(height - 1, width)
            vertical *= visible[:-1] & visible[1:]
            contrast[:-1] = cp.maximum(contrast[:-1], vertical)
            contrast[1:] = cp.maximum(contrast[1:], vertical)
        source = labs[visible.ravel()]
        chroma = cp.hypot(source[:, 1], source[:, 2])
        color_strength = cp.square(chroma) / (cp.square(chroma) + 400.0)
        edge = cp.minimum(contrast.ravel()[visible.ravel()] / 15.0, 1.0)

        # Soft assignment to adjacent circular hue bins avoids a jump when a
        # source hue crosses a bin boundary; neutral colors have little vote.
        hue = cp.mod(cp.arctan2(source[:, 2], source[:, 1]), 2.0 * cp.pi) * (12.0 / (2.0 * cp.pi))
        lower = cp.floor(hue).astype(cp.int32) % 12
        upper = (lower + 1) % 12
        fraction = hue - cp.floor(hue)
        histogram = cp.bincount(lower, weights=color_strength * (1.0 - fraction), minlength=12)
        histogram += cp.bincount(upper, weights=color_strength * fraction, minlength=12)
        frequency = histogram[lower] * (1.0 - fraction) + histogram[upper] * fraction
        rarity = cp.minimum(0.75, cp.sqrt(len(source) * 0.005 / (frequency + 1.0))) * color_strength
        weights = (1.0 + edge + 0.5 * color_strength) * (1.0 + rarity)

        # Flat near-white is still represented, with less palette-selection
        # weight. White highlights at edges retain their structural weight.
        flat_white = cp.exp(-cp.square((100.0 - source[:, 0]) / 8.0))
        flat_white *= cp.exp(-cp.square(chroma / 8.0)) * cp.square(1.0 - edge)
        return cp.clip(weights * (1.0 - 0.65 * flat_white), 0.35, 3.0)

    def quantize_candidate(self, pixels, width, height, max_colors, palette_ids, processing_mode):
        """Offline natural-palette candidate; the production v2 route is unchanged.

        Importance changes palette allocation only. Final original-RGB assignment
        keeps v2's guarded color cost, so identical samples cannot split into
        different labels merely because their spatial importance differs.
        """
        started = perf_counter()
        cp = self.cp
        with cp.cuda.Device(self.device_id):
            array = np.asarray(pixels, dtype=np.uint8).reshape(width * height, 4)
            opaque = array[:, 3] >= 36
            cells = np.empty(width * height, dtype=object)
            cells[:] = None
            if not np.any(opaque):
                return {
                    "cells": cells.tolist(), "paletteIds": [], "device": self.device,
                    "algorithm": CANDIDATE_ALGORITHM, "durationMs": (perf_counter() - started) * 1000,
                    "meanDeltaE": 0.0,
                }
            colors, first_positions, inverse, counts = np.unique(
                array[opaque, :3], axis=0, return_index=True, return_inverse=True, return_counts=True,
            )
            allowed = cp.asarray([PALETTE_INDEX[color_id] for color_id in palette_ids], dtype=cp.int32)
            samples = self.rgb_to_lab(colors)
            palette = self.palette_lab[allowed]
            distances = self.distance_matrix(samples, palette)
            if not bool(cp.isfinite(distances).all().get()):
                raise RuntimeError("CUDA produced non-finite candidate color distances.")
            matching_cost = self._matching_cost(distances, samples, palette)
            full_labs = cp.zeros((len(array), 3), dtype=cp.float64)
            full_labs[cp.asarray(opaque)] = samples[cp.asarray(inverse)]
            importance = self._candidate_importance(full_labs, opaque, width, height)
            weights = cp.bincount(cp.asarray(inverse), weights=importance, minlength=len(colors))
            selected = self._select_palette(
                matching_cost, weights, allowed, cp.asarray(first_positions, dtype=cp.int64),
                min(max_colors, len(allowed)),
            )
            assigned_indices = selected[cp.argmin(matching_cost[selected], axis=0)]
            indices = cp.asnumpy(assigned_indices)
            cells[opaque] = np.asarray(palette_ids, dtype=object)[indices][inverse]
            # Return the palette actually used. A color limit is an upper bound;
            # uniform input must not acquire redundant or artificial extra colors.
            used = set(indices.tolist())
            actual_palette = [palette_ids[index] for index in cp.asnumpy(selected).tolist() if index in used]
            assigned_error = distances[assigned_indices, cp.arange(len(colors))]
            mean_error = float((assigned_error * cp.asarray(counts)).sum().get()) / int(counts.sum())
            cp.cuda.get_current_stream().synchronize()
            return {
                "cells": cells.tolist(), "paletteIds": actual_palette, "device": self.device,
                "algorithm": CANDIDATE_ALGORITHM, "durationMs": round((perf_counter() - started) * 1000, 3),
                "meanDeltaE": mean_error,
            }
