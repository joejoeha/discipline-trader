import { useCallback, useEffect, useRef, useState } from "react";
import {
  CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries,
  type IChartApi, type ISeriesApi, type MouseEventParams, type Time, type UTCTimestamp
} from "lightweight-charts";
import { BarChart3, ChevronDown, Columns2, Eraser, Grid2X2, LayoutPanelTop, Save, Trash2, Undo2 } from "lucide-react";
import { atr, bollinger, ema, macd, rsi, sma, stochRsi, vwap } from "../lib/indicators";
import type { Candle, ChartDrawing, DrawingTool, IndicatorSettings, MarketSnapshot, Timeframe } from "../types";
import { DEFAULT_INDICATORS, normalizeIndicatorSettings } from "../types";
import { gateway } from "../store";
import type { ChartTemplate } from "../gateway/TradingGateway";
import { MARKET_WORKSPACE_TABS, MarketReferencePanel, type MarketWorkspaceTab } from "./MarketReferencePanel";

const periods: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];
const drawingTools: Array<{ value: DrawingTool; label: string; title: string }> = [
  { value: "cursor", label: "↖", title: "光标" }, { value: "trend", label: "╱", title: "趋势线" }, { value: "horizontal", label: "—", title: "水平线" },
  { value: "vertical", label: "│", title: "垂直线" }, { value: "ray", label: "↗", title: "射线" }, { value: "rectangle", label: "▭", title: "矩形" },
  { value: "text", label: "T", title: "文字标记" }, { value: "fibonacci", label: "Fib", title: "斐波那契回撤" }, { value: "measure", label: "量", title: "价格测量" }, { value: "long_rr", label: "多", title: "多单盈亏比" }, { value: "short_rr", label: "空", title: "空单盈亏比" }
];

interface Props {
  market: MarketSnapshot;
  timeframe: Timeframe;
  onTimeframe: (value: Timeframe) => void;
  layout: 1 | 2 | 4;
  onLayout: (layout: 1 | 2 | 4) => void;
}

interface ChartHandle { chart: IChartApi; series: ISeriesApi<"Candlestick"> }

export function ChartPanel({ market, timeframe, onTimeframe, layout, onLayout }: Props) {
  const [indicators, setIndicators] = useState<IndicatorSettings>(() => {
    try { return normalizeIndicatorSettings(JSON.parse(localStorage.getItem("chart-indicators") || "null") as Partial<IndicatorSettings> | undefined); }
    catch { return normalizeIndicatorSettings(DEFAULT_INDICATORS); }
  });
  const [indicatorOpen, setIndicatorOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<MarketWorkspaceTab>("chart");
  const [tool, setTool] = useState<DrawingTool>("cursor");
  const [drawings, setDrawings] = useState<ChartDrawing[]>(() => {
    try { return JSON.parse(localStorage.getItem("chart-drawings") || "[]") as ChartDrawing[]; } catch { return []; }
  });
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [templates, setTemplates] = useState<ChartTemplate[]>([]);
  const [templateStatus, setTemplateStatus] = useState("");
  const chartArea = useRef<HTMLDivElement>(null);
  const chartHandles = useRef(new Map<number, ChartHandle>());
  const syncingCrosshair = useRef(false);

  useEffect(() => { void gateway.listChartTemplates().then(setTemplates); }, []);
  useEffect(() => { localStorage.setItem("chart-indicators", JSON.stringify(indicators)); }, [indicators]);
  useEffect(() => { const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") { setStart(null); setTool((current) => current === "delete" ? "cursor" : current); } }; window.addEventListener("keydown", cancel); return () => window.removeEventListener("keydown", cancel); }, []);

  const registerChart = useCallback((index: number, handle: ChartHandle | null) => {
    if (handle) chartHandles.current.set(index, handle); else chartHandles.current.delete(index);
  }, []);
  const syncCrosshair = useCallback((sourceIndex: number, param: MouseEventParams<Time>) => {
    if (syncingCrosshair.current) return;
    const source = chartHandles.current.get(sourceIndex);
    const data = source ? param.seriesData.get(source.series) as { close?: number; value?: number } | undefined : undefined;
    const price = data?.close ?? data?.value;
    syncingCrosshair.current = true;
    chartHandles.current.forEach((target, index) => {
      if (index === sourceIndex) return;
      if (param.time === undefined || price === undefined) target.chart.clearCrosshairPosition();
      else target.chart.setCrosshairPosition(price, param.time, target.series);
    });
    syncingCrosshair.current = false;
  }, []);

  const saveTemplate = async () => {
    const template = await gateway.saveChartTemplate({ id: crypto.randomUUID(), name: `模板 ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, layout, indicators, drawingsJson: JSON.stringify(drawings) });
    setTemplates((values) => [...values, template]); setTemplateStatus("模板已保存"); window.setTimeout(() => setTemplateStatus(""), 1800);
  };
  const loadTemplate = (id: string) => {
    const template = templates.find((item) => item.id === id); if (!template) return;
    setIndicators(normalizeIndicatorSettings(template.indicators)); onLayout(template.layout);
    try { const saved = JSON.parse(template.drawingsJson) as ChartDrawing[]; setDrawings(saved); localStorage.setItem("chart-drawings", template.drawingsJson); } catch { setDrawings([]); }
    setTemplateStatus(`已加载「${template.name}」`); window.setTimeout(() => setTemplateStatus(""), 1800);
  };

  const persistDrawings = (next: ChartDrawing[]) => {
    setDrawings(next);
    if (next.length) localStorage.setItem("chart-drawings", JSON.stringify(next));
    else localStorage.removeItem("chart-drawings");
  };
  const addDrawing = (event: React.MouseEvent<HTMLDivElement>) => {
    if (tool === "cursor" || !chartArea.current) return;
    const rect = chartArea.current.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (tool === "delete") {
      const target = findDrawingAtPoint(drawings, market, rect, point);
      if (target) persistDrawings(drawings.filter((drawing) => drawing.id !== target.id));
      return;
    }
    if (!start) { setStart(point); return; }
    const toDomain = ({ x, y }: { x: number; y: number }) => ({
      time: market.candles[Math.max(0, Math.min(market.candles.length - 1, Math.round(x / rect.width * market.candles.length)))].time,
      price: Number(market.ticker.last) * (1 + (rect.height / 2 - y) / rect.height * 0.08)
    });
    const next = [...drawings, { id: crypto.randomUUID(), tool, points: [toDomain(start), toDomain(point)], color: tool.includes("short") ? "#f05267" : "#f4b63e", createdAt: Date.now() }];
    persistDrawings(next); setStart(null);
  };

  return <section className="chart-shell panel">
    <div className="market-workspace-tabs">{MARKET_WORKSPACE_TABS.map((item) => <button key={item.value} className={workspaceTab === item.value ? "active" : ""} onClick={() => { setWorkspaceTab(item.value); setIndicatorOpen(false); }}>{item.label}</button>)}</div>
    {workspaceTab === "chart" ? <>
    <div className="chart-topbar">
      <div className="timeframes">{periods.map((period) => <button key={period} className={period === timeframe ? "active" : ""} onClick={() => onTimeframe(period)}>{period}</button>)}</div>
      <div className="chart-actions">
        {templates.length > 0 && <select aria-label="图表模板" defaultValue="" onChange={(event) => { loadTemplate(event.target.value); event.target.value = ""; }}><option value="" disabled>图表模板</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select>}
        {templateStatus && <small>{templateStatus}</small>}
        <div className="popover-anchor"><button className={indicatorOpen ? "active" : ""} onClick={() => setIndicatorOpen(!indicatorOpen)}><BarChart3 size={14} /> 指标 <ChevronDown size={13} /></button>{indicatorOpen && <IndicatorMenu settings={indicators} onChange={setIndicators} />}</div>
        <button title="单图" className={layout === 1 ? "active" : ""} onClick={() => onLayout(1)}><LayoutPanelTop size={15} /></button>
        <button title="双图" className={layout === 2 ? "active" : ""} onClick={() => onLayout(2)}><Columns2 size={15} /></button>
        <button title="四图" className={layout === 4 ? "active" : ""} onClick={() => onLayout(4)}><Grid2X2 size={15} /></button>
        <button title="保存当前图表模板" onClick={() => void saveTemplate()}><Save size={14} /></button>
      </div>
    </div>
    <div className="chart-workspace">
      <div className="drawing-bar">{drawingTools.map((item) => <button key={item.value} title={item.title} className={tool === item.value ? "active" : ""} onClick={() => { setTool(item.value); setStart(null); }}>{item.label}</button>)}<button title="删除单个画图" className={tool === "delete" ? "active delete-tool" : "delete-tool"} disabled={!drawings.length} onClick={() => { setTool(tool === "delete" ? "cursor" : "delete"); setStart(null); }}><Eraser size={14} /></button><span /><button title="撤销上一个画图" disabled={!drawings.length} onClick={() => persistDrawings(drawings.slice(0, -1))}><Undo2 size={14} /></button><button title="清空全部画图" disabled={!drawings.length} onClick={() => persistDrawings([])}><Trash2 size={14} /></button></div>
      <div ref={chartArea} className={`chart-grid layout-${layout} ${tool === "delete" ? "delete-mode" : ""}`} onClick={addDrawing}>
        {Array.from({ length: layout }, (_, index) => <ChartCanvas key={`${market.instrument.exchange}-${market.instrument.symbol}-${index}-${timeframe}`} index={index} market={market} indicators={indicators} compact={layout > 1} register={registerChart} onCrosshair={syncCrosshair} />)}
        <DrawingLayer drawings={drawings} market={market} />
        {tool === "delete" && <div className="drawing-hint delete-hint">删除模式 · 点击要移除的画线 · Esc 退出</div>}
        {start && <div className="drawing-hint">选择终点 · Esc 取消</div>}
      </div>
    </div>
    </> : <MarketReferencePanel tab={workspaceTab} market={market} timeframe={timeframe} />}
  </section>;
}

function ChartCanvas({ index, market, indicators, compact, register, onCrosshair }: { index: number; market: MarketSnapshot; indicators: IndicatorSettings; compact: boolean; register: (index: number, handle: ChartHandle | null) => void; onCrosshair: (index: number, param: MouseEventParams<Time>) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const renderDataRef = useRef<((candles: Candle[]) => void) | null>(null);
  const latestCandlesRef = useRef(market.candles);
  latestCandlesRef.current = market.candles;
  const candleVersion = candleDataVersion(market.candles);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#7d8798", fontFamily: "Inter, Segoe UI, sans-serif", panes: { separatorColor: "#edf0f2", separatorHoverColor: "#dfe4e8", enableResize: true } },
      grid: { vertLines: { color: "#f0f2f4" }, horzLines: { color: "#f0f2f4" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#98a2b1", labelBackgroundColor: "#525d6d" }, horzLine: { color: "#98a2b1", labelBackgroundColor: "#525d6d" } },
      rightPriceScale: { borderColor: "#e6e9ec" }, timeScale: { borderColor: "#e6e9ec", timeVisible: true, secondsVisible: false },
      handleScroll: { vertTouchDrag: true }, handleScale: true
    });
    const candle = chart.addSeries(CandlestickSeries, { upColor: "#00b578", downColor: "#f04455", wickUpColor: "#00b578", wickDownColor: "#f04455", borderVisible: false, priceLineVisible: true, priceLineColor: "#87919f" });
    const dataUpdaters: Array<(candles: Candle[]) => void> = [];
    if (indicators.volume) {
      const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", color: "#2a8f79", priceLineVisible: false, lastValueVisible: false });
      volume.priceScale().applyOptions({ scaleMargins: { top: compact ? 0.86 : 0.8, bottom: 0 } });
      dataUpdaters.push((candles) => volume.setData(candles.map((item) => ({ time: item.time as UTCTimestamp, value: item.volume, color: item.close >= item.open ? "#73d8b4aa" : "#f49aa5aa" }))));
    }
    indicators.ma.forEach((period, lineIndex) => addLineUpdater(chart, dataUpdaters, (candles) => sma(candles, period), ["#e6b64d", "#7da0ff", "#c176e7"][lineIndex % 3], `MA${period}`));
    indicators.ema.forEach((period, lineIndex) => addLineUpdater(chart, dataUpdaters, (candles) => ema(candles, period), ["#4fd1c5", "#f7905c"][lineIndex % 2], `EMA${period}`));
    if (indicators.vwap) addLineUpdater(chart, dataUpdaters, vwap, "#c084fc", "VWAP");
    if (indicators.bollinger.enabled) {
      (["upper", "middle", "lower"] as const).forEach((key, lineIndex) => addLineUpdater(chart, dataUpdaters, (candles) => bollinger(candles, indicators.bollinger.period, indicators.bollinger.deviation).map((item) => ({ time: item.time, value: item[key] })), ["#6d7b91", "#a8b3c3", "#6d7b91"][lineIndex], `BOLL ${key}`));
    }
    let pane = 1;
    if (indicators.rsi.enabled) addLineUpdater(chart, dataUpdaters, (candles) => rsi(candles, indicators.rsi.period), "#b889ff", "RSI", pane++);
    if (indicators.stochRsi.enabled) {
      const stochValues = (candles: Candle[]) => stochRsi(candles, indicators.stochRsi.rsiPeriod, indicators.stochRsi.stochPeriod, indicators.stochRsi.kSmooth, indicators.stochRsi.dSmooth);
      addLineUpdater(chart, dataUpdaters, (candles) => stochValues(candles).map((item) => ({ time: item.time, value: item.k })), "#4bc0ff", "%K", pane);
      addLineUpdater(chart, dataUpdaters, (candles) => stochValues(candles).map((item) => ({ time: item.time, value: item.d })), "#f4a340", "%D", pane);
      addLineUpdater(chart, dataUpdaters, (candles) => thresholdLine(stochValues(candles), 80), "#6b3f4a", "超买 80", pane);
      addLineUpdater(chart, dataUpdaters, (candles) => thresholdLine(stochValues(candles), 20), "#315c54", "超卖 20", pane);
      pane += 1;
    }
    if (indicators.macd.enabled) {
      const macdValues = (candles: Candle[]) => macd(candles, indicators.macd.fast, indicators.macd.slow, indicators.macd.signal);
      addLineUpdater(chart, dataUpdaters, (candles) => macdValues(candles).map((item) => ({ time: item.time, value: item.macd })), "#4bc0ff", "MACD", pane);
      addLineUpdater(chart, dataUpdaters, (candles) => macdValues(candles).map((item) => ({ time: item.time, value: item.signal })), "#f4a340", "Signal", pane++);
    }
    if (indicators.atr.enabled) addLineUpdater(chart, dataUpdaters, (candles) => atr(candles, indicators.atr.period), "#f26d91", "ATR", pane);
    const renderData = (candles: Candle[]) => {
      candle.setData(candles.map((item) => ({ ...item, time: item.time as UTCTimestamp })));
      dataUpdaters.forEach((update) => update(candles));
    };
    renderDataRef.current = renderData;
    renderData(latestCandlesRef.current);
    const crosshairHandler = (param: MouseEventParams<Time>) => onCrosshair(index, param);
    chart.subscribeCrosshairMove(crosshairHandler);
    register(index, { chart, series: candle });
    chart.timeScale().fitContent(); chartRef.current = chart; seriesRef.current = candle;
    return () => { chart.unsubscribeCrosshairMove(crosshairHandler); register(index, null); renderDataRef.current = null; chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, [indicators, compact, index, register, onCrosshair]);

  useEffect(() => {
    renderDataRef.current?.(latestCandlesRef.current);
  }, [candleVersion]);

  return <div ref={ref} className="chart-canvas" />;
}

function addLineUpdater(chart: IChartApi, updaters: Array<(candles: Candle[]) => void>, calculate: (candles: Candle[]) => Array<{ time: number; value: number }>, color: string, title: string, paneIndex = 0) {
  const line = chart.addSeries(LineSeries, { color, lineWidth: 1, title, priceLineVisible: false, lastValueVisible: paneIndex === 0 }, paneIndex);
  updaters.push((candles) => line.setData(calculate(candles).map((point) => ({ time: point.time as Time, value: point.value }))));
}

function thresholdLine(points: Array<{ time: number }>, value: number) {
  if (points.length < 2) return [];
  return [{ time: points[0].time, value }, { time: points.at(-1)!.time, value }];
}

export function candleDataVersion(candles: Candle[]) {
  const first = candles[0];
  const last = candles.at(-1);
  if (!first || !last) return "empty";
  return `${candles.length}:${first.time}:${last.time}:${last.open}:${last.high}:${last.low}:${last.close}:${last.volume}`;
}

function IndicatorMenu({ settings, onChange }: { settings: IndicatorSettings; onChange: (value: IndicatorSettings) => void }) {
  const toggle = (key: "vwap" | "volume") => onChange({ ...settings, [key]: !settings[key] });
  return <div className="indicator-menu popover">
    <div className="indicator-menu-title"><strong>指标与参数</strong><small>回车或离开输入框后应用</small></div>
    <IndicatorRow title="成交量" subtitle="主图底部" enabled={settings.volume} onToggle={() => toggle("volume")} />
    <IndicatorRow title="MA" subtitle="主图叠加" enabled={settings.ma.length > 0} onToggle={() => onChange({ ...settings, ma: settings.ma.length ? [] : [20, 60] })}>
      <PeriodListInput label="周期" values={settings.ma.length ? settings.ma : [20, 60]} disabled={!settings.ma.length} onChange={(ma) => onChange({ ...settings, ma })} />
    </IndicatorRow>
    <IndicatorRow title="EMA" subtitle="主图叠加" enabled={settings.ema.length > 0} onToggle={() => onChange({ ...settings, ema: settings.ema.length ? [] : [12, 26] })}>
      <PeriodListInput label="周期" values={settings.ema.length ? settings.ema : [12, 26]} disabled={!settings.ema.length} onChange={(ema) => onChange({ ...settings, ema })} />
    </IndicatorRow>
    <IndicatorRow title="布林带" subtitle="主图叠加" enabled={settings.bollinger.enabled} onToggle={() => onChange({ ...settings, bollinger: { ...settings.bollinger, enabled: !settings.bollinger.enabled } })}>
      <NumericParam label="周期" value={settings.bollinger.period} disabled={!settings.bollinger.enabled} min={1} max={500} onChange={(period) => onChange({ ...settings, bollinger: { ...settings.bollinger, period } })} />
      <NumericParam label="标准差" value={settings.bollinger.deviation} disabled={!settings.bollinger.enabled} min={0.1} max={10} step={0.1} integer={false} onChange={(deviation) => onChange({ ...settings, bollinger: { ...settings.bollinger, deviation } })} />
    </IndicatorRow>
    <IndicatorRow title="VWAP" subtitle="主图叠加" enabled={settings.vwap} onToggle={() => toggle("vwap")} />
    <IndicatorRow title="RSI" subtitle="独立副图" enabled={settings.rsi.enabled} onToggle={() => onChange({ ...settings, rsi: { ...settings.rsi, enabled: !settings.rsi.enabled } })}>
      <NumericParam label="周期" value={settings.rsi.period} disabled={!settings.rsi.enabled} min={1} max={500} onChange={(period) => onChange({ ...settings, rsi: { ...settings.rsi, period } })} />
    </IndicatorRow>
    <IndicatorRow title="StochRSI" subtitle="独立副图 · 20/80" enabled={settings.stochRsi.enabled} onToggle={() => onChange({ ...settings, stochRsi: { ...settings.stochRsi, enabled: !settings.stochRsi.enabled } })}>
      <NumericParam label="RSI周期" value={settings.stochRsi.rsiPeriod} disabled={!settings.stochRsi.enabled} min={1} max={500} onChange={(rsiPeriod) => onChange({ ...settings, stochRsi: { ...settings.stochRsi, rsiPeriod } })} />
      <NumericParam label="随机周期" value={settings.stochRsi.stochPeriod} disabled={!settings.stochRsi.enabled} min={1} max={500} onChange={(stochPeriod) => onChange({ ...settings, stochRsi: { ...settings.stochRsi, stochPeriod } })} />
      <NumericParam label="K平滑" value={settings.stochRsi.kSmooth} disabled={!settings.stochRsi.enabled} min={1} max={100} onChange={(kSmooth) => onChange({ ...settings, stochRsi: { ...settings.stochRsi, kSmooth } })} />
      <NumericParam label="D平滑" value={settings.stochRsi.dSmooth} disabled={!settings.stochRsi.enabled} min={1} max={100} onChange={(dSmooth) => onChange({ ...settings, stochRsi: { ...settings.stochRsi, dSmooth } })} />
    </IndicatorRow>
    <IndicatorRow title="MACD" subtitle="独立副图" enabled={settings.macd.enabled} onToggle={() => onChange({ ...settings, macd: { ...settings.macd, enabled: !settings.macd.enabled } })}>
      <NumericParam label="快线" value={settings.macd.fast} disabled={!settings.macd.enabled} min={1} max={500} onChange={(fast) => onChange({ ...settings, macd: { ...settings.macd, fast } })} />
      <NumericParam label="慢线" value={settings.macd.slow} disabled={!settings.macd.enabled} min={1} max={500} onChange={(slow) => onChange({ ...settings, macd: { ...settings.macd, slow } })} />
      <NumericParam label="信号" value={settings.macd.signal} disabled={!settings.macd.enabled} min={1} max={500} onChange={(signal) => onChange({ ...settings, macd: { ...settings.macd, signal } })} />
    </IndicatorRow>
    <IndicatorRow title="ATR" subtitle="独立副图" enabled={settings.atr.enabled} onToggle={() => onChange({ ...settings, atr: { ...settings.atr, enabled: !settings.atr.enabled } })}>
      <NumericParam label="周期" value={settings.atr.period} disabled={!settings.atr.enabled} min={1} max={500} onChange={(period) => onChange({ ...settings, atr: { ...settings.atr, period } })} />
    </IndicatorRow>
  </div>;
}

function IndicatorRow({ title, subtitle, enabled, onToggle, children }: { title: string; subtitle: string; enabled: boolean; onToggle: () => void; children?: React.ReactNode }) {
  return <div className={`indicator-setting ${enabled ? "enabled" : ""}`}><label className="indicator-toggle"><input type="checkbox" checked={enabled} onChange={onToggle} /><span><b>{title}</b><small>{subtitle}</small></span></label>{children && <div className="indicator-params">{children}</div>}</div>;
}

function NumericParam({ label, value, disabled, min, max, step = 1, integer = true, onChange }: { label: string; value: number; disabled: boolean; min: number; max: number; step?: number; integer?: boolean; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => { const parsed = Number(draft); const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, integer ? Math.round(parsed) : parsed)) : value; setDraft(String(next)); onChange(next); };
  return <label className="indicator-param"><span>{label}</span><input aria-label={`${label}参数`} type="number" value={draft} min={min} max={max} step={step} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

function PeriodListInput({ label, values, disabled, onChange }: { label: string; values: number[]; disabled: boolean; onChange: (value: number[]) => void }) {
  const serialized = values.join(", "); const [draft, setDraft] = useState(serialized);
  useEffect(() => setDraft(serialized), [serialized]);
  const commit = () => { const next = [...new Set(draft.split(/[,，\s]+/).map(Number).filter((value) => Number.isInteger(value) && value > 0 && value <= 500))].slice(0, 5); const valid = next.length ? next : values; setDraft(valid.join(", ")); onChange(valid); };
  return <label className="indicator-param wide"><span>{label}</span><input aria-label={`${label}参数`} value={draft} disabled={disabled} placeholder="20, 60" onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

function findDrawingAtPoint(drawings: ChartDrawing[], market: MarketSnapshot, rect: DOMRect, point: { x: number; y: number }): ChartDrawing | undefined {
  if (!drawings.length || !market.candles.length) return undefined;
  const minTime = market.candles[0].time; const maxTime = market.candles.at(-1)!.time;
  const timeRange = Math.max(1, maxTime - minTime); const last = Number(market.ticker.last);
  const minPrice = last * .96; const maxPrice = last * 1.04; const priceRange = Math.max(Number.EPSILON, maxPrice - minPrice);
  const screenPoint = (drawing: ChartDrawing, index: number) => ({
    x: (drawing.points[index].time - minTime) / timeRange * rect.width,
    y: (maxPrice - drawing.points[index].price) / priceRange * rect.height
  });
  let nearest: { drawing: ChartDrawing; distance: number } | undefined;
  drawings.forEach((drawing) => {
    if (drawing.points.length < 2) return;
    const a = screenPoint(drawing, 0); const b = screenPoint(drawing, 1); let distance = Number.POSITIVE_INFINITY;
    if (drawing.tool === "horizontal") distance = Math.abs(point.y - a.y);
    else if (drawing.tool === "vertical") distance = Math.abs(point.x - a.x);
    else if (drawing.tool === "text") distance = Math.hypot(point.x - a.x, point.y - a.y);
    else if (drawing.tool === "ray") {
      const end = Math.abs(b.x - a.x) < .01 ? { x: a.x, y: rect.height } : { x: rect.width, y: a.y + (b.y - a.y) / (b.x - a.x) * (rect.width - a.x) };
      distance = distanceToSegment(point, a, end);
    } else if (drawing.tool === "fibonacci") {
      const left = Math.min(a.x, b.x); const right = Math.max(a.x, b.x);
      if (point.x >= left - 10 && point.x <= right + 10) distance = Math.min(...[0, .236, .382, .5, .618, .786, 1].map((ratio) => Math.abs(point.y - (a.y + (b.y - a.y) * ratio))));
    } else if (drawing.tool === "rectangle" || drawing.tool.includes("rr")) {
      const left = Math.min(a.x, b.x); const right = Math.max(a.x, b.x); const top = Math.min(a.y, b.y); const bottom = Math.max(a.y, b.y);
      if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) distance = 0;
      else distance = Math.min(distanceToSegment(point, { x: left, y: top }, { x: right, y: top }), distanceToSegment(point, { x: right, y: top }, { x: right, y: bottom }), distanceToSegment(point, { x: right, y: bottom }, { x: left, y: bottom }), distanceToSegment(point, { x: left, y: bottom }, { x: left, y: top }));
    } else distance = distanceToSegment(point, a, b);
    if (!nearest || distance < nearest.distance) nearest = { drawing, distance };
  });
  return nearest && nearest.distance <= 12 ? nearest.drawing : undefined;
}

function distanceToSegment(point: { x: number; y: number }, start: { x: number; y: number }, end: { x: number; y: number }): number {
  const dx = end.x - start.x; const dy = end.y - start.y; const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

function DrawingLayer({ drawings, market }: { drawings: ChartDrawing[]; market: MarketSnapshot }) {
  const minTime = market.candles[0].time; const maxTime = market.candles.at(-1)!.time;
  const last = Number(market.ticker.last); const minPrice = last * 0.96; const maxPrice = last * 1.04;
  const pt = (drawing: ChartDrawing, index: number) => ({
    x: (drawing.points[index].time - minTime) / (maxTime - minTime) * 100,
    y: (maxPrice - drawing.points[index].price) / (maxPrice - minPrice) * 100
  });
  return <svg className="drawing-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{drawings.flatMap((drawing) => {
    if (drawing.points.length < 2) return [];
    const a = pt(drawing, 0); const b = pt(drawing, 1);
    if (drawing.tool === "horizontal") return <line key={drawing.id} x1="0" y1={a.y} x2="100" y2={a.y} stroke={drawing.color} vectorEffect="non-scaling-stroke" />;
    if (drawing.tool === "vertical") return <line key={drawing.id} x1={a.x} y1="0" x2={a.x} y2="100" stroke={drawing.color} vectorEffect="non-scaling-stroke" />;
    if (drawing.tool === "text") return <text key={drawing.id} x={a.x} y={a.y} fill={drawing.color} fontSize="3">注释</text>;
    if (drawing.tool === "ray") { const slope = (b.y - a.y) / Math.max(0.001, b.x - a.x); return <line key={drawing.id} x1={a.x} y1={a.y} x2="100" y2={a.y + slope * (100 - a.x)} stroke={drawing.color} vectorEffect="non-scaling-stroke" />; }
    if (drawing.tool === "fibonacci") return <g key={drawing.id}>{[0, .236, .382, .5, .618, .786, 1].map((ratio) => { const y = a.y + (b.y - a.y) * ratio; return <g key={ratio}><line x1={Math.min(a.x, b.x)} y1={y} x2={Math.max(a.x, b.x)} y2={y} stroke={drawing.color} opacity={ratio === 0 || ratio === 1 ? 1 : .65} vectorEffect="non-scaling-stroke" /><text x={Math.max(a.x, b.x) + .5} y={y} fill={drawing.color} fontSize="2.2">{ratio}</text></g>; })}</g>;
    if (drawing.tool === "rectangle" || drawing.tool.includes("rr")) return <g key={drawing.id}><rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} fill={`${drawing.color}22`} stroke={drawing.color} vectorEffect="non-scaling-stroke" />{drawing.tool.includes("rr") && <line x1={Math.min(a.x, b.x)} y1={(a.y + b.y) / 2} x2={Math.max(a.x, b.x)} y2={(a.y + b.y) / 2} stroke={drawing.color} strokeDasharray="2 1" vectorEffect="non-scaling-stroke" />}</g>;
    if (drawing.tool === "measure") { const delta = drawing.points[1].price - drawing.points[0].price; const percent = drawing.points[0].price ? delta / drawing.points[0].price * 100 : 0; return <g key={drawing.id}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={drawing.color} vectorEffect="non-scaling-stroke" /><text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 1} fill={drawing.color} fontSize="2.4">{delta.toFixed(2)} · {percent.toFixed(2)}%</text></g>; }
    return <line key={drawing.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={drawing.color} vectorEffect="non-scaling-stroke" />;
  })}</svg>;
}
