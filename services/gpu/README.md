# Local NVIDIA GPU quantization service

This is an additional conversion channel. It does not replace the browser's existing
algorithm or run AI image generation. The browser supplies one sampled RGBA color
per bead cell; this service selects actual, allowed MARD colors on the computer's
NVIDIA GPU. Background removal, image sampling, square-board padding and optional
spatial cleanup remain in the application.

## Install and start on Windows

Requirements: an NVIDIA GPU with a working CUDA 12 compatible driver, Python 3.13,
and `uv`. The CUDA runtime libraries are installed inside this service's virtual
environment; a system CUDA toolkit is not required.

From the repository root:

```powershell
uv venv services/gpu/.venv --python 3.13
uv pip install --python services/gpu/.venv/Scripts/python.exe -r services/gpu/requirements.lock
& services/gpu/start.ps1
```

`start.ps1` starts one hidden process on `0.0.0.0:8766` so that the Docker application
can reach it through `http://host.docker.internal:8766`. For use without Docker,
pass `-Bind 127.0.0.1`. Other parameters are `-Port`, `-TokenFile`, and `-Foreground`.
The script creates `services/gpu/.runtime/token.txt` if it is missing, and passes
its path through `GPU_SERVICE_TOKEN_FILE`. It never prints the token. Mount that
same file read-only into the application container; the token stays on the server
side and must not be shipped to browsers.

`requirements.txt` lists the direct dependencies; `requirements.lock` fixes the
entire tested Windows/Python 3.13 dependency set, including the CUDA libraries.

The service requires a Bearer token for both endpoints. It has no browser CORS
permission, anonymous health endpoint, or interactive API documentation. The PID
and logs are in `.runtime/`. CUDA initialization and warmup happen before health
becomes available. If CUDA fails, health/quantization return HTTP 503; there is no
CPU implementation disguised as GPU.

Use `& services/gpu/stop.ps1` to stop the recorded service process. The stop script
checks that its PID still belongs to this virtual environment before stopping it.
On Windows it also validates and stops the interpreter child created by the
virtual environment launcher.
First startup can take longer while CuPy compiles and caches kernels; startup
warmup includes both 32 × 32 and 192 × 192 quantization with the default 12 colors.

## Protocol

`GET /health` with `Authorization: Bearer <token>` returns:

```json
{
  "available": true,
  "device": "NVIDIA GeForce RTX 5070 Ti",
  "algorithm": "mard-optimized-v2",
  "busy": false
}
```

`POST /v1/quantize`, with the same authorization and JSON content type:

```json
{
  "width": 65,
  "height": 40,
  "pixels": "<standard base64 of width * height * 4 RGBA8 bytes>",
  "maxColors": 12,
  "paletteIds": ["H7", "T1", "E5"],
  "processingMode": "edge"
}
```

Width/height must be integers in 1–192, `maxColors` in 1–291, palette IDs unique
and present in `palette.json`, and the entire body at most 300 KiB. `maxColors`
is capped to the allowed palette size. Pixels with alpha below 36 produce `null`;
the other pixels always receive a color from the requested palette. Alpha is a
binary occupancy decision here, matching the original converter. `processingMode`
is validated for the integration contract; it does not change this service's
color objective. The browser applies the chosen sampling and cleanup mode.

Success returns `cells`, selected `paletteIds`, `device`, `algorithm`,
`durationMs`, and `meanDeltaE`. `cells` is row-major and preserves the supplied
rectangle. `meanDeltaE` is the mean CIEDE2000 error against the supplied visible
sample colors of the **actual returned assignments**, **before client cleanup or
color merging**. It excludes the chroma-guard penalty and can be slightly higher
than v1 when v2 avoids a visibly over-saturated match. An all-transparent
image returns empty palette IDs, all-null cells and zero error.

Only one computation runs at a time. Concurrent computation requests receive
HTTP 429 with `Retry-After: 1`. Malformed payloads return 422, oversized bodies
413, invalid authentication 401, and unavailable/failed CUDA 503. A disconnected
request retains the compute lock until its CUDA work finishes. Runtime CUDA
failures disable further computation until the service is restarted.

## Algorithm and limits

1. Deduplicate identical visible RGB samples on the CPU and retain exact counts.
2. Convert sRGB to D65 Lab using the same constants as `lib/beads.ts`.
3. Compute the sample-to-allowed-MARD CIEDE2000 distance matrix on CUDA in float64.
4. Add a continuous chroma-overshoot guard on CUDA. With source Lab chroma `Cs`,
   candidate chroma `Cb`, and `e = max(Cb - Cs - 8, 0)`, the matching cost is:
   `CIEDE2000 + 0.2 * exp(-(Cs / 20)^2) * e^2 / (e + 4)`.
   Small chroma differences incur no penalty. The source-chroma weight decays
   continuously, and the excess term has zero slope at its onset. There is no
   hard source-saturation threshold. The standard CIEDE2000 kernel is unchanged.
5. Choose the first color minimizing total matching cost; repeatedly add the color
   with the greatest reduction in weighted total cost. Candidate scoring and
   reduction run on CUDA.
6. Also evaluate a frequency/distance palette heuristic
   as a baseline candidate. Both candidates assign the **original sample colors**
   directly to their final palettes. Keep the candidate with lower guarded cost.
7. Attempt at most two improving palette swaps using up to 24 promising unselected
   candidates per round. Swap scoring runs on CUDA. Finish with nearest-color
   assignment under the same guarded cost and map unique samples back to cells.
   Palette selection, swaps, and final assignment all use that same objective.

This minimizes the guarded mean matching cost approximately, not globally. The
baseline comparison uses the same objective; v2 does not promise a lower raw
CIEDE2000 mean than v1 or the browser algorithm. This does not establish
universally better visual quality, protect all facial
features, or guarantee lower error after spatial cleanup. CUDA accelerates the
search; it does not itself create image detail.

At 192 × 192 and 291 allowed colors, each float64 distance/cost matrix is about
82 MiB before deduplication. v2 retains both the raw-distance and guarded-cost
matrices, and temporary allocations also require memory. The service
intentionally enforces the app's existing grid limit. Input PNG decoding,
resizing, segmentation, dithering and image generation are outside this service.

The fixed palette is copied from `lib/mard-data.ts`; its recorded upstream source
is `maxcleme/beadcolors`, commit
`29229889daab404fb30531d4bb785fd73f7f58e3`, under the MIT license.

### Version history

- `mard-optimized-v1`: pure CIEDE2000 palette search and assignment.
- `mard-optimized-v2`: preserves muted source colors with the continuous chroma
  guard. For example, v1's metric ranks vivid D25 `[73,79,199]` ahead of muted M3
  `[105,125,128]` for source `[74,97,110]`; v2 chooses M3. Saved v1 patterns keep
  their existing cells and version metadata. Only new conversions use v2 after
  the service is restarted.

## Verification

From the repository root after installing dependencies:

```powershell
& services/gpu/.venv/Scripts/python.exe -m unittest discover -s services/gpu/tests -v
```

CUDA tests run on the actual GPU and fail if CUDA is unavailable. They check all
34 CIEDE2000 reference pairs, symmetry, 256 deterministic random Lab pairs against
the application's `color-diff` package, transparency/non-square grids, restricted
palettes, a muted blue-gray regression, exact white/skin/red/blue palette matches,
guard continuity, and synthetic guarded cost against the unchanged browser
algorithm. Standard color error is also reported and checked against the actual
returned assignments. Those comparisons use no postprocessing and do not predict improvement on every
real image. Protocol tests separately use explicit test doubles to exercise
authentication, validation, body limits, busy responses and failed CUDA states.
The cross-language tests require the repository's Node dependencies to be installed.
