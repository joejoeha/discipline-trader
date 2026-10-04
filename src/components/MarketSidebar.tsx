import { useEffect, useMemo, useState } from "react";
import { Search, Star, X } from "lucide-react";
import { gateway } from "../store";
import type { AssetClass, ExchangeId, Instrument, MarketSnapshot, RoutingSettings } from "../types";

type MarketTab = "favorites" | "crypto" | "stock" | "commodity";

export function MarketSidebar({ open, onClose, exchange, symbol, market, routing, onSelect }: { open: boolean; onClose: () => void; exchange: ExchangeId; symbol: string; market: MarketSnapshot; routing: RoutingSettings; onSelect: (exchange: ExchangeId, symbol: string) => void }) {
  const [instruments, setInstruments] = useState<Instrument[]>([market.instrument]);
  const [query, setQuery] = useState(""); const [tab, setTab] = useState<MarketTab>("favorites");
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites(exchange));
  useEffect(() => { setQuery(""); setFavorites(loadFavorites(exchange)); void gateway.getInstruments(exchange).then((items) => setInstruments(items.length ? items : [market.instrument])).catch(() => setInstruments([market.instrument])); }, [exchange]);
  useEffect(() => { if (!instruments.some((item) => item.symbol === market.instrument.symbol)) setInstruments((items) => [market.instrument, ...items]); }, [market.instrument.symbol]);
  const visible = useMemo(() => instruments.filter((item) => {
    if (tab === "favorites" && !favorites.includes(item.symbol)) return false;
    if (tab === "crypto" && item.assetClass !== "crypto") return false;
    if (tab === "stock" && item.assetClass !== "stock") return false;
    if (tab === "commodity" && !["oil", "precious_metal"].includes(item.assetClass)) return false;
    return !query || item.symbol.toUpperCase().includes(query.trim().toUpperCase());
  }).sort((left, right) => Number(favorites.includes(right.symbol)) - Number(favorites.includes(left.symbol))).slice(0, 150), [favorites, instruments, query, tab]);
  const toggleFavorite = (value: string) => setFavorites((current) => { const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value]; localStorage.setItem(`discipline-favorites-${exchange}`, JSON.stringify(next)); return next; });
  const preferredExchange = (assetClass: AssetClass): ExchangeId => assetClass === "crypto" ? routing.cryptoExchange : assetClass === "stock" ? routing.stockExchange : assetClass === "oil" ? routing.oilExchange : routing.preciousMetalExchange;
  return <aside className={`market-sidebar panel ${open ? "drawer-open" : ""}`} aria-hidden={!open}>
    <div className="sidebar-title"><span>合约市场 <small>{instruments.length} 个</small></span><button aria-label="关闭合约市场" onClick={onClose}><X size={16} /></button></div>
    <div className="market-search"><Search size={13} /><input aria-label="搜索合约" placeholder="搜索合约" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    <div className="market-tabs"><button className={tab === "favorites" ? "active" : ""} onClick={() => setTab("favorites")}>收藏</button><button className={tab === "crypto" ? "active" : ""} onClick={() => setTab("crypto")}>加密</button><button className={tab === "stock" ? "active" : ""} onClick={() => setTab("stock")}>股票</button><button className={tab === "commodity" ? "active" : ""} onClick={() => setTab("commodity")}>商品</button></div>
    <div className="market-head"><span>交易对</span><span>最新价</span><span>24h</span></div>
    <div className="market-list">{visible.length ? visible.map((item) => {
      const active = symbol === item.symbol; const favorite = favorites.includes(item.symbol); const change = active ? Number(market.ticker.change24h) : null;
      const targetExchange = preferredExchange(item.assetClass);
      return <div role="button" tabIndex={0} className={`market-row ${active ? "active" : ""}`} key={item.symbol} onClick={() => onSelect(targetExchange, item.symbol)} onKeyDown={(event) => { if (event.key === "Enter") onSelect(targetExchange, item.symbol); }}>
        <span className="market-name"><button className="market-star" aria-label={favorite ? "取消收藏" : "添加收藏"} onClick={(event) => { event.stopPropagation(); toggleFavorite(item.symbol); }}><Star size={11} fill={favorite ? "#f2b74a" : "transparent"} color={favorite ? "#f2b74a" : "#596576"} /></button><b>{item.baseAsset}</b><small>{assetLabel(item.assetClass)} · {targetExchange === "mexc" ? "M" : "O"}</small></span>
        <span>{active ? Number(market.ticker.last).toLocaleString(undefined, { maximumFractionDigits: 8 }) : "—"}</span>
        <span className={change === null ? "" : change >= 0 ? "up" : "down"}>{change === null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</span>
      </div>;
    }) : <div className="market-list-empty">没有匹配的合约</div>}</div>
    <div className="sidebar-footer"><span className={`status-dot ${market.connected ? "" : "down"}`} /> {exchange === "mexc" ? "MEXC" : "Ourbit"} {market.connected ? "行情已连接" : "等待真实行情"}</div>
  </aside>;
}

function assetLabel(value: AssetClass): string { return ({ crypto: "加密", stock: "股票", oil: "原油", precious_metal: "贵金属" } as Record<AssetClass, string>)[value]; }

function loadFavorites(exchange: ExchangeId): string[] {
  try { const value = localStorage.getItem(`discipline-favorites-${exchange}`); return value ? JSON.parse(value) as string[] : ["BTC_USDT", "ETH_USDT", "SOL_USDT"]; }
  catch { return ["BTC_USDT", "ETH_USDT", "SOL_USDT"]; }
}
