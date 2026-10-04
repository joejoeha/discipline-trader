import { useMemo, useState } from "react";
import { useTradingStore } from "../store";
import type { DepthLevel, MarketSnapshot } from "../types";

type BookView = "both" | "asks" | "bids";

export function OrderBook({ market }: { market: MarketSnapshot }) {
  const [tab, setTab] = useState<"depth" | "trades">("depth"); const [view, setView] = useState<BookView>("both"); const [multiplier, setMultiplier] = useState(1);
  const setDraftOrderPrice = useTradingStore((state) => state.setDraftOrderPrice);
  const tick = Math.max(Number(market.instrument.priceTick) || 0.1, Number.EPSILON); const increment = tick * multiplier;
  const bids = useMemo(() => groupDepth(market.depth.bids, increment, "bid"), [market.depth.bids, increment]);
  const asks = useMemo(() => groupDepth(market.depth.asks, increment, "ask"), [market.depth.asks, increment]);
  const visibleBids = cumulative(view === "bids" ? bids.slice(0, 18) : bids.slice(0, 8)); const visibleAsks = cumulative(view === "asks" ? asks.slice(0, 18) : asks.slice(0, 8));
  const max = Math.max(1, ...visibleBids.concat(visibleAsks).map((item) => Number(item.quantity)));
  const bidTotal = bids.reduce((sum, item) => sum + Number(item.quantity), 0); const askTotal = asks.reduce((sum, item) => sum + Number(item.quantity), 0); const buyRatio = bidTotal + askTotal ? bidTotal / (bidTotal + askTotal) * 100 : 50;
  return <section className="orderbook panel">
    <div className="panel-tabs"><button className={tab === "depth" ? "active" : ""} onClick={() => setTab("depth")}>委托订单</button><button className={tab === "trades" ? "active" : ""} onClick={() => setTab("trades")}>最新成交</button><span className="book-menu">•••</span></div>
    {tab === "depth" ? <>
      <div className="book-tools"><div className="book-view-buttons"><button className={view === "both" ? "active" : ""} title="买卖盘口" onClick={() => setView("both")}>▥</button><button className={view === "asks" ? "active asks" : "asks"} title="只看卖盘" onClick={() => setView("asks")}>▤</button><button className={view === "bids" ? "active bids" : "bids"} title="只看买盘" onClick={() => setView("bids")}>▥</button></div><select aria-label="盘口价格精度" value={multiplier} onChange={(event) => setMultiplier(Number(event.target.value))}><option value={1}>{formatTick(tick)}</option><option value={10}>{formatTick(tick * 10)}</option><option value={100}>{formatTick(tick * 100)}</option></select></div>
      <div className="book-head"><span>价格(USDT)</span><span>数量</span><span>总量</span></div>
      {view !== "bids" && <div className="ask-list">{[...visibleAsks].reverse().map((item) => <DepthRow key={item.price} item={item} max={max} side="ask" onPrice={setDraftOrderPrice} />)}</div>}
      <button className="mid-price" onClick={() => setDraftOrderPrice(market.ticker.last)}><strong className={Number(market.ticker.change24h) >= 0 ? "up" : "down"}>{Number(market.ticker.last).toLocaleString()}</strong><span>{market.ticker.change24h}% · 指数 {Number(market.ticker.indexPrice).toLocaleString()}</span></button>
      {view !== "asks" && <div className="bid-list">{visibleBids.map((item) => <DepthRow key={item.price} item={item} max={max} side="bid" onPrice={setDraftOrderPrice} />)}</div>}
      <div className="book-ratio"><span>买 {buyRatio.toFixed(1)}%</span><div><i style={{ width: `${buyRatio}%` }} /></div><span>{(100 - buyRatio).toFixed(1)}% 卖</span></div>
    </> : <>
      <div className="book-head"><span>价格</span><span>数量</span><span>时间</span></div>
      <div className="trade-list">{market.trades.map((trade) => <button className="trade-row" key={trade.id} onClick={() => setDraftOrderPrice(trade.price)}><span className={trade.side === "buy" ? "up" : "down"}>{Number(trade.price).toLocaleString()}</span><span>{trade.quantity}</span><span>{new Date(trade.time).toLocaleTimeString([], { hour12: false })}</span></button>)}</div>
    </>}
  </section>;
}

interface CumulativeLevel extends DepthLevel { total: string }
function DepthRow({ item, max, side, onPrice }: { item: CumulativeLevel; max: number; side: "bid" | "ask"; onPrice: (price: string) => void }) {
  return <button className="depth-row" onClick={() => onPrice(item.price)} title="点击填入委托价格"><i className={side} style={{ width: `${Number(item.quantity) / max * 90}%` }} /><span className={side === "bid" ? "up" : "down"}>{Number(item.price).toLocaleString()}</span><span>{formatQuantity(Number(item.quantity))}</span><span>{item.total}</span></button>;
}
function cumulative(levels: DepthLevel[]): CumulativeLevel[] { let total = 0; return levels.map((item) => { total += Number(item.quantity); return { ...item, total: formatQuantity(total) }; }); }
function groupDepth(levels: DepthLevel[], increment: number, side: "bid" | "ask"): DepthLevel[] {
  const grouped = new Map<number, number>();
  levels.forEach((item) => { const price = Number(item.price); const key = (side === "bid" ? Math.floor(price / increment) : Math.ceil(price / increment)) * increment; grouped.set(key, (grouped.get(key) ?? 0) + Number(item.quantity)); });
  return [...grouped].sort((a, b) => side === "bid" ? b[0] - a[0] : a[0] - b[0]).map(([price, quantity]) => ({ price: String(Number(price.toPrecision(12))), quantity: String(quantity) }));
}
function formatQuantity(value: number): string { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(2)}K` : value.toFixed(value >= 100 ? 2 : 3); }
function formatTick(value: number): string { return value >= 1 ? value.toFixed(0) : value.toFixed(Math.min(8, Math.max(0, Math.ceil(-Math.log10(value))))); }
