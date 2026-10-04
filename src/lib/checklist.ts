import type { ChecklistAnswer, ChecklistQuestion, ChecklistResult, CheckMode } from "../types";
import { DEFAULT_CHECKLIST } from "../types";

export function evaluateChecklist(mode: CheckMode, answers: ChecklistAnswer[], questions: ChecklistQuestion[] = DEFAULT_CHECKLIST): ChecklistResult {
  if (mode === "off") return { passed: true, mode, failed: [], unanswered: [] };
  const byId = new Map(answers.map((answer) => [answer.questionId, answer.value]));
  const failed = questions.filter((q) => byId.get(q.id) !== null && byId.get(q.id) !== undefined && byId.get(q.id) !== q.expected).map((q) => q.prompt);
  const unanswered = questions.filter((q) => byId.get(q.id) === null || byId.get(q.id) === undefined).map((q) => q.prompt);
  const clear = failed.length === 0 && unanswered.length === 0;
  return { passed: mode === "warn" || clear, mode, failed, unanswered };
}

export function checklistSummary(result: ChecklistResult): string {
  if (result.mode === "off") return "计划已关闭纪律问题检查；全局风险护栏仍有效";
  if (result.failed.length === 0 && result.unanswered.length === 0) return "纪律检查已全部通过";
  return `${result.failed.length} 项未通过，${result.unanswered.length} 项未回答`;
}
