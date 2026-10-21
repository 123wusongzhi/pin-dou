import assert from "node:assert/strict";
import test from "node:test";
import { resolveGroup, validateCandidateDecision } from "../scripts/judge-pindou-candidates.mjs";

const group = { id: "g", baselineId: "original", algorithmSelectedId: "candidate-1", candidateIds: ["original", "candidate-1", "candidate-2"] };
const call = (candidate, margin) => ({ group: "g", status: "completed", selectedCandidate: candidate, probabilityMargin: margin });

test("stable aliases map to an adopted actual candidate; order conflict and failed controls retain baseline", () => {
  assert.equal(resolveGroup(group, [call("candidate-2", 0.3), call("candidate-2", 0.4)], true).adoptedCandidateId, "candidate-2");
  assert.equal(resolveGroup(group, [call("candidate-2", 0.3), call("candidate-1", 0.4)], true).fallbackReason, "order-inconsistent");
  assert.equal(resolveGroup(group, [call("candidate-2", 0.3), call("candidate-2", 0.4)], false).adoptedCandidateId, "original");
  assert.equal(resolveGroup(group, [call("tie", 0.3), call("candidate-2", 0.4)], true).adoptedCandidateId, "original");
});

test("tie probability is included in the margin and an ambiguous unique choice cannot be adopted", () => {
  const raw = { model: "typesafe/jev-1.14-20261014", usage: { input_tokens: 1, output_tokens: 1, cost: 0 }, answers: {
    natural_fidelity: { type: "choice", choice: "A", confidence: 0.2, probabilities: { A: 0.42, B: 0.08, C: 0.07, tie: 0.41, unknown: 0.02 } },
    A_features: { type: "noul", noul: 0 }, B_features: { type: "noul", noul: 0.3 }, C_features: { type: "noul", noul: 0.4 },
  } };
  const validated = validateCandidateDecision(raw, ["A", "B", "C"]);
  assert.ok(Math.abs(validated.probabilityMargin - 0.01) < 1e-9);
  assert.equal(resolveGroup(group, [call("candidate-1", validated.probabilityMargin), call("candidate-1", 0.4)], true).fallbackReason, "margin-below-0.10");
  raw.answers.A_features.noul = true;
  assert.throws(() => validateCandidateDecision(raw, ["A", "B", "C"]), /feature probability/);
  raw.answers.A_features.noul = 0.2;
  raw.answers.natural_fidelity.choice = "B";
  assert.throws(() => validateCandidateDecision(raw, ["A", "B", "C"]), /contradicts/);
});
