import { useEffect, useState } from "react";
import { BookOpenCheck, Download, TrendingDown, TrendingUp } from "lucide-react";
import { gateway } from "../store";
import type { TradingAnalytics } from "../types";

export function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<TradingAnalytics | null>(null);
  useEffect(() => { void gateway.getAnalytics().then(setAnalytics); }, []);
  if (!analytics) return <div className="page-loading">正在计算订单、仓位与复盘数据…</div>;
  const maxPnl = Math.max(...analytics.dailyPnl.map((item) => Math.abs(Number(item.pnl))), 1);
  return <div className="app-page analytics-page"><PageHeader title="交易表现与纪律分析" description="从订单、仓位、计划与复盘记录自动归因；统计不替代交易决策。"><button onClick={() => exportCsv(analytics)}><Download size={14} /> 导出 CSV</button></PageHeader>
    <div className="metric-cards"><Metric label="净盈亏" value={`${Number(analytics.netPnl) >= 0 ? "+" : ""}${analytics.netPnl} USDT`} tone="up" /><Metric label="胜率" value={`${analytics.winRate}%`} /><Metric label="盈亏因子" value={analytics.profitFactor.toFixed(2)} /><Metric label="纪律分" value={`${analytics.disciplineScore} / 100`} /><Metric label="平均盈利" value={`+${analytics.averageWin}`} tone="up" /><Metric label="平均亏损" value={analytics.averageLoss} tone="down" /></div>
    <div className="analytics-grid">
      <section className="content-card equity-card"><div className="card-heading"><strong>近 7 日已实现盈亏</strong><span>USDT</span></div><div className="bar-chart">{analytics.dailyPnl.map((item) => { const value = Number(item.pnl); return <div className="bar-column" key={item.date}><div className={`bar ${value >= 0 ? "positive" : "negative"}`} style={{ height: `${Math.abs(value) / maxPnl * 68 + 6}%` }}><em>{value >= 0 ? "+" : ""}{value.toFixed(0)}</em></div><small>{item.date.slice(5)}</small></div>; })}<i className="zero-line" /></div></section>
      <section className="content-card"><div className="card-heading"><strong>纪律执行</strong><span>{analytics.disciplineScore}%</span></div><div className="score-ring" style={{ "--score": `${analytics.disciplineScore * 3.6}deg` } as React.CSSProperties}><span><b>{analytics.disciplineScore}</b><small>纪律分</small></span></div><div className="discipline-stats"><span><BookOpenCheck size={14} /> 已复盘 {analytics.reviewedTrades} / {analytics.totalTrades}</span><span><TrendingUp size={14} /> 复盘中遵守计划 {analytics.plannedTrades} 笔</span><span><TrendingDown size={14} /> 复盘中偏离计划 {Math.max(analytics.reviewedTrades - analytics.plannedTrades, 0)} 笔</span></div></section>
      <section className="content-card mistakes-card"><div className="card-heading"><strong>错误归因</strong><span>次数 / 盈亏影响</span></div><div className="mistake-head"><span>错误标签</span><span>次数</span><span>影响</span><span>改进建议</span></div>{analytics.topMistakes.length ? analytics.topMistakes.map((item) => <div className="mistake-line" key={item.tag}><b>{item.tag}</b><span>{item.count}</span><span className={Number(item.pnl) >= 0 ? "up" : "down"}>{item.pnl} USDT</span><span>{item.tag.includes("止损") ? "下单后锁定扩大止损" : "延长冷静期并复核触发K线"}</span></div>) : <div className="analytics-empty">暂无错误标签，请先完成平仓复盘</div>}</section>
      <section className="content-card"><div className="card-heading"><strong>按时段表现</strong><span>UTC+8</span></div><div className="session-list">{analytics.sessions.map((item) => <Session key={item.label} label={item.label} trades={item.trades} pnl={item.pnl} score={item.winRate} />)}</div></section>
    </div>
  </div>;
}

export function PageHeader({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) { return <header className="page-header"><div><h1>{title}</h1><p>{description}</p></div><div>{children}</div></header>; }
function Metric({ label, value, tone = "" }: { label: string; value: string; tone?: string }) { return <div className="metric-card"><span>{label}</span><b className={tone}>{value}</b></div>; }
function Session({ label, trades, pnl, score }: { label: string; trades: number; pnl: string; score: number }) { return <div className="session-row"><span><b>{label}</b><small>{trades} 笔交易</small></span><div className="session-meter"><i style={{ width: `${score}%` }} /></div><b className={Number(pnl) >= 0 ? "up" : "down"}>{pnl} USDT</b></div>; }
function exportCsv(analytics: TradingAnalytics) {
  const rows = [["日期", "已实现净盈亏(USDT)"], ...analytics.dailyPnl.map((item) => [item.date, item.pnl])];
  const csv = `\uFEFF${rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `纪律交易分析-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
}
