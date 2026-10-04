import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Clock3, FilePlus2, Play, Plus, ShieldCheck, Target, Trash2, X } from "lucide-react";
import { useTradingStore } from "../store";
import { DEFAULT_CHECKLIST, type ChecklistAnswer, type ChecklistQuestion, type CheckMode, type Direction, type ExchangeId, type OrderType, type TradingPlan } from "../types";

export function PlanManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { boot, exchange, symbol, market, savePlan, armPlan, triggerPlan } = useTradingStore();
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<TradingPlan | null>(null);
  const [now, setNow] = useState(Date.now());
  const [newQuestion, setNewQuestion] = useState("");
  const [newExpected, setNewExpected] = useState(true);
  const [newCritical, setNewCritical] = useState(true);
  const plans = boot?.plans ?? [];
  const selected = plans.find((item) => item.id === selectedId);

  useEffect(() => {
    if (!open) return;
    if (selected) setDraft(normalizePlan(selected));
    else if (!selectedId && plans.length) setSelectedId((plans.find((item) => item.exchange === exchange && item.symbol === symbol) ?? plans[0]).id);
    else if (!draft) setDraft(createPlanDraft(exchange, symbol, market?.ticker.last ?? "0"));
  }, [open, selectedId, selected?.updatedAt, plans.length, exchange, symbol]);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  const questions = useMemo(() => draft ? planQuestions(draft) : DEFAULT_CHECKLIST, [draft]);
  const passed = useMemo(() => draft ? questions.filter((question) => draft.answers.find((answer) => answer.questionId === question.id)?.value === question.expected).length : 0, [draft, questions]);
  if (!open || !draft) return null;

  const updateAnswer = (questionId: string, value: boolean) => {
    const answer: ChecklistAnswer = { questionId, value };
    setDraft({ ...draft, answers: [...draft.answers.filter((item) => item.questionId !== questionId), answer] });
  };
  const save = async () => {
    const saved = await savePlan(draft);
    setDraft(normalizePlan(saved)); setSelectedId(saved.id);
  };
  const addQuestion = () => {
    const prompt = newQuestion.trim();
    if (!prompt) return;
    const question: ChecklistQuestion = { id: `custom-${crypto.randomUUID()}`, prompt, expected: newExpected, critical: newCritical };
    setDraft({ ...draft, customQuestions: [...draft.customQuestions, question], answers: [...draft.answers, { questionId: question.id, value: null }] });
    setNewQuestion(""); setNewExpected(true); setNewCritical(true);
  };
  const removeQuestion = (id: string) => setDraft({ ...draft, customQuestions: draft.customQuestions.filter((item) => item.id !== id), answers: draft.answers.filter((item) => item.questionId !== id) });

  return <div className="full-overlay plan-overlay">
    <header className="overlay-header"><div><small>计划先于交易</small><h1>交易计划与纪律清单</h1></div><button className="icon-btn" aria-label="关闭" onClick={onClose}><X /></button></header>
    <div className="plan-layout">
      <aside className="plan-list-pane">
        <div className="pane-heading"><strong>计划</strong><button className="compact primary" onClick={() => { setSelectedId(""); setDraft(createPlanDraft(exchange, symbol, market?.ticker.last ?? "0")); }}><FilePlus2 size={14} /> 新建</button></div>
        <div className="plan-filter"><button className="active">全部 {plans.length}</button><button>待触发</button><button>执行中</button></div>
        {plans.length === 0 && <div className="empty-plan"><ShieldCheck /><p>创建第一份计划，开仓按钮才有解锁条件。</p></div>}
        {plans.map((plan) => <button key={plan.id} className={`plan-list-item ${plan.id === selectedId ? "active" : ""}`} onClick={() => setSelectedId(plan.id)}><span><b>{plan.name}</b><small>{plan.symbol} · {directionLabel(plan.direction)}</small></span><em className={plan.status}>{planStatus(plan, now)}</em><ChevronRight size={14} /></button>)}
      </aside>

      <main className="plan-editor-pane">
        <div className="editor-heading"><div><input className="title-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><p>只有计划触发并经过冷静期后，关联订单才允许开仓。</p></div><div className="heading-actions"><button onClick={() => void save()}>保存计划</button>{draft.id && draft.status === "draft" && <button className="primary" onClick={() => void armPlan(draft.id)}>启用计划</button>}{draft.id && draft.status === "armed" && <button className="primary" onClick={() => void triggerPlan(draft.id)}><Play size={13} /> 模拟触发</button>}</div></div>
        <div className="form-grid">
          <FormSelect label="交易所" value={draft.exchange} options={[{ value: "mexc", label: "MEXC" }, { value: "ourbit", label: "Ourbit" }]} onChange={(value) => setDraft({ ...draft, exchange: value as TradingPlan["exchange"] })} />
          <FormInput label="合约" value={draft.symbol} onChange={(value) => setDraft({ ...draft, symbol: value.toUpperCase() })} />
          <FormSelect label="方向" value={draft.direction} options={[{ value: "long", label: "做多" }, { value: "short", label: "做空" }]} onChange={(value) => setDraft({ ...draft, direction: value as TradingPlan["direction"] })} />
          <FormSelect label="检查模式" value={draft.checkMode} options={[{ value: "block", label: "强制检查" }, { value: "warn", label: "仅警告" }, { value: "off", label: "关闭检查" }]} onChange={(value) => setDraft({ ...draft, checkMode: value as CheckMode })} />
          <FormInput wide label="触发条件" value={draft.triggerCondition} onChange={(value) => setDraft({ ...draft, triggerCondition: value })} />
          <FormText wide label="下单原因（必填）" value={draft.entryReason} placeholder="为什么现在值得开仓？写出行情结构、关键位置和确认信号。" onChange={(value) => setDraft({ ...draft, entryReason: value })} />
          <FormText wide label="止盈原因（必填）" value={draft.takeProfitReason} placeholder="为什么在目标位止盈？写出阻力、流动性或盈亏比依据。" onChange={(value) => setDraft({ ...draft, takeProfitReason: value })} />
          <FormInput label="计划价格" value={draft.plannedPrice} onChange={(value) => setDraft({ ...draft, plannedPrice: value })} />
          <FormInput label="冷静期（分钟）" type="number" value={String(draft.cooldownMinutes)} onChange={(value) => setDraft({ ...draft, cooldownMinutes: Math.max(1, Number(value) || 1) })} />
          <FormInput label="止损价格" value={draft.stopLoss} onChange={(value) => setDraft({ ...draft, stopLoss: value })} />
          <FormInput label="目标位（逗号分隔）" value={draft.targets.join(", ")} onChange={(value) => setDraft({ ...draft, targets: value.split(",").map((item) => item.trim()).filter(Boolean) })} />
          <div className="form-control wide"><label>允许订单类型</label><div className="choice-chips">{(["limit", "market", "post_only", "ioc", "fok"] as OrderType[]).map((type) => <button key={type} className={draft.allowedOrderTypes.includes(type) ? "active" : ""} onClick={() => setDraft({ ...draft, allowedOrderTypes: toggleItem(draft.allowedOrderTypes, type) })}>{orderLabel(type)}</button>)}</div></div>
        </div>
        <div className="checklist-heading"><div><ShieldCheck size={16} /><strong>下单前纪律问题</strong></div><span>{passed} / {questions.length} 已通过 · {draft.checkMode === "block" ? "强制模式" : draft.checkMode === "warn" ? "警告模式" : "已关闭"}</span></div>
        <div className="question-builder"><input value={newQuestion} placeholder="添加新的纪律问题，例如：是否等待 K 线收盘确认？" onChange={(event) => setNewQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addQuestion(); }} /><label><input type="checkbox" checked={newExpected} onChange={(event) => setNewExpected(event.target.checked)} /> 正确答案为“是”</label><label><input type="checkbox" checked={newCritical} onChange={(event) => setNewCritical(event.target.checked)} /> 关键项</label><button className="primary" onClick={addQuestion} disabled={!newQuestion.trim()}><Plus size={13} /> 添加问题</button></div>
        <div className="question-list">{questions.map((question, index) => {
          const answer = draft.answers.find((item) => item.questionId === question.id)?.value;
          const passedQuestion = answer === question.expected;
          const custom = draft.customQuestions.some((item) => item.id === question.id);
          return <div className="question-row" key={question.id}><span className={`question-index ${passedQuestion ? "done" : ""}`}>{passedQuestion ? <Check size={11} /> : index + 1}</span><span><b>{question.prompt}</b><small>{question.critical ? "关键项" : "普通项"} · 期望回答“{question.expected ? "是" : "否"}”</small></span><div className="yes-no"><button className={answer === true ? "yes" : ""} onClick={() => updateAnswer(question.id, true)}>是</button><button className={answer === false ? "no" : ""} onClick={() => updateAnswer(question.id, false)}>否</button>{custom && <button className="delete-question" title="删除自定义问题" onClick={() => removeQuestion(question.id)}><Trash2 size={13} /></button>}</div></div>;
        })}</div>
      </main>

      <aside className="risk-preview-pane">
        <div className="pane-heading"><strong>风险预览</strong><Target size={15} /></div>
        <RiskVisual plan={draft} />
        <RiskLine label="当前状态" value={planStatus(draft, now)} tone={draft.status === "triggered" ? "positive" : ""} />
        {draft.status === "triggered" && draft.earliestEntryAt && <div className={`cooldown-card ${now >= draft.earliestEntryAt ? "ready" : ""}`}><Clock3 /><span><small>{now >= draft.earliestEntryAt ? "冷静期已结束" : "冷静期倒计时"}</small><b>{now >= draft.earliestEntryAt ? "可以进入订单复核" : formatCountdown(draft.earliestEntryAt - now)}</b></span></div>}
        <RiskLine label="计划价格" value={`${draft.plannedPrice || "—"} USDT`} />
        <RiskLine label="止损幅度" value={percentDistance(draft.plannedPrice, draft.stopLoss)} />
        <RiskLine label="首个目标盈亏比" value={rr(draft.plannedPrice, draft.stopLoss, draft.targets[0])} />
        <RiskLine label="全局最高杠杆" value={boot?.riskSettings ? (boot.riskSettings.enforceGlobalLimits ? `${boot.riskSettings.maxLeverage}x` : "不设限") : "—"} />
        <RiskLine label="单笔风险上限" value={boot?.riskSettings ? (boot.riskSettings.enforceGlobalLimits ? `${boot.riskSettings.maxRiskPercent}%` : "不设限") : "—"} />
        <div className="gate-steps"><strong>开仓门槛</strong><Gate done={Boolean(draft.id)} label="计划已保存" /><Gate done={draft.status !== "draft"} label="计划已启用" /><Gate done={draft.status === "triggered"} label="触发条件已命中" /><Gate done={Boolean(draft.earliestEntryAt && now >= draft.earliestEntryAt)} label={draft.earliestEntryAt && now < draft.earliestEntryAt ? `冷静期剩余 ${formatCountdown(draft.earliestEntryAt - now)}` : `冷静期 ${draft.cooldownMinutes} 分钟`} /><Gate done={passed === questions.length || draft.checkMode === "off"} label="纪律问题满足模式要求" /></div>
      </aside>
    </div>
  </div>;
}

export function createPlanDraft(exchange: ExchangeId, symbol: string, price: string, direction: Direction = "long", stopLoss = "", takeProfit = ""): TradingPlan {
  return { id: "", name: `${symbol.replace("_", "/")} ${direction === "long" ? "做多" : "做空"}计划`, exchange, symbol, direction, triggerCondition: "价格到达计划位置并确认当前趋势", entryReason: "", takeProfitReason: "", plannedPrice: price, stopLoss, targets: takeProfit ? [takeProfit] : [], allowedOrderTypes: ["limit", "market", "post_only"], checkMode: "block", customQuestions: [], answers: DEFAULT_CHECKLIST.map((item) => ({ questionId: item.id, value: null })), status: "draft", cooldownMinutes: 15, createdAt: 0, updatedAt: 0 };
}

export function normalizePlan(plan: TradingPlan): TradingPlan { return { ...plan, entryReason: plan.entryReason ?? "", takeProfitReason: plan.takeProfitReason ?? "", customQuestions: plan.customQuestions ?? [], answers: plan.answers ?? [] }; }
export function planQuestions(plan: TradingPlan): ChecklistQuestion[] { return [...DEFAULT_CHECKLIST, ...(plan.customQuestions ?? [])]; }
function FormInput({ label, value, onChange, wide = false, type = "text" }: { label: string; value: string; onChange: (value: string) => void; wide?: boolean; type?: string }) { return <label className={`form-control ${wide ? "wide" : ""}`}><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function FormText({ label, value, placeholder, onChange, wide = false }: { label: string; value: string; placeholder: string; onChange: (value: string) => void; wide?: boolean }) { return <label className={`form-control ${wide ? "wide" : ""}`}><span>{label}</span><textarea value={value} placeholder={placeholder} rows={2} onChange={(event) => onChange(event.target.value)} /></label>; }
function FormSelect({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) { return <label className="form-control"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>; }
function RiskLine({ label, value, tone = "" }: { label: string; value: string; tone?: string }) { return <div className="risk-preview-line"><span>{label}</span><b className={tone}>{value}</b></div>; }
function Gate({ done, label }: { done: boolean; label: string }) { return <div className={`gate-step ${done ? "done" : ""}`}><span>{done ? <Check size={11} /> : <Clock3 size={11} />}</span>{label}</div>; }
function RiskVisual({ plan }: { plan: TradingPlan }) { return <div className="risk-visual"><div className="profit-zone"><span>目标 {plan.targets[0] || "—"}</span></div><div className="entry-line"><span>计划 {plan.plannedPrice || "—"}</span></div><div className="loss-zone"><span>止损 {plan.stopLoss || "—"}</span></div></div>; }
function toggleItem<T>(items: T[], value: T): T[] { return items.includes(value) ? items.filter((item) => item !== value) : [...items, value]; }
function planStatus(plan: TradingPlan, now: number): string { if (plan.status === "triggered" && plan.earliestEntryAt && now >= plan.earliestEntryAt) return "可执行"; return ({ draft: "草稿", armed: "等待触发", triggered: "冷静期", expired: "已过期", completed: "已完成" } as Record<string, string>)[plan.status]; }
function directionLabel(direction: TradingPlan["direction"]): string { return direction === "long" ? "做多" : "做空"; }
function orderLabel(type: OrderType): string { return ({ market: "市价", limit: "限价", post_only: "Post Only", ioc: "IOC", fok: "FOK", trigger: "条件单", trailing: "移动止损" } as Record<OrderType, string>)[type]; }
function percentDistance(entry: string, stop: string): string { const a = Number(entry); const b = Number(stop); return a && b ? `${(Math.abs(a - b) / a * 100).toFixed(2)}%` : "—"; }
function rr(entry: string, stop: string, target?: string): string { const a = Number(entry); const b = Number(stop); const c = Number(target); return a && b && c && a !== b ? (Math.abs(c - a) / Math.abs(a - b)).toFixed(2) : "—"; }
export function formatCountdown(milliseconds: number): string { const seconds = Math.max(0, Math.ceil(milliseconds / 1000)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60); const body = `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; return hours ? `${String(hours).padStart(2, "0")}:${body}` : body; }
