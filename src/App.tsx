import { useEffect, useState } from "react";
import { Activity, AlertOctagon, BarChart3, CalendarClock, ChevronDown, CircleDollarSign, ClipboardCheck, KeyRound, LayoutDashboard, LoaderCircle, LockKeyhole, Settings, ShieldAlert, Wifi, X } from "lucide-react";
import { AnalyticsPage } from "./components/AnalyticsPage";
import { BottomPanel } from "./components/BottomPanel";
import { ChartPanel } from "./components/ChartPanel";
import { DcaEventsPage } from "./components/DcaEventsPage";
import { MarketSidebar } from "./components/MarketSidebar";
import { OrderBook } from "./components/OrderBook";
import { OrderTicket } from "./components/OrderTicket";
import { PlanManager } from "./components/PlanManager";
import { SettingsPage } from "./components/SettingsPage";
import { classifyAsset } from "./lib/routing";
import { gateway, useTradingStore } from "./store";
import type { ExchangeId } from "./types";

type View = "trade" | "plans" | "analytics" | "dca" | "settings";

export default function App() {
  const store = useTradingStore();
  const [view, setView] = useState<View>("trade");
  const [layout, setLayout] = useState<1 | 2 | 4>(1);
  const [planOpen, setPlanOpen] = useState(false);
  const [marketOpen, setMarketOpen] = useState(false);
  const navigate = (next: View) => {
    setView(next);
    setPlanOpen(next === "plans");
  };
  const openPlans = () => navigate("plans");

  useEffect(() => { void store.initialize(); }, []);
  useEffect(() => {
    if (!store.boot || store.loading) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const exchange = store.exchange; const symbol = store.symbol; const timeframe = store.timeframe;
    void gateway.subscribeMarket(exchange, symbol, timeframe, (snapshot) => {
      const current = useTradingStore.getState();
      if (current.exchange === exchange && current.symbol === symbol && current.timeframe === timeframe) current.setMarket(snapshot);
    }).then((next) => { if (cancelled) void next(); else dispose = next; });
    return () => { cancelled = true; dispose?.(); };
  }, [store.exchange, store.symbol, store.timeframe, store.loading, Boolean(store.boot)]);
  useEffect(() => {
    if (store.mode !== "live") return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await useTradingStore.getState().syncAccount();
      if (!cancelled && useTradingStore.getState().mode === "live") timer = window.setTimeout(poll, 5_000);
    };
    void poll();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [store.mode, store.exchange]);

  if (store.loading && !store.market) return <div className="splash"><span className="brand-mark">D</span><h1>纪律交易终端</h1><p>正在初始化模拟盘与安全状态…</p></div>;
  if (!store.market || !store.boot) return <div className="fatal-state"><ShieldAlert /><h1>终端无法初始化</h1><p>{store.error ?? "未知错误"}</p><button onClick={() => void store.initialize()}>重新加载</button></div>;

  const capability = store.boot.capabilities.find((item) => item.exchange === store.exchange);
  const liveDisabled = !capability?.liveTrading || store.boot.liveLock.locked;

  return <div className="desktop-app">
    <header className="global-header">
      <div className="brand"><span className="brand-mark">D</span><b>Discipline Terminal</b><small>纪律交易</small></div>
      <nav className="global-nav">
        <NavButton active={view === "trade"} onClick={() => navigate("trade")} icon={<LayoutDashboard />} label="交易" />
        <NavButton active={view === "plans"} onClick={() => navigate("plans")} icon={<ClipboardCheck />} label="计划" />
        <NavButton active={view === "analytics"} onClick={() => navigate("analytics")} icon={<BarChart3 />} label="复盘分析" />
        <NavButton active={view === "dca"} onClick={() => navigate("dca")} icon={<CalendarClock />} label="DCA / 事件" />
        <NavButton active={view === "settings"} onClick={() => navigate("settings")} icon={<Settings />} label="设置" />
      </nav>
      <div className="global-status"><span className={`latency ${store.market.connected ? "" : "down"}`} title={`数据源：${store.market.source}`}><Wifi size={13} /> {store.market.connected ? store.market.source === "exchange" ? "真实行情" : "演示行情" : "行情断线"}</span><button className={`mode-switch ${store.mode}`} onClick={() => void store.setMode(store.mode === "paper" ? "live" : "paper")}><CircleDollarSign size={13} /> {store.mode === "paper" ? "模拟盘" : "实盘"}<ChevronDown size={12} /></button><button className="exchange-switch" onClick={() => void store.selectMarket(store.exchange === "mexc" ? "ourbit" : "mexc", store.symbol)}>{store.exchange === "mexc" ? "MEXC" : "Ourbit"}<ChevronDown size={12} /></button><span className={`live-lock ${liveDisabled ? "locked" : "unlocked"}`} title={capability?.reason}><LockKeyhole size={13} /> {liveDisabled ? "实盘锁定" : "实盘就绪"}</span><button className="kill-switch" onClick={() => void gateway.emergencyStop("用户手动触发全局停止").then(store.refresh)}><AlertOctagon size={14} /> 立即停止实盘</button></div>
    </header>

    {view === "trade" && <>
      <MarketHeader planOpen={openPlans} openMarket={() => setMarketOpen(true)} />
      <main className="terminal-grid">
        {store.loading && <div className="market-refresh-overlay"><LoaderCircle size={20} /> 正在获取 {store.symbol.replace("_", "/")} 最新价格、K线和盘口…</div>}
        {marketOpen && <button className="market-drawer-backdrop" aria-label="关闭合约市场" onClick={() => setMarketOpen(false)} />}
        <MarketSidebar open={marketOpen} onClose={() => setMarketOpen(false)} exchange={store.exchange} symbol={store.symbol} market={store.market} routing={store.boot.routingSettings} onSelect={(exchange, symbol) => { setMarketOpen(false); void store.selectMarket(exchange, symbol); }} />
        <ChartPanel market={store.market} timeframe={store.timeframe} onTimeframe={(value) => void store.setTimeframe(value)} layout={layout} onLayout={setLayout} />
        <OrderBook market={store.market} />
        <OrderTicket onPlans={openPlans} />
        <BottomPanel />
      </main>
    </>}
    {view === "analytics" && <AnalyticsPage />}
    {view === "dca" && <DcaEventsPage />}
    {view === "settings" && <SettingsPage />}
    {view === "plans" && <div className="app-page plan-landing"><div><ClipboardCheck /><h1>交易计划</h1><p>计划管理已在独立工作区打开。</p><button className="primary" onClick={() => setPlanOpen(true)}>打开计划管理</button></div></div>}

    <PlanManager open={planOpen} onClose={() => { setPlanOpen(false); if (view === "plans") setView("trade"); }} />
    {(store.error || store.notice) && <div className={`toast ${store.error ? "error" : "success"}`} role={store.error ? "alert" : "status"}><span>{store.error ?? store.notice}</span><button aria-label="关闭提示" onClick={store.clearMessage}><X size={14} /></button></div>}
  </div>;
}

function NavButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) { return <button className={active ? "active" : ""} title={label} onClick={onClick}>{icon}{label}</button>; }

function MarketHeader({ planOpen, openMarket }: { planOpen: () => void; openMarket: () => void }) {
  const { market, boot, symbol, loading } = useTradingStore();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const plan = boot?.plans.find((item) => item.symbol === symbol && item.status === "triggered");
  const waiting = plan?.earliestEntryAt && plan.earliestEntryAt > now;
  if (!market) return null;
  const assetClass = loading ? classifyAsset(symbol) : market.instrument.assetClass; const routing = boot!.routingSettings; const preferred = assetClass === "crypto" ? routing.cryptoExchange : assetClass === "stock" ? routing.stockExchange : assetClass === "oil" ? routing.oilExchange : routing.preciousMetalExchange;
  return <section className="market-header"><button className="symbol-title" onClick={openMarket} title="选择交易合约"><span className="coin-icon">{symbol.startsWith("BTC") ? "₿" : symbol.slice(0, 1)}</span><div><b>{symbol.replace("_", " / ")} <ChevronDown size={12} /></b><small>{assetClassLabel(assetClass)} · 默认 {preferred === "mexc" ? "MEXC" : "Ourbit"}</small></div></button><div className="hero-price"><b className={loading ? "refreshing" : Number(market.ticker.change24h) >= 0 ? "up" : "down"}>{loading ? "刷新中…" : formatMarketNumber(market.ticker.last)}</b><span className={Number(market.ticker.change24h) >= 0 ? "up" : "down"}>{loading ? "正在读取最新行情" : `${Number(market.ticker.change24h) >= 0 ? "+" : ""}${market.ticker.change24h}%`}</span></div><TickerStat label="标记 / 指数" value={loading ? "— / —" : `${formatMarketNumber(market.ticker.markPrice)} / ${formatMarketNumber(market.ticker.indexPrice)}`} /><TickerStat label="24h 高 / 低" value={loading ? "— / —" : `${formatMarketNumber(market.ticker.high24h)} / ${formatMarketNumber(market.ticker.low24h)}`} /><TickerStat label="24h 成交额" value={loading ? "—" : `${market.ticker.volume24h} USDT`} /><TickerStat label="资金费率 / 倒计时" value={loading ? "—" : `${market.ticker.fundingRate}% · ${fundingCountdown(market.ticker.nextFundingAt, now)}`} /><button className={`plan-timer ${plan ? "active" : ""}`} onClick={planOpen}><Activity size={15} /><span><b>{plan ? `计划「${plan.name}」` : "没有执行中的计划"}</b><small>{plan ? waiting ? `冷静期剩余 ${countdown(plan.earliestEntryAt!, now)}` : "冷静期结束 · 可进入风险复核" : "创建计划后才能开仓"}</small></span></button></section>;
}

function TickerStat({ label, value }: { label: string; value: string }) { return <div className="ticker-stat" title={`${label}：${value}`}><span>{label}</span><b>{value}</b></div>; }
function formatMarketNumber(value: string): string { const numeric = Number(value); return Number.isFinite(numeric) ? numeric.toLocaleString(undefined, { maximumFractionDigits: 8 }) : "—"; }
function countdown(time: number, now: number): string { const seconds = Math.max(0, Math.ceil((time - now) / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function fundingCountdown(time: number, now: number): string { const seconds = Math.max(0, Math.floor((time - now) / 1000)); const hours = Math.floor(seconds / 3600); return `${String(hours).padStart(2, "0")}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function assetClassLabel(value: import("./types").AssetClass): string { return ({ crypto: "加密货币合约", stock: "股票合约", oil: "原油合约", precious_metal: "贵金属合约" } as const)[value]; }
