import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, Pause, Plus, ShieldCheck } from "lucide-react";
import { gateway } from "../store";
import type { DcaPlan, EconomicEvent } from "../types";
import { PageHeader } from "./AnalyticsPage";

type EventAssetFilter = "all" | EconomicEvent["affectedAssets"][number];

const eventFilters: Array<{ value: EventAssetFilter; label: string }> = [
  { value: "all", label: "全部" }, { value: "crypto", label: "加密货币" }, { value: "oil", label: "原油" },
  { value: "metals", label: "贵金属" }, { value: "stocks", label: "股市" }
];

export function DcaEventsPage() {
  const [plans, setPlans] = useState<DcaPlan[]>([]);
  const [events, setEvents] = useState<EconomicEvent[]>([]);
  const [eventFilter, setEventFilter] = useState<EventAssetFilter>("all");
  const [selected, setSelected] = useState<DcaPlan | null>(null);
  const [notice, setNotice] = useState("");
  const load = async () => {
    const [nextPlans, nextEvents] = await Promise.all([gateway.listDcaPlans(), gateway.listEconomicEvents(Date.now(), Date.now() + 7 * 86400000)]);
    setPlans(nextPlans); setEvents(nextEvents.sort((a, b) => a.occursAt - b.occursAt)); if (!selected && nextPlans[0]) setSelected(nextPlans[0]);
  };
  useEffect(() => { void load(); }, []);

  const filteredEvents = useMemo(() => eventFilter === "all" ? events : events.filter((event) => event.affectedAssets.includes(eventFilter)), [events, eventFilter]);
  const groupedEvents = useMemo(() => {
    const groups = new Map<string, EconomicEvent[]>();
    filteredEvents.forEach((event) => {
      const key = new Date(event.occursAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "long" });
      groups.set(key, [...(groups.get(key) ?? []), event]);
    });
    return [...groups.entries()];
  }, [filteredEvents]);

  const create = () => setSelected({ id: "", exchange: "ourbit", symbol: "BTC_USDT", amountUsdt: "100", frequency: "weekly", maxPurchasesPerDay: 1, mode: "paper", enabled: false });
  const save = async () => { if (!selected) return; const saved = await gateway.saveDcaPlan(selected); setSelected(saved); await load(); };
  const pauseAll = async () => { await Promise.all(plans.filter((plan) => plan.enabled).map((plan) => gateway.saveDcaPlan({ ...plan, enabled: false }))); setNotice("全部 DCA 计划已暂停"); await load(); };

  return <div className="app-page dca-page"><PageHeader title="DCA 与重大财经事件" description="首版保存模拟 DCA 演练计划，不自动成交；任何计划都不能绕过全局风险护栏。"><button className="danger-outline" disabled={!plans.some((plan) => plan.enabled)} onClick={() => void pauseAll()}><Pause size={14} /> 暂停全部计划</button></PageHeader>
    {notice && <div className="page-notice">{notice}</div>}
    <div className="dca-layout"><aside className="content-card dca-list"><div className="card-heading"><strong>DCA 计划</strong><button className="small-button primary" onClick={create}><Plus size={13} /> 新建</button></div>{plans.length === 0 && <div className="empty-plan"><ShieldCheck /><p>尚无计划。可创建固定周期或恐慌定投，默认只在模拟盘执行。</p></div>}{plans.map((plan) => <button key={plan.id} className={`dca-list-item ${selected?.id === plan.id ? "active" : ""}`} onClick={() => setSelected(plan)}><span><b>{plan.symbol.replace("_", "/")}</b><small>{frequencyLabel(plan)} · {plan.amountUsdt} USDT</small></span><em className={plan.enabled ? "running" : "paused"}>{plan.enabled ? "运行中" : "已暂停"}</em></button>)}</aside>
      <main className="content-card dca-editor"><div className="card-heading"><strong>{selected?.id ? "编辑 DCA 计划" : "新建 DCA 计划"}</strong><span>模拟盘</span></div>{selected ? <><div className="form-grid"><Form label="交易对" value={selected.symbol} onChange={(value) => setSelected({ ...selected, symbol: value.toUpperCase() })} /><label className="form-control"><span>交易所</span><select value={selected.exchange} onChange={(event) => setSelected({ ...selected, exchange: event.target.value as DcaPlan["exchange"] })}><option value="ourbit">Ourbit</option><option value="mexc">MEXC</option></select></label><Form label="每次金额（USDT）" value={selected.amountUsdt} onChange={(value) => setSelected({ ...selected, amountUsdt: value })} /><label className="form-control"><span>执行频率</span><select value={selected.frequency} onChange={(event) => setSelected({ ...selected, frequency: event.target.value as DcaPlan["frequency"] })}><option value="daily">每日</option><option value="weekly">每周</option><option value="monthly">每月</option><option value="panic">恐慌触发</option></select></label>{selected.frequency === "panic" && <Form label="24h 跌幅触发（%）" value={selected.panicDropPercent ?? "8"} onChange={(value) => setSelected({ ...selected, panicDropPercent: value })} />}<Form label="每日最多购买次数" value={String(selected.maxPurchasesPerDay)} onChange={(value) => setSelected({ ...selected, maxPurchasesPerDay: Math.max(1, Number(value) || 1) })} /></div><label className="toggle-row"><input type="checkbox" checked={selected.enabled} onChange={(event) => setSelected({ ...selected, enabled: event.target.checked })} /><span><b>启用模拟执行</b><small>不会发送真实订单</small></span></label><div className="panic-safety"><AlertTriangle size={15} /><span><b>恐慌定投附加护栏</b>跌幅触发后等待 10 分钟，重新检查行情连续性、当日次数与总预算，避免错误数据触发。</span></div><div className="editor-actions"><button onClick={() => setSelected(null)}>取消</button><button className="primary" onClick={() => void save()}>保存计划</button></div></> : <div className="empty-plan"><CalendarClock /><p>选择或创建一个 DCA 计划</p></div>}</main>
      <aside className="content-card event-list"><div className="card-heading"><strong>未来 7 天风险日历</strong><span>{filteredEvents.length} 项 · UTC+8</span></div><div className="event-filter-bar">{eventFilters.map((filter) => { const count = filter.value === "all" ? events.length : events.filter((event) => event.affectedAssets.includes(filter.value as Exclude<EventAssetFilter, "all">)).length; return <button key={filter.value} className={eventFilter === filter.value ? "active" : ""} onClick={() => setEventFilter(filter.value)}>{filter.label}<small>{count}</small></button>; })}</div><div className="event-source-warning">已核对 BEA、BLS、EIA 与美联储公开日程；标有“待确认”的模板事件需在交易前再次核实，不作为唯一提醒依据。</div><div className="event-calendar-scroll">{groupedEvents.map(([day, dayEvents]) => <section className="event-day" key={day}><header><b>{day}</b><span>{dayEvents.length} 项</span></header>{dayEvents.map((event) => <EventRow key={event.id} event={event} />)}</section>)}{filteredEvents.length === 0 && <div className="event-empty">当前筛选条件下没有事件</div>}<div className="event-risk-note"><AlertTriangle /><span><b>高影响事件纪律窗口</b>事件前后避免冲动追价；实盘风控联动接入可信实时日历后启用。</span></div></div></aside>
    </div>
  </div>;
}

function EventRow({ event }: { event: EconomicEvent }) {
  const impactStars = event.impact === "high" ? 3 : event.impact === "medium" ? 2 : 1;
  return <article className={`event-item impact-${event.impact}`}><div className="event-time"><time>{new Date(event.occursAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time><span>{countryBadge(event.country)} {event.country}</span></div><div className="event-main"><div className="event-title"><b>{event.title}</b><span className={`impact-stars ${event.impact}`} aria-label={`${impactStars} 星影响`}>{"★".repeat(impactStars)}{"☆".repeat(3 - impactStars)}</span></div><div className="event-values"><span>前值 <b>{event.previous ?? "—"}</b></span><span>预测 <b>{event.forecast ?? "—"}</b></span><span>公布 <b className={event.actual ? "actual" : ""}>{event.actual ?? "—"}</b></span></div><div className="event-tags"><em>{categoryLabel(event.category)}</em>{event.affectedAssets.map((asset) => <i key={asset} className={asset}>{assetLabel(asset)}</i>)}<small title={event.source}>{event.source}</small></div></div></article>;
}

function Form({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="form-control"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function frequencyLabel(plan: DcaPlan): string { return ({ daily: "每日", weekly: "每周", monthly: "每月", panic: `恐慌 ${plan.panicDropPercent ?? "8"}%` } as Record<DcaPlan["frequency"], string>)[plan.frequency]; }
function countryBadge(country: string): string { return ({ US: "🇺🇸", CN: "🇨🇳", EU: "🇪🇺", GLOBAL: "🌐" } as Record<string, string>)[country] ?? "🌐"; }
function categoryLabel(category: EconomicEvent["category"]): string { return ({ macro: "宏观", central_bank: "央行", employment: "就业", energy: "能源", crypto: "加密", market: "市场" } as const)[category]; }
function assetLabel(asset: EconomicEvent["affectedAssets"][number]): string { return ({ crypto: "加密", oil: "原油", metals: "金属", stocks: "股市" } as const)[asset]; }
