import { AlertTriangle, BarChart3, Database, Info, Layers3, ShieldAlert } from "lucide-react";
import { useTradingStore } from "../store";
import type { AssetClass, Candle, MarketSnapshot, Timeframe } from "../types";

export type MarketWorkspaceTab = "chart" | "profile" | "rules" | "risk" | "data";

export const MARKET_WORKSPACE_TABS: Array<{ value: MarketWorkspaceTab; label: string }> = [
  { value: "chart", label: "图表" }, { value: "profile", label: "品种资料" }, { value: "rules", label: "交易规则" },
  { value: "risk", label: "风险限制" }, { value: "data", label: "交易数据" }
];

export function MarketReferencePanel({ tab, market, timeframe }: { tab: Exclude<MarketWorkspaceTab, "chart">; market: MarketSnapshot; timeframe: Timeframe }) {
  if (tab === "profile") return <ProfilePanel market={market} />;
  if (tab === "rules") return <RulesPanel market={market} />;
  if (tab === "risk") return <RiskPanel market={market} />;
  return <TradingDataPanel market={market} timeframe={timeframe} />;
}

function PanelHeader({ market, icon, title, description }: { market: MarketSnapshot; icon: React.ReactNode; title: string; description: string }) {
  return <header className="market-reference-header"><span className="reference-asset-icon">{market.instrument.baseAsset.slice(0, 1)}</span><div>{icon}<b>{market.instrument.symbol.replace("_", "/")} · {title}</b><small>{description}</small></div><em className={market.connected ? "online" : "offline"}>{market.connected ? market.source === "exchange" ? "交易所数据" : "演示数据" : "数据断线"}</em></header>;
}

function ProfilePanel({ market }: { market: MarketSnapshot }) {
  const profile = assetProfile(market.instrument.baseAsset, market.instrument.assetClass);
  return <div className="market-reference-scroll"><PanelHeader market={market} icon={<Info />} title="品种资料" description="合约身份与基础说明" />
    <div className="reference-content profile-layout"><section><h3>{profile.name}</h3><p>{profile.description}</p><h4>合约用途</h4><p>{profile.usage}</p><div className="source-note"><Database size={14} />价格、精度和状态来自当前行情快照；文字介绍为软件内置资料，不作为投资建议。</div></section>
      <section className="reference-kv"><KeyValue label="资产类别" value={assetClassLabel(market.instrument.assetClass)} /><KeyValue label="基础资产" value={market.instrument.baseAsset} /><KeyValue label="计价资产" value={market.instrument.quoteAsset} /><KeyValue label="合约类型" value="USDT 永续" /><KeyValue label="默认交易所" value={market.instrument.exchange === "ourbit" ? "Ourbit" : "MEXC"} /><KeyValue label="合约状态" value={market.instrument.status} /><KeyValue label="合约面值" value={`${market.instrument.contractSize} ${market.instrument.baseAsset}`} /><KeyValue label="最高杠杆" value={`${market.instrument.maxLeverage}x`} /></section>
    </div>
  </div>;
}

function RulesPanel({ market }: { market: MarketSnapshot }) {
  const item = market.instrument;
  return <div className="market-reference-scroll"><PanelHeader market={market} icon={<Layers3 />} title="交易规则" description="当前适配器返回的合约规格" />
    <div className="reference-content"><div className="reference-section-title"><h3>合约规则</h3><span>下单前仍会再次按交易所能力与本地风险参数校验</span></div>
      <div className="rules-grid"><RuleCard label="杠杆范围" value={`1–${item.maxLeverage}x`} /><RuleCard label="最小下单量" value={`${item.minQuantity} ${item.baseAsset}`} /><RuleCard label="数量步长" value={`${item.quantityStep} ${item.baseAsset}`} /><RuleCard label="最小价格变动" value={`${item.priceTick} ${item.quoteAsset}`} /><RuleCard label="合约面值" value={`1 张 = ${item.contractSize} ${item.baseAsset}`} /><RuleCard label="保证金资产" value={item.quoteAsset} /></div>
      <div className="rule-table"><div><span>订单能力</span><span>当前状态</span><span>说明</span></div><div><b>市价 / 限价</b><strong className="up">下单区可用</strong><span>最终以交易所能力矩阵为准</span></div><div><b>Post Only / IOC / FOK</b><strong>按交易所探测</strong><span>不支持的订单类型会被禁用或拦截</span></div><div><b>止盈止损</b><strong>纪律开仓必填止损</strong><span>交易所不支持时不会用本地程序伪造在线条件单</span></div><div><b>最大订单与仓位档位</b><strong className="warning-text">需账户接口</strong><span>未取得实时档位时不展示虚假数值</span></div></div>
    </div>
  </div>;
}

function RiskPanel({ market }: { market: MarketSnapshot }) {
  const { boot, exchange } = useTradingStore(); const risk = boot?.riskSettings; const capability = boot?.capabilities.find((item) => item.exchange === exchange);
  return <div className="market-reference-scroll"><PanelHeader market={market} icon={<ShieldAlert />} title="风险限制" description="交易所能力与本地纪律护栏" />
    <div className="reference-content"><div className="risk-source-banner"><AlertTriangle size={15} /><span>交易所分档维持保证金率尚未接入统一接口；软件不会套用截图中的示例档位。下面只显示已确认的合约规格和本地风险上限。</span></div>
      <div className="risk-limit-table"><div><span>风险层</span><span>最高杠杆</span><span>名义价值上限</span><span>单笔风险</span><span>状态</span></div><div><b>交易所合约规格</b><strong>{market.instrument.maxLeverage}x</strong><span>账户档位实时决定</span><span>交易所维持保证金规则</span><em className={capability?.marketData ? "online" : "offline"}>{capability?.marketData ? "行情可用" : "未探测"}</em></div><div><b>本地纪律护栏</b><strong>{risk ? (risk.enforceGlobalLimits ? `${risk.maxLeverage}x` : "不设限") : "未设置"}</strong><span>{risk ? (risk.enforceGlobalLimits ? `${risk.maxNotional} USDT` : "不设限") : "未设置"}</span><span>{risk ? (risk.enforceGlobalLimits ? `${risk.maxRiskPercent}%` : "不设限") : "未设置"}</span><em className={risk ? "online" : "offline"}>{risk ? (risk.enforceGlobalLimits ? "强制生效" : "额度未设限") : "禁止实盘"}</em></div></div>
      <div className="risk-lock-grid"><RiskLock label="每日亏损上限" value={risk ? (risk.enforceGlobalLimits ? `${risk.dailyLossLimit} USDT` : "不设限") : "未设置"} /><RiskLock label="行情断流锁定" value={risk ? `${risk.marketDataTimeoutSeconds} 秒` : "未设置"} /><RiskLock label="最大时间偏差" value={risk ? `${risk.maxClockSkewSeconds} 秒` : "未设置"} /><RiskLock label="允许合约" value={risk ? (risk.restrictAllowedSymbols ? `${risk.allowedSymbols.length} 个` : "不设限") : "未设置"} /></div>
    </div>
  </div>;
}

function TradingDataPanel({ market, timeframe }: { market: MarketSnapshot; timeframe: Timeframe }) {
  const changes = [1, 4, 12, 24].map((hours) => ({ hours, value: changeOverHours(market.candles, hours) }));
  const bids = market.depth.bids.reduce((sum, item) => sum + Number(item.quantity), 0); const asks = market.depth.asks.reduce((sum, item) => sum + Number(item.quantity), 0); const bidRatio = bids + asks ? bids / (bids + asks) * 100 : 50;
  const bestBid = Number(market.depth.bids[0]?.price ?? market.ticker.last); const bestAsk = Number(market.depth.asks[0]?.price ?? market.ticker.last); const spread = bestAsk - bestBid;
  return <div className="market-reference-scroll"><PanelHeader market={market} icon={<BarChart3 />} title="交易数据" description={`基于当前 ${timeframe} K线、盘口与资金费率`} />
    <div className="reference-content"><div className="data-cards"><DataCard label="24h 成交额" value={`${market.ticker.volume24h} USDT`} /><DataCard label="资金费率" value={`${market.ticker.fundingRate}%`} tone={Number(market.ticker.fundingRate) >= 0 ? "up" : "down"} /><DataCard label="盘口价差" value={`${formatNumber(spread)} USDT`} /><DataCard label="盘口买方占比" value={`${bidRatio.toFixed(1)}%`} tone={bidRatio >= 50 ? "up" : "down"} /></div>
      <section className="market-trend-card"><div><h3>价格变化</h3><small>从当前 K 线序列按时间回溯</small></div><div className="change-row">{changes.map((item) => <span key={item.hours}><small>{item.hours} 小时</small><b className={item.value >= 0 ? "up" : "down"}>{signed(item.value)}%</b></span>)}</div><SparkLine candles={market.candles} /></section>
      <section className="depth-balance-card"><div><h3>盘口多空压力</h3><small>仅代表当前可见深度，不等同于全市场持仓多空比</small></div><div className="depth-balance"><i style={{ width: `${bidRatio}%` }} /><span>买 {bidRatio.toFixed(1)}%</span><span>卖 {(100 - bidRatio).toFixed(1)}%</span></div><div className="depth-totals"><span>买盘 {formatNumber(bids)} {market.instrument.baseAsset}</span><span>卖盘 {formatNumber(asks)} {market.instrument.baseAsset}</span><span>更新时间 {new Date(market.depth.updatedAt).toLocaleTimeString()}</span></div></section>
    </div>
  </div>;
}

function KeyValue({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><b>{value}</b></div>; }
function RuleCard({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><b>{value}</b></div>; }
function RiskLock({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><b>{value}</b></div>; }
function DataCard({ label, value, tone = "" }: { label: string; value: string; tone?: string }) { return <div><span>{label}</span><b className={tone}>{value}</b></div>; }

function SparkLine({ candles }: { candles: Candle[] }) {
  const values = candles.slice(-120).map((item) => item.close); if (values.length < 2) return null;
  const min = Math.min(...values); const max = Math.max(...values); const range = max - min || 1;
  const points = values.map((value, index) => `${index / (values.length - 1) * 100},${44 - (value - min) / range * 40}`).join(" ");
  return <svg className="market-sparkline" viewBox="0 0 100 48" preserveAspectRatio="none"><defs><linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#42d1a7" stopOpacity=".35" /><stop offset="1" stopColor="#42d1a7" stopOpacity="0" /></linearGradient></defs><polygon points={`0,48 ${points} 100,48`} fill="url(#spark-fill)" /><polyline points={points} fill="none" stroke="#42d1a7" strokeWidth="1.2" vectorEffect="non-scaling-stroke" /></svg>;
}

function changeOverHours(candles: Candle[], hours: number): number {
  const latest = candles.at(-1); if (!latest) return 0; const target = latest.time - hours * 3600;
  const prior = [...candles].reverse().find((item) => item.time <= target) ?? candles[0]; return prior.close ? (latest.close / prior.close - 1) * 100 : 0;
}
function signed(value: number): string { return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`; }
function formatNumber(value: number): string { return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 6 }) : "—"; }
function assetClassLabel(value: AssetClass): string { return ({ crypto: "加密货币", stock: "股票合约", oil: "原油合约", precious_metal: "贵金属合约" } as const)[value]; }

function assetProfile(base: string, assetClass: AssetClass): { name: string; description: string; usage: string } {
  const known: Record<string, { name: string; description: string; usage: string }> = {
    BTC: { name: "比特币（Bitcoin）", description: "比特币是一种点对点数字资产，使用公开区块链记录转账与发行。永续合约跟踪其指数价格，不代表持有现货比特币。", usage: "用于观察和交易 BTC/USDT 永续合约价格变化；合约具有杠杆、资金费率与强平风险。" },
    ETH: { name: "以太坊（Ethereum）", description: "以太坊是支持智能合约的区块链网络，ETH 是其原生资产。永续合约只提供价格敞口。", usage: "用于 ETH/USDT 永续合约交易与风险对冲。" },
    SOL: { name: "Solana", description: "Solana 是面向高吞吐应用的区块链网络，SOL 是其原生资产。", usage: "用于 SOL/USDT 永续合约交易，需关注波动、资金费率和流动性。" }
  };
  if (known[base]) return known[base];
  if (assetClass === "stock") return { name: `${base} 股票价格合约`, description: "该合约提供标的股票价格敞口，不等同于持有股票，不包含股东权利。", usage: "用于股票价格方向交易与风险管理，需关注交易时段、跳空和公司事件。" };
  if (assetClass === "oil") return { name: `${base} 原油价格合约`, description: "该合约跟踪相关原油基准价格，不涉及实物交割。", usage: "用于能源价格方向交易，需关注库存、宏观事件、期限结构和交易时段。" };
  if (assetClass === "precious_metal") return { name: `${base} 贵金属价格合约`, description: "该合约提供贵金属价格敞口，不代表持有实物金属。", usage: "用于贵金属方向交易或风险对冲，需关注美元、利率和流动性。" };
  return { name: base, description: "当前品种的详细资料尚未收录。合约元数据与行情仍以交易所接口返回为准。", usage: "用于 USDT 永续合约交易；开仓前应确认交易规则和风险限制。" };
}
