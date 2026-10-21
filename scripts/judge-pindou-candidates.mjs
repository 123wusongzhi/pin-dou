import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MODEL, usageSummary } from "./judge-pindou.mjs";

const endpoint = "https://openrouter.ai/api/alpha/decisions";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const probability = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export function candidateQuestions(labels, features, localOnly = false) {
  return {
    natural_fidelity: {
      type: "choice",
      instructions: localOnly
        ? `Decide ONLY which recoloring of the specified local region best preserves ${features} in Reference. The enlarged lower image shows this region; the full picture above supplies context. Outside the allowed region, all candidate cells are identical. Each candidate uses the same 65x65 grid and fixed 35-color bead palette. Compare the local color relationships, identifiable contours and expression; do not reward invented lines, excess darkness, oversaturation or fragmented noise. A subtle change need not be an improvement. Choose tie if the best local renderings cannot be reliably distinguished.`
        : `All candidates have the SAME grid dimensions, color limit, source framing, and bead palette. Compare them against Reference, including ${features}. Choose the best overall preservation of identity, expression, color relationships and coherent shapes. Weigh local improvements against damage elsewhere. A subtle color change is not necessarily an improvement. Do not invent a preference when the best candidates are indistinguishable.`,
      criteria: {
        ...Object.fromEntries(labels.map(label => [label, `${label} is the uniquely better ${localOnly ? "local-region" : "overall"} match to Reference.`])),
        tie: "Two or more best candidates are equivalent or too close to identify a unique winner.",
        unknown: "The visible evidence is insufficient for a reliable comparison.",
      },
    },
    ...Object.fromEntries(labels.map(label => [`${label}_features`, {
      type: "noul",
      instructions: `Candidate ${label} sufficiently preserves these identifying features visible in Reference: ${features}. Judge the depiction itself, not how confident you are about its rank.`,
      criteria: {
        true: "These important reference features remain sufficiently recognizable and correctly colored.",
        false: "Important reference features are lost, incorrectly colored or materially distorted.",
      },
    }])),
  };
}

export function validateCandidateDecision(value, labels) {
  const answer = value?.answers?.natural_fidelity;
  const choices = [...labels, "tie", "unknown"];
  if (typeof value?.model !== "string" || !value.model.startsWith(MODEL)
    || answer?.type !== "choice" || !choices.includes(answer.choice)
    || !probability(answer.confidence)
    || choices.some(label => !probability(answer.probabilities?.[label]))
    || Math.abs(choices.reduce((sum, label) => sum + answer.probabilities[label], 0) - 1) > 0.02)
    throw new Error("Invalid candidate decision.");
  const winningProbability = answer.probabilities[answer.choice];
  const second = Math.max(...choices.filter(label => label !== answer.choice).map(label => answer.probabilities[label]));
  if (winningProbability + 1e-9 < second) throw new Error("Choice contradicts its probabilities.");
  for (const label of labels)
    if (value.answers[`${label}_features`]?.type !== "noul" || !probability(value.answers[`${label}_features`].noul))
      throw new Error("Invalid feature probability.");
  if (!usageSummary(value.usage)) throw new Error("Missing usage.");
  return {
    decisionId: value.id, model: value.model, provider: value.provider, answers: value.answers,
    usage: usageSummary(value.usage), probabilityMargin: winningProbability - second,
  };
}

export function resolveGroup(group, calls, controlsPassed) {
  const relevant = calls.filter(call => call.group === group.id);
  let reason = null;
  if (!controlsPassed) reason = "control-failed-or-missing";
  else if (relevant.length !== 2 || relevant.some(call => call.status !== "completed")) reason = "incomplete-or-invalid-comparison";
  else if (relevant.some(call => !group.candidateIds.includes(call.selectedCandidate))) reason = "tie-or-unknown";
  else if (relevant[0].selectedCandidate !== relevant[1].selectedCandidate) reason = "order-inconsistent";
  else if (relevant.some(call => call.probabilityMargin < 0.1 - 1e-9)) reason = "margin-below-0.10";
  return {
    group: group.id, baselineId: group.baselineId, algorithmSelectedId: group.algorithmSelectedId,
    jevSelectedId: reason ? null : relevant[0].selectedCandidate,
    adoptedCandidateId: reason ? group.baselineId : relevant[0].selectedCandidate,
    fallbackReason: reason,
  };
}

async function png(file) {
  const bytes = await readFile(file);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error("Previews must be PNG.");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (Math.min(width, height) < 256 || Math.max(width, height) > 1568
    || width * height < 78400 || bytes.length > 16 * 1024 * 1024)
    throw new Error("Preview exceeds image limits.");
  return {
    image: { type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } },
    sha256: sha(bytes), width, height,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  if (!arg("--job") || !arg("--out")) throw new Error("Usage: --job job.json --out result.json [--live]");
  const jobBytes = await readFile(arg("--job"));
  const job = JSON.parse(jobBytes);
  const localOnly = job.protocolVersion === "local35-v1";
  const groupCount = localOnly ? 4 : 2;
  if (!Array.isArray(job.calls) || job.calls.length !== groupCount * 2 + 2 || job.groups?.length !== groupCount
    || job.stopAfterCostUsd !== 0.01) throw new Error("Unexpected bounded experiment size or response-cost stop.");
  const selectionBytes = await readFile(job.algorithmSelectionFile);
  if (sha(selectionBytes) !== job.algorithmSelectionSha256) throw new Error("Frozen algorithm selection changed.");
  const frozen = JSON.parse(selectionBytes);
  for (const group of job.groups) {
    const selected = frozen.groups.find(item => (item.id || item.sourceId) === group.id);
    const calls = job.calls.filter(call => call.group === group.id);
    if (!selected || selected.winner !== group.algorithmSelectedId
      || JSON.stringify(selected.candidateIds) !== JSON.stringify(group.candidateIds)
      || calls.length !== 2 || calls.some(call => call.candidates.length !== 3))
      throw new Error("Job differs from frozen candidate selection.");
    const first = calls[0].candidates.map(item => item.id);
    const second = calls[1].candidates.map(item => item.id);
    if (JSON.stringify([...first].sort()) !== JSON.stringify([...group.candidateIds].sort())
      || JSON.stringify(second) !== JSON.stringify([first[2], first[0], first[1]]))
      throw new Error("Candidate orders are not the preregistered cyclic permutation.");
  }
  const requests = [];
  for (const call of job.calls) {
    if (!call.id || !call.features || ![2, 3].includes(call.candidates?.length)) throw new Error("Invalid call.");
    const reference = await png(call.reference);
    const labels = call.candidates.map((_, index) => String.fromCharCode(65 + index));
    const mapping = {}, hashes = { reference: reference.sha256 };
    const state = [
      localOnly
        ? "Each image board shows the full picture at top and ONE fixed enlarged region below. Reference uses the original image. You are selecting a recoloring ONLY inside that region. Outside the allowed local mask, candidates are identical. All candidates use the same 65x65 grid and fixed 35-color bead palette. Crops, aspect ratio and enlargement are identical. Algorithm identities and scores are hidden. Perfectly identical candidates must tie; do not guess a unique winner."
        : "Each image board shows the full picture at top and two fixed enlarged regions below. Reference uses the original image. Candidates use the same discrete grid, color budget and zoom regions. All pixels and crops are aligned identically. Algorithm identities and scores are hidden. Judge only visible differences. Perfectly identical candidates must tie; do not guess a unique winner.",
      "Reference:", reference.image,
    ];
    for (const [index, candidate] of call.candidates.entries()) {
      const preview = await png(candidate.path);
      if (preview.width !== reference.width || preview.height !== reference.height) throw new Error("Preview geometry differs.");
      mapping[labels[index]] = candidate.id;
      hashes[labels[index]] = preview.sha256;
      state.push(`Candidate ${labels[index]}:`, preview.image);
    }
    if (call.control === "identical" && hashes.A !== hashes.B) throw new Error("Identical control is not identical.");
    const questions = candidateQuestions(labels, call.features, localOnly);
    const body = { model: MODEL, provider: { only: ["typesafe"], allow_fallbacks: false }, state, questions };
    if (Buffer.byteLength(JSON.stringify(body)) > 32 * 1024 * 1024) throw new Error("Request too large.");
    requests.push({
      id: call.id, group: call.group, order: call.order, control: call.control,
      expected: call.expected, labels, mapping, hashes,
      questionsSha256: sha(JSON.stringify(questions)), body,
    });
  }
  const publicRequests = requests.map(({ body, ...request }) => ({ ...request, requestBytes: Buffer.byteLength(JSON.stringify(body)) }));
  if (!args.includes("--live")) {
    console.log(JSON.stringify({ mode: "dry-run", model: MODEL, requests: publicRequests }, null, 2));
    return;
  }
  const key = (process.env.OPENROUTER_API_KEY || process.env.openrouter || process.env.OPENROUTER || "").trim();
  if (!key) throw new Error("OpenRouter key missing.");
  const report = {
    model: MODEL, protocolVersion: localOnly ? "local35-v1" : "global-candidates-v1",
    createdAt: new Date().toISOString(), jobSha256: sha(jobBytes),
    algorithmSelectionSha256: sha(selectionBytes), plannedCalls: publicRequests,
    stopAfterCostUsd: job.stopAfterCostUsd,
    costLimitNote: "Stop further calls after reported cost reaches threshold; an in-flight call can exceed it.",
    totalKnownCostUsd: 0, billingIncomplete: false, calls: [],
  };
  const output = resolve(arg("--out"));
  await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" });
  for (const request of requests) {
    if (report.totalKnownCostUsd >= job.stopAfterCostUsd) {
      report.stoppedForCost = true;
      break;
    }
    const { body, ...metadata } = request;
    const call = { ...metadata, status: "started" };
    report.calls.push(call);
    await writeFile(output, JSON.stringify(report, null, 2));
    const started = performance.now();
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
      });
      call.httpStatus = response.status;
      if (!response.ok) throw new Error(`Decision API returned HTTP ${response.status}.`);
      const raw = await response.json();
      const usage = usageSummary(raw.usage);
      if (usage) { call.usage = usage; report.totalKnownCostUsd += usage.cost; }
      Object.assign(call, validateCandidateDecision(raw, request.labels), { status: "completed" });
      const choice = call.answers.natural_fidelity.choice;
      call.selectedCandidate = request.mapping[choice] || choice;
      if (request.control) call.controlPassed = call.selectedCandidate === request.expected;
    }
    catch (error) {
      call.status = "failed";
      // Never log provider bodies, request data, or credentials.
      call.error = error instanceof Error ? error.message : "Decision request failed.";
      if (!call.usage) report.billingIncomplete = true;
      process.exitCode = 1;
    }
    call.durationMs = Math.round(performance.now() - started);
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ id: call.id, status: call.status, selected: call.selectedCandidate,
      margin: call.probabilityMargin, cost: call.usage?.cost, durationMs: call.durationMs }));
    if (call.status === "failed") break;
  }
  const controls = report.calls.filter(call => call.control);
  report.controlsPassed = controls.length === 2 && controls.every(call => call.controlPassed);
  report.groups = job.groups.map(group => resolveGroup(group, report.calls, report.controlsPassed));
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
