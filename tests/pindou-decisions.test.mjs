import { describe, expect, it } from "vitest";
import { MODEL, usageSummary, validateDecision } from "../scripts/judge-pindou.mjs";

function response() {
  return {
    model: `${MODEL}-20261014`,
    answers: {
      natural_fidelity: {
        type: "choice", choice: "unknown", confidence: 0,
        probabilities: { A: 0.25, B: 0.25, tie: 0.25, unknown: 0.25 },
      },
      critical_features: {
        type: "choice", choice: "both", confidence: 1,
        probabilities: { A_only: 0, B_only: 0, both: 1, neither: 0, unknown: 0 },
      },
      A_acceptable: { type: "noul", noul: 0 },
      B_acceptable: { type: "noul", noul: 0.5 },
    },
    usage: { input_tokens: 200, output_tokens: 10, cost: 0.0001 },
  };
}

describe("optional Jev comparison protocol", () => {
  it("preserves uncertainty and numeric Noul values without boolean conversion", () => {
    const result = validateDecision(response());
    expect(result.answers.natural_fidelity.choice).toBe("unknown");
    expect(result.answers.A_acceptable.noul).toBe(0);
    expect(result.answers.B_acceptable.noul).toBe(0.5);
  });

  it("rejects malformed probabilities and nonnumeric Noul", () => {
    const invalid = response();
    invalid.answers.natural_fidelity.probabilities.A = 1;
    expect(() => validateDecision(invalid)).toThrow();
    invalid.answers.natural_fidelity.probabilities.A = 0.25;
    invalid.answers.A_acceptable.noul = true;
    expect(() => validateDecision(invalid)).toThrow();
  });

  it("keeps known usage independently of invalid answer data", () => {
    const invalid = response();
    delete invalid.answers;
    expect(() => validateDecision(invalid)).toThrow();
    expect(usageSummary(invalid.usage)).toEqual({ input_tokens: 200, output_tokens: 10, cost: 0.0001 });
    expect(usageSummary({ input_tokens: 1, output_tokens: 0, cost: -1 })).toBeNull();
  });
});
