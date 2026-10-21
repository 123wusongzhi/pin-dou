import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MODEL = "typesafe/jev-1.14";
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const preference = ["A", "B", "tie", "unknown"];
const preservation = ["A_only", "B_only", "both", "neither", "unknown"];

export function usageSummary(value) {
  if (!value || ["input_tokens", "output_tokens", "cost"].some(name =>
    typeof value[name] !== "number" || !Number.isFinite(value[name]) || value[name] < 0))
    return null;
  return { input_tokens: value.input_tokens, output_tokens: value.output_tokens, cost: value.cost };
}

export function decisionQuestions(features) {
  return {
    natural_fidelity: {
      type: "choice",
      instructions: "Compared with Reference, which candidate better preserves identity, pose, silhouette, facial expression, and natural color relationships? Omitted texture is acceptable; lost identity, excessive darkening, invented details and fragmented noise are defects. Do not prefer blur simply because it hides pixel edges.",
      criteria: {
        A: "A preserves the reference better overall.",
        B: "B preserves the reference better overall.",
        tie: "Similar fidelity with no clear overall preference.",
        unknown: "Insufficient visible evidence to judge reliably.",
      },
    },
    critical_features: {
      type: "choice",
      instructions: `Inspect these visible identifying features: ${features}. Do not require anything absent from Reference. Decide whether these features survive sufficiently in each candidate. Choose unknown if they are too small to assess.`,
      criteria: {
        A_only: "Only A preserves the important features sufficiently.",
        B_only: "Only B preserves the important features sufficiently.",
        both: "Both preserve the important features sufficiently.",
        neither: "Both materially lose or change important features.",
        unknown: "The important features cannot be assessed reliably.",
      },
    },
    ...Object.fromEntries(["A", "B"].map(label => [`${label}_acceptable`, {
      type: "noul",
      instructions: `Candidate ${label} is an acceptable simplified bead depiction of Reference: identity, pose, outline and facial expression remain recognizable, without materially lost or invented identifying features.`,
      criteria: {
        true: "The important visible content is preserved sufficiently.",
        false: "Important content is lost, changed or too muddy to recognize.",
      },
    }])),
  };
}

export function validateDecision(value) {
  const probability = number => typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1;
  if (!value || !value.answers || typeof value.model !== "string" || !value.model.startsWith(MODEL))
    throw new Error("Unexpected model or missing decisions.");
  for (const [name, choices] of [["natural_fidelity", preference], ["critical_features", preservation]]) {
    const answer = value.answers[name];
    if (answer?.type !== "choice" || !choices.includes(answer.choice) || !probability(answer.confidence)
      || choices.some(choice => !probability(answer.probabilities?.[choice]))
      || Math.abs(choices.reduce((sum, choice) => sum + answer.probabilities[choice], 0) - 1) > 0.02)
      throw new Error(`Invalid ${name} decision.`);
  }
  for (const name of ["A_acceptable", "B_acceptable"]) {
    if (value.answers[name]?.type !== "noul" || !probability(value.answers[name].noul))
      throw new Error(`Invalid ${name} probability.`);
  }
  const usage = usageSummary(value.usage);
  if (!usage)
    throw new Error("Missing or invalid usage.");
  return {
    id: value.id, model: value.model, provider: value.provider,
    answers: value.answers, usage,
  };
}

async function png(file) {
  const bytes = await readFile(file);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error("Decision previews must be PNG.");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (Math.min(width, height) < 256 || Math.max(width, height) > 1568
    || width * height < 78400 || bytes.length > 16 * 1024 * 1024)
    throw new Error("Decision preview exceeds Jev image limits.");
  return {
    image: { type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } },
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const jobFile = args[args.indexOf("--job") + 1];
  const output = args[args.indexOf("--out") + 1];
  if (!args.includes("--job") || !args.includes("--out"))
    throw new Error("Usage: node scripts/judge-pindou.mjs --job pairs.json --out results.json [--live]");
  const job = JSON.parse(await readFile(jobFile, "utf8"));
  const stopAfterCostUsd = job.stopAfterCostUsd ?? 0.01;
  if (typeof stopAfterCostUsd !== "number" || !Number.isFinite(stopAfterCostUsd)
    || stopAfterCostUsd <= 0 || stopAfterCostUsd > 0.01)
    throw new Error("The response-cost stop threshold must be between 0 and $0.01.");
  if (!Array.isArray(job.pairs) || job.pairs.length < 1 || job.pairs.length > 3)
    throw new Error("One run allows at most three pairs, each evaluated in both orders.");
  const requests = [];
  for (const pair of job.pairs) {
    if (!pair.id || !pair.features || !pair.A?.id || !pair.B?.id)
      throw new Error("Each pair needs IDs, features and paths.");
    const reference = await png(pair.reference);
    const originalA = await png(pair.A.path), originalB = await png(pair.B.path);
    for (const reversed of [false, true]) {
      const A = reversed ? originalB : originalA, B = reversed ? originalA : originalB;
      const body = {
        model: MODEL,
        provider: { only: ["typesafe"], allow_fallbacks: false },
        state: [
          "Reference is the original. A and B are discrete bead patterns. Judge only visible fidelity; algorithm names and material costs are intentionally hidden. Use unknown when evidence is insufficient.",
          "Reference:", reference.image, "Candidate A:", A.image, "Candidate B:", B.image,
        ],
        questions: decisionQuestions(pair.features),
      };
      if (Buffer.byteLength(JSON.stringify(body)) > 32 * 1024 * 1024) throw new Error("Decision request too large.");
      requests.push({
        pair: pair.id, reversed, body,
        mapping: { A: reversed ? pair.B.id : pair.A.id, B: reversed ? pair.A.id : pair.B.id },
        hashes: { reference: reference.sha256, A: A.sha256, B: B.sha256 },
      });
    }
  }
  if (!args.includes("--live")) {
    console.log(JSON.stringify({ mode: "dry-run", model: MODEL, requestCount: requests.length, output: resolve(output) }));
    return;
  }
  const key = (process.env.OPENROUTER_API_KEY || process.env.openrouter || process.env.OPENROUTER || "").trim();
  if (!key) throw new Error("OpenRouter key is not configured in the process environment.");
  const report = {
    model: MODEL, createdAt: new Date().toISOString(), maximumCalls: requests.length,
    stopAfterCostUsd, costLimitNote: "Stops further calls after reported cost reaches the threshold; an in-flight call can exceed it.",
    calls: [], totalKnownCostUsd: 0, billingIncomplete: false,
  };
  // Exclusive creation prevents accidentally repeating paid calls into the same run.
  await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" });
  for (const request of requests) {
    if (report.totalKnownCostUsd >= stopAfterCostUsd) {
      report.stoppedForCost = true;
      await writeFile(output, JSON.stringify(report, null, 2));
      break;
    }
    const call = { pair: request.pair, reversed: request.reversed, mapping: request.mapping, hashes: request.hashes, status: "started" };
    report.calls.push(call);
    await writeFile(output, JSON.stringify(report, null, 2));
    const started = performance.now();
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(45_000),
      });
      call.httpStatus = response.status;
      if (!response.ok) {
        // Do not retain provider error bodies: they can reflect input images.
        throw new Error(`Decision API returned HTTP ${response.status}.`);
      }
      const raw = await response.json();
      const knownUsage = usageSummary(raw.usage);
      if (knownUsage) {
        call.usage = knownUsage;
        report.totalKnownCostUsd += knownUsage.cost;
      }
      const decision = validateDecision(raw);
      Object.assign(call, decision, { status: "completed" });
      const selected = decision.answers.natural_fidelity.choice;
      call.selectedCandidate = request.mapping[selected] || selected;
    }
    catch (error) {
      call.status = "failed";
      call.error = error instanceof Error ? error.message : "Decision request failed.";
      if (!call.usage) report.billingIncomplete = true;
      process.exitCode = 1;
    }
    call.durationMs = Math.round(performance.now() - started);
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ pair: call.pair, reversed: call.reversed, status: call.status, selected: call.selectedCandidate, durationMs: call.durationMs, cost: call.usage?.cost }));
    if (call.status === "failed") break;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
