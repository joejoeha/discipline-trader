import { describe, expect, it } from "vitest";
import { evaluateChecklist } from "./checklist";
import { DEFAULT_CHECKLIST } from "../types";

const passing = DEFAULT_CHECKLIST.map((q) => ({ questionId: q.id, value: q.expected }));

describe("discipline checklist", () => {
  it("blocks an incomplete mandatory checklist", () => {
    const result = evaluateChecklist("block", passing.slice(1));
    expect(result.passed).toBe(false);
    expect(result.unanswered).toHaveLength(1);
  });

  it("warns but permits explicit confirmation", () => {
    const result = evaluateChecklist("warn", [{ questionId: "emotion", value: false }]);
    expect(result.passed).toBe(true);
    expect(result.failed).toHaveLength(1);
  });

  it("off skips checklist only", () => {
    expect(evaluateChecklist("off", []).passed).toBe(true);
  });

  it("includes questions added to a trading plan", () => {
    const questions = [...DEFAULT_CHECKLIST, { id: "custom-patience", prompt: "是否耐心等待确认？", expected: true, critical: true }];
    const result = evaluateChecklist("block", passing, questions);
    expect(result.passed).toBe(false);
    expect(result.unanswered).toContain("是否耐心等待确认？");
  });
});
