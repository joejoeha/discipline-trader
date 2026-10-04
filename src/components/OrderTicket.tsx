import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ChevronUp, Clock3, Info, LockKeyhole, ShieldCheck, TimerReset, X } from "lucide-react";
import { checklistSummary, evaluateChecklist } from "../lib/checklist";
import { effectiveFeeProfile } from "../lib/routing";
import { useTradingStore } from "../store";
import { createPlanDraft, formatCountdown, normalizePlan, planQuestions } from "./PlanManager";
import type { Direction, MarginMode, OrderIntent, OrderReview, OrderType, PositionMode, TradingPlan } from "../types";

export function OrderTicket({ onPlans }: { onPlans: () => void }) {
  const { market, mode, symbol, exchange, boot, draftOrderPrice, closePositionRequest, prepareOrder, submitOrder, savePlan, armPlan, triggerPlan } = useTradingStore();
  const [action, setAction] = useState<"open" | "close">("open");
  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("0.001");
  const [quantityUnit, setQuantityUnit] = useState<"base" | "usdt">("base");
  const [leverage, setLeverage] = useState(5);
  const [leverageInput, setLeverageInput] = useState("5x");
  const [marginMode, setMarginMode] = useState<MarginMode>("isolated");
  const [positionMode, setPositionMode] = useState<PositionMode>("hedge");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [planId, setPlanId] = useState("");
  const [review, setReview] = useState<OrderReview | null>(null);
  const [quickPlan, setQuickPlan] = useState<TradingPlan | null>(null);
  const [wizardPlan, setWizardPlan] = useState<TradingPlan | null>(null);
  const [wizardIndex, setWizardIndex] = useState(0);
  const [wizardComplete, setWizardComplete] = useState(false);
  const [pendingDirection, setPendingDirection] = useState<Direction>("long");
  const [now, setNow] = useState(Date.now());
  const plans = boot?.plans.filter((item) => item.symbol === symbol && item.exchange === exchange) ?? [];
  const plan = plans.find((item) => item.id === planId);
  const last = market ? Number(market.ticker.last) : 0;
  const effectivePrice = Number(price || last);
  const notional = quantityUnit === "usdt" ? Number(quantity || 0) : effectivePrice * Number(quantity || 0);
  const normalizedQuantity = quantityUnit === "usdt" && effectivePrice > 0 ? Number(quantity || 0) / effectivePrice : Number(quantity || 0);
  const feeProfile = boot && market ? effectiveFeeProfile(boot.routingSettings, exchange, market.instrument.assetClass) : undefined;
  const leverageCap = boot?.riskSettings?.enforceGlobalLimits ? boot.riskSettings.maxLeverage : market?.instrument.maxLeverage ?? 200;
  useEffect(() => { if (draftOrderPrice?.value) setPrice(draftOrderPrice.value); }, [draftOrderPrice?.nonce]);
  useEffect(() => {
    const position = closePositionRequest?.position;
    if (!position || position.exchange !== exchange || position.symbol !== symbol) return;
    setAction("close"); setOrderType("market"); setQuantity(position.quantity); setQuantityUnit("base");
    setLeverage(position.leverage); setMarginMode(position.marginMode); setReduceOnly(true); setStopLoss(""); setTakeProfit("");
  }, [closePositionRequest?.nonce, exchange, symbol]);
  useEffect(() => { setPrice(""); setStopLoss(""); setTakeProfit(""); setPlanId(""); setReview(null); setQuickPlan(null); setWizardPlan(null); }, [exchange, symbol]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => setLeverageInput(`${leverage}x`), [leverage]);
  const normalizedPlan = plan ? normalizePlan(plan) : undefined;
  const checklist = evaluateChecklist(normalizedPlan?.checkMode ?? "block", normalizedPlan?.answers ?? [], normalizedPlan ? planQuestions(normalizedPlan) : undefined);

  const choosePlan = (id: string) => {
    setPlanId(id);
    const selected = plans.find((item) => item.id === id);
    if (!selected) return;
    setPrice(selected.plannedPrice); setStopLoss(selected.stopLoss); setTakeProfit(selected.targets[0] ?? "");
  };
  const buildIntent = (direction: Direction, selectedPlan?: TradingPlan): OrderIntent => ({
    clientOrderId: `dt${crypto.randomUUID().replaceAll("-", "").slice(0, 30)}`, exchange, symbol, mode, direction, action, orderType,
    quantity: Number.isFinite(normalizedQuantity) ? normalizedQuantity.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "0",
    price: orderType === "market" ? undefined : price || market?.ticker.last, leverage, marginMode, positionMode,
    reduceOnly: action === "close" || reduceOnly, takeProfit: takeProfit || undefined, stopLoss: stopLoss || undefined,
    planId: selectedPlan?.id ?? (planId || undefined), checkMode: selectedPlan?.checkMode ?? normalizedPlan?.checkMode ?? "block"
  });
  const openReview = async (direction: Direction, selectedPlan?: TradingPlan) => setReview(await prepareOrder(buildIntent(direction, selectedPlan)));
  const startWizard = (selectedPlan: TradingPlan, direction: Direction) => {
    const normalized = normalizePlan(selectedPlan);
    const reset = { ...normalized, answers: planQuestions(normalized).map((question) => ({ questionId: question.id, value: null })) };
    setPendingDirection(direction); setWizardPlan(reset); setWizardIndex(0); setWizardComplete(false);
  };
  const submit = async (direction: Direction) => {
    if (action === "close") { await openReview(direction); return; }
    if (!normalizedPlan || normalizedPlan.direction !== direction) {
      setPendingDirection(direction);
      const draft = createPlanDraft(exchange, symbol, price || market?.ticker.last || "0", direction, stopLoss, takeProfit);
      setQuickPlan({ ...draft, allowedOrderTypes: [...new Set([...draft.allowedOrderTypes, orderType])] });
      return;
    }
    if (normalizedPlan.checkMode !== "off") { startWizard(normalizedPlan, direction); return; }
    await openReview(direction, normalizedPlan);
  };
  const createQuickPlan = async (draft: TradingPlan) => {
    const saved = await savePlan(draft);
    const armed = await armPlan(saved.id);
    const triggered = await triggerPlan(armed.id);
    setPlanId(triggered.id); setPrice(triggered.plannedPrice); setStopLoss(triggered.stopLoss); setTakeProfit(triggered.targets[0] ?? ""); setQuickPlan(null);
    if (triggered.checkMode === "off") await openReview(pendingDirection, triggered); else startWizard(triggered, pendingDirection);
  };
  const answerQuestion = async (value: boolean) => {
    if (!wizardPlan) return;
    const questions = planQuestions(wizardPlan); const question = questions[wizardIndex];
    const updated = { ...wizardPlan, answers: [...wizardPlan.answers.filter((item) => item.questionId !== question.id), { questionId: question.id, value }] };
    const saved = await savePlan(updated); setWizardPlan(normalizePlan(saved));
    if (wizardIndex < questions.length - 1) setWizardIndex(wizardIndex + 1); else setWizardComplete(true);
  };
  const finishWizard = async () => {
    if (!wizardPlan) return;
    await openReview(pendingDirection, wizardPlan); setWizardPlan(null); setWizardComplete(false);
  };

  return <aside className="order-ticket panel">
    <div className="ticket-head"><div className="ticket-tabs"><button className={action === "open" ? "active" : ""} onClick={() => setAction("open")}>开仓</button><button className={action === "close" ? "active" : ""} onClick={() => setAction("close")}>平仓</button></div><span className={`mode-pill ${mode}`}>{mode === "paper" ? "模拟" : "实盘"}</span></div>
    <div className="order-ticket-scroll">
      <div className="ticket-mode-row"><div className="segmented compact"><button className={marginMode === "isolated" ? "active" : ""} onClick={() => setMarginMode("isolated")}>逐仓</button><button className={marginMode === "cross" ? "active" : ""} onClick={() => setMarginMode("cross")}>全仓</button><button onClick={() => setPositionMode(positionMode === "hedge" ? "one_way" : "hedge")}>{positionMode === "hedge" ? "双向" : "单向"}</button></div><div className="leverage-control"><label htmlFor="leverage-input">杠杆</label><input id="leverage-input" aria-label="杠杆倍数" inputMode="numeric" value={leverageInput} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setLeverageInput(event.target.value.replace(/[^0-9xX]/g, ""))} onBlur={commitLeverage} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><div><button aria-label="增加杠杆" onClick={() => adjustLeverage(1)}><ChevronUp size={11} /></button><button aria-label="降低杠杆" onClick={() => adjustLeverage(-1)}><ChevronDown size={11} /></button></div></div></div>
      <div className="order-types">{(["limit", "market", "post_only", "trigger"] as OrderType[]).map((type) => <button key={type} className={orderType === type ? "active" : ""} onClick={() => setOrderType(type)}>{orderTypeLabel(type)}</button>)}</div>
      <div className={`order-entry-pair ${orderType === "market" ? "single" : ""}`}>{orderType !== "market" && <Field compact label="委托价格" value={price} placeholder={market?.ticker.last} suffix="USDT" onChange={setPrice} />}<QuantityField compact label="数量" value={quantity} suffix={quantityUnit === "base" ? symbol.split("_")[0] : "USDT"} baseAsset={symbol.split("_")[0]} unit={quantityUnit} onUnitChange={changeQuantityUnit} onChange={setQuantity} /></div>
      <div className="risk-fields"><Field label="止损（必填）" value={stopLoss} suffix="USDT" onChange={setStopLoss} /><Field label="止盈" value={takeProfit} suffix="USDT" onChange={setTakeProfit} /></div>
      <label className="check-line"><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} disabled={action === "close"} /> 只减仓 <Info size={12} /></label>
      <div className="plan-gate"><div className="gate-title"><span><ShieldCheck size={14} /> 交易计划</span><button onClick={onPlans}>管理计划</button></div><select aria-label="关联交易计划" value={planId} onChange={(event) => choosePlan(event.target.value)}><option value="">选择计划（开仓必选）</option>{plans.map((item) => <option key={item.id} value={item.id}>{item.name} · {statusLabel(item, now)}</option>)}</select>{normalizedPlan ? <PlanGateStatus plan={normalizedPlan} now={now} /> : <p className="muted"><LockKeyhole size={13} /> 未关联交易计划，点击开多/开空可立即创建</p>}<div className={`check-summary ${checklist.failed.length || checklist.unanswered.length ? "warning" : "passed"}`}><span>{checklist.passed && !checklist.unanswered.length ? <Check size={13} /> : <AlertTriangle size={13} />}{checklistSummary(checklist)}</span><small>{normalizedPlan?.checkMode === "warn" ? "警告模式" : normalizedPlan?.checkMode === "off" ? "检查关闭" : "强制模式"}</small></div></div>
      <div className="order-estimate"><span>名义价值 <b>{Number.isFinite(notional) ? notional.toFixed(2) : "0.00"} USDT</b></span><span>预估保证金 <b>{Number.isFinite(notional) ? (notional / leverage).toFixed(2) : "0.00"} USDT</b></span><span>可用 <b>{boot?.balances[0]?.available ?? "0.00"} USDT</b></span><span>API 费率 <b>Maker {feeProfile?.makerPercent ?? "—"}% / Taker {feeProfile?.takerPercent ?? "—"}%</b></span></div>
    </div>
    <div className="order-submit-dock"><div className="trade-buttons"><button className="buy" onClick={() => void submit(action === "open" ? "long" : "short")}>{action === "open" ? "开多" : "平空"}</button><button className="sell" onClick={() => void submit(action === "open" ? "short" : "long")}>{action === "open" ? "开空" : "平多"}</button></div><div className="ticket-foot"><ShieldCheck size={13} /> 下单前将显示完整风险复核</div></div>
    {quickPlan && <QuickPlanDialog plan={quickPlan} onChange={setQuickPlan} onClose={() => setQuickPlan(null)} onContinue={(draft) => void createQuickPlan(draft)} />}
    {wizardPlan && <DisciplineWizard plan={wizardPlan} index={wizardIndex} complete={wizardComplete} now={now} onAnswer={(value) => void answerQuestion(value)} onClose={() => { setWizardPlan(null); setWizardComplete(false); }} onContinue={() => void finishWizard()} />}
    {review && <ReviewDialog review={review} onClose={() => setReview(null)} onSubmit={async (accept) => { await submitOrder(review.token, accept); setReview(null); }} />}
  </aside>;

  function changeQuantityUnit(next: "base" | "usdt") { if (next === quantityUnit) return; const current = Number(quantity || 0); const converted = next === "usdt" ? current * effectivePrice : effectivePrice > 0 ? current / effectivePrice : 0; setQuantity(converted ? converted.toFixed(next === "usdt" ? 2 : 8).replace(/0+$/, "").replace(/\.$/, "") : "0"); setQuantityUnit(next); }
  function commitLeverage() { const parsed = Number(leverageInput.replace(/[^0-9]/g, "")); const next = Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.max(Math.round(parsed), 1), leverageCap) : leverage; setLeverage(next); setLeverageInput(`${next}x`); }
  function adjustLeverage(delta: number) { const next = Math.min(Math.max(leverage + delta, 1), leverageCap); setLeverage(next); }
}

function QuickPlanDialog({ plan, onChange, onClose, onContinue }: { plan: TradingPlan; onChange: (plan: TradingPlan) => void; onClose: () => void; onContinue: (plan: TradingPlan) => void }) {
  const valid = Number(plan.plannedPrice) > 0 && Number(plan.stopLoss) > 0 && Number(plan.targets[0]) > 0 && plan.entryReason.trim().length >= 5 && plan.takeProfitReason.trim().length >= 5;
  return <div className="modal-backdrop"><div className="modal quick-plan-modal"><div className="modal-title"><div><small>不离开交易页面</small><h2>创建即时交易计划</h2></div><button onClick={onClose}><X /></button></div><div className="quick-plan-symbol"><b>{plan.symbol.replace("_", "/")}</b><span className={plan.direction}>{plan.direction === "long" ? "做多" : "做空"}</span><span>{plan.exchange === "mexc" ? "MEXC" : "Ourbit"}</span></div><p className="modal-intro">先写清楚风险边界与交易理由，保存后会自动进入逐题纪律检查，并立即开始冷静期。</p><div className="quick-plan-grid"><QuickField label="计划价格" value={plan.plannedPrice} onChange={(value) => onChange({ ...plan, plannedPrice: value })} /><QuickField label="冷静期（分钟）" value={String(plan.cooldownMinutes)} onChange={(value) => onChange({ ...plan, cooldownMinutes: Math.max(1, Number(value) || 1) })} /><QuickField label="止损价格（必填）" value={plan.stopLoss} onChange={(value) => onChange({ ...plan, stopLoss: value })} /><QuickField label="止盈价格（必填）" value={plan.targets[0] ?? ""} onChange={(value) => onChange({ ...plan, targets: value ? [value] : [] })} /><QuickText label="下单原因（必填）" value={plan.entryReason} placeholder="行情结构、入场位置与确认信号" onChange={(value) => onChange({ ...plan, entryReason: value })} /><QuickText label="止盈原因（必填）" value={plan.takeProfitReason} placeholder="目标阻力、流动性或盈亏比依据" onChange={(value) => onChange({ ...plan, takeProfitReason: value })} /></div><div className="quick-plan-note"><Clock3 /> 最少冷静 {plan.cooldownMinutes} 分钟；倒计时期间不能进入订单提交。</div><div className="modal-actions"><button onClick={onClose}>取消</button><button className="primary" disabled={!valid} onClick={() => onContinue(plan)}>保存计划并回答纪律问题 <ChevronRight size={14} /></button></div></div></div>;
}

function DisciplineWizard({ plan, index, complete, now, onAnswer, onClose, onContinue }: { plan: TradingPlan; index: number; complete: boolean; now: number; onAnswer: (value: boolean) => void; onClose: () => void; onContinue: () => void }) {
  const questions = planQuestions(plan); const question = questions[index]; const remaining = Math.max(0, (plan.earliestEntryAt ?? now) - now); const result = evaluateChecklist(plan.checkMode, plan.answers, questions);
  return <div className="modal-backdrop"><div className="modal discipline-wizard"><div className="modal-title"><div><small>{complete ? "检查完成" : `纪律问题 ${index + 1} / ${questions.length}`}</small><h2>{complete ? "冷静期与检查结果" : "请在下单前诚实回答"}</h2></div><button onClick={onClose}><X /></button></div>{!complete ? <><div className="wizard-progress"><span style={{ width: `${index / questions.length * 100}%` }} /></div><div className="wizard-question"><span>{index + 1}</span><div><b>{question.prompt}</b><small>{question.critical ? "关键纪律项" : "普通纪律项"} · 本题期望回答“{question.expected ? "是" : "否"}”</small></div></div><div className="wizard-answer"><button className="yes" onClick={() => onAnswer(true)}>是，我确认</button><button className="no" onClick={() => onAnswer(false)}>否，不符合</button></div><p className="wizard-hint">回答会立即保存到这份交易计划；答完本题后自动显示下一题。</p></> : <><div className={`wizard-result ${result.failed.length ? "failed" : "passed"}`}>{result.failed.length ? <AlertTriangle /> : <Check />}<div><b>{result.failed.length ? `${result.failed.length} 项没有通过` : "纪律问题已全部通过"}</b><small>{result.unanswered.length ? `${result.unanswered.length} 项未回答` : "所有回答已保存，并与计划页面同步"}</small></div></div><div className={`wizard-countdown ${remaining === 0 ? "ready" : ""}`}><Clock3 /><span><small>{remaining === 0 ? "冷静期已结束" : "冷静期倒计时"}</small><b>{remaining === 0 ? "可以进入订单风险复核" : formatCountdown(remaining)}</b></span></div>{result.failed.length > 0 && <div className="wizard-failed-list">{result.failed.map((item) => <span key={item}>• {item}</span>)}</div>}<div className="modal-actions"><button onClick={onClose}>稍后再下单</button><button className="primary" disabled={remaining > 0} onClick={onContinue}>进入订单风险复核 <ChevronRight size={14} /></button></div></>}</div></div>;
}

function QuickField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label><span>{label}</span><input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value.replace(/[^0-9.]/g, ""))} /></label>; }
function QuickText({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) { return <label className="wide"><span>{label}</span><textarea rows={3} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>; }
function Field({ label, value, suffix, placeholder, compact = false, onChange }: { label: string; value: string; suffix: string; placeholder?: string; compact?: boolean; onChange: (value: string) => void }) { return <label className={`number-field ${compact ? "compact-field" : ""}`}><span>{label}</span><input inputMode="decimal" value={value} placeholder={placeholder || "0.00"} onChange={(event) => onChange(event.target.value.replace(/[^0-9.]/g, ""))} /><b>{suffix}</b></label>; }
function QuantityField({ label, value, suffix, baseAsset, unit, compact = false, onUnitChange, onChange }: { label: string; value: string; suffix: string; baseAsset: string; unit: "base" | "usdt"; compact?: boolean; onUnitChange: (value: "base" | "usdt") => void; onChange: (value: string) => void }) { return <label className={`number-field quantity-field ${compact ? "compact-field" : ""}`}><span>{label}</span><div className="quantity-unit-switch"><button className={unit === "base" ? "active" : ""} onClick={(event) => { event.preventDefault(); onUnitChange("base"); }}>{baseAsset}</button><button className={unit === "usdt" ? "active" : ""} onClick={(event) => { event.preventDefault(); onUnitChange("usdt"); }}>USDT</button></div><input inputMode="decimal" value={value} placeholder="0.00" onChange={(event) => onChange(event.target.value.replace(/[^0-9.]/g, ""))} /><b>{suffix}</b></label>; }
function PlanGateStatus({ plan, now }: { plan: TradingPlan; now: number }) { const waiting = plan.earliestEntryAt && now < plan.earliestEntryAt; return <div className={`gate-state ${plan.status}`}><span><TimerReset size={13} /> {statusLabel(plan, now)}</span>{waiting && <small>{formatCountdown(plan.earliestEntryAt! - now)} 后可开仓</small>}</div>; }

export function ReviewDialog({ review, onClose, onSubmit }: { review: OrderReview; onClose: () => void; onSubmit: (acceptWarnings: boolean) => Promise<void> }) {
  const [accepted, setAccepted] = useState(false); const blocked = review.blockedReasons.length > 0; const needsWarning = review.warnings.length > 0;
  const rows = useMemo(() => [["名义价值", `${review.notional} USDT`], ["杠杆 / 保证金", `${review.intent.leverage}x / ${review.marginRequired} USDT`], ["止损最大亏损", review.maxStopLoss ? `${review.maxStopLoss} USDT` : "未设置"], ["预估强平价", `${review.estimatedLiquidationPrice} USDT`], ["默认交易路由", `${assetClassLabel(review.assetClass)} → ${review.recommendedExchange === "mexc" ? "MEXC" : "Ourbit"}`], ["手续费估算", `Maker ${review.estimatedMakerFee} / Taker ${review.estimatedTakerFee} USDT`], ["资金费率成本", `${review.estimatedFundingFee} USDT / 当前周期（|${review.fundingRatePercent}%|）`], ["订单", `${review.intent.action === "open" ? "开" : "平"}${review.intent.direction === "long" ? "多" : "空"} · ${orderTypeLabel(review.intent.orderType)}`]], [review]);
  return <div className="modal-backdrop"><div className="modal review-modal"><div className="modal-title"><div><small>最终确认</small><h2>订单风险复核</h2></div><button onClick={onClose}>×</button></div><div className="review-symbol"><b>{review.intent.symbol.replace("_", "/")}</b><span className={review.intent.direction === "long" ? "long" : "short"}>{review.intent.direction === "long" ? "多" : "空"}</span><span>{review.intent.mode === "paper" ? "模拟盘" : "实盘"}</span></div><div className={`route-review ${review.intent.exchange === review.recommendedExchange ? "matched" : "override"}`}><b>{review.routeReason}</b><span>当前选择 {review.intent.exchange === "mexc" ? "MEXC" : "Ourbit"} · 费率档案{review.feeProfileVerified ? "已确认" : "未确认"}</span></div><div className="review-grid">{rows.map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div>{blocked && <div className="risk-box blocked"><strong><LockKeyhole size={15} /> 无法提交</strong>{review.blockedReasons.map((reason) => <p key={reason}>• {reason}</p>)}</div>}{!blocked && needsWarning && <div className="risk-box warning"><strong><AlertTriangle size={15} /> 纪律警告</strong>{review.warnings.map((warning) => <p key={warning}>• {warning}</p>)}</div>}{!blocked && <label className="confirm-line"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> 我已核对方向、数量、止损和最大亏损，本次决定符合计划</label>}<div className="modal-actions"><button onClick={onClose}>返回修改</button><button className="primary" disabled={blocked || !accepted} onClick={() => void onSubmit(needsWarning)}>确认提交{review.intent.mode === "live" ? "实盘" : "模拟"}订单</button></div></div></div>;
}

function statusLabel(plan: TradingPlan, now: number): string { if (plan.status === "triggered") return plan.earliestEntryAt && now >= plan.earliestEntryAt ? "可执行" : "冷静期"; return ({ draft: "草稿", armed: "待触发", expired: "已过期", completed: "已完成" } as Record<string, string>)[plan.status] || plan.status; }
function orderTypeLabel(type: OrderType): string { return ({ limit: "限价", market: "市价", post_only: "Post Only", ioc: "IOC", fok: "FOK", trigger: "条件", trailing: "移动止损" } as Record<OrderType, string>)[type]; }
function assetClassLabel(value: OrderReview["assetClass"]): string { return ({ crypto: "加密", stock: "股票", oil: "原油", precious_metal: "贵金属" } as const)[value]; }
