import base64
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from server import create_app
from quantizer import ALGORITHM

TOKEN = "test-only-token-with-more-than-thirty-two-characters"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def payload():
    return {
        "width": 2, "height": 1,
        "pixels": base64.b64encode(bytes([0, 0, 0, 255, 255, 255, 255, 0])).decode(),
        "maxColors": 1, "paletteIds": ["H7", "T1"], "processingMode": "average",
    }


class StubEngine:
    """Protocol-only test double; production never substitutes for CUDA."""
    device = "protocol-test-double"

    def quantize(self, pixels, width, height, max_colors, palette_ids, mode):
        return {
            "cells": ["H7", None], "paletteIds": ["H7"], "device": self.device,
            "algorithm": ALGORITHM, "durationMs": 0, "meanDeltaE": 0,
        }


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        token_file = Path(self.temp.name) / "token.txt"
        token_file.write_text(TOKEN, encoding="utf-8")
        self.environment = patch.dict(os.environ, {"GPU_SERVICE_TOKEN_FILE": str(token_file)})
        self.environment.start()
        self.client_context = TestClient(create_app(StubEngine))
        self.client = self.client_context.__enter__()

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.environment.stop()
        self.temp.cleanup()

    def test_authentication_precedes_request_processing(self):
        for path in ["/health", "/v1/quantize"]:
            response = self.client.get(path) if path == "/health" else self.client.post(path, json=payload())
            self.assertEqual(response.status_code, 401)
        self.assertEqual(self.client.get("/health", headers=HEADERS).status_code, 200)
        self.assertEqual(self.client.post("/v1/quantize", headers=HEADERS, json=payload()).json()["cells"], ["H7", None])

    def test_strict_dimensions_palette_and_rgba_validation(self):
        cases = [
            {"width": 0}, {"height": 193}, {"width": True}, {"maxColors": 0},
            {"maxColors": 292}, {"paletteIds": []}, {"paletteIds": ["not-a-color"]},
            {"paletteIds": ["H7", "H7"]}, {"pixels": "!!!!"},
            {"pixels": base64.b64encode(b"short").decode()},
            {"processingMode": "invented"}, {"extra": "unrecognized"},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                request = payload() | changes
                self.assertEqual(
                    self.client.post("/v1/quantize", headers=HEADERS, json=request).status_code, 422,
                )

    def test_body_limit(self):
        response = self.client.post("/v1/quantize", headers=HEADERS, content=b" " * (300 * 1024 + 1))
        self.assertEqual(response.status_code, 413)

    def test_busy_returns_429_without_a_compute_queue(self):
        entered, released = threading.Event(), threading.Event()

        class BlockingEngine(StubEngine):
            def quantize(self, *args):
                entered.set()
                released.wait(timeout=5)
                return super().quantize(*args)

        with TestClient(create_app(BlockingEngine)) as client:
            with ThreadPoolExecutor(max_workers=1) as executor:
                active = executor.submit(client.post, "/v1/quantize", headers=HEADERS, json=payload())
                self.assertTrue(entered.wait(timeout=5))
                try:
                    self.assertEqual(client.post("/v1/quantize", headers=HEADERS, json=payload()).status_code, 429)
                    self.assertTrue(client.get("/health", headers=HEADERS).json()["busy"])
                finally:
                    released.set()
                self.assertEqual(active.result(timeout=5).status_code, 200)

    def test_failed_cuda_initialization_never_reports_available(self):
        def unavailable():
            raise RuntimeError("simulated missing CUDA driver")

        with TestClient(create_app(unavailable)) as client:
            health = client.get("/health", headers=HEADERS)
            self.assertEqual(health.status_code, 503)
            self.assertFalse(health.json()["available"])
            self.assertEqual(client.post("/v1/quantize", headers=HEADERS, json=payload()).status_code, 503)

    def test_runtime_failure_disables_further_requests(self):
        class FailingEngine(StubEngine):
            def quantize(self, *args):
                raise RuntimeError("simulated CUDA failure")

        with TestClient(create_app(FailingEngine)) as client:
            self.assertEqual(client.post("/v1/quantize", headers=HEADERS, json=payload()).status_code, 503)
            self.assertFalse(client.get("/health", headers=HEADERS).json()["available"])
            self.assertEqual(client.post("/v1/quantize", headers=HEADERS, json=payload()).status_code, 503)


if __name__ == "__main__":
    unittest.main()
