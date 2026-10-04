import type { ChartTemplate, CredentialInput, TradingGateway } from "./TradingGateway";
import type {
  AccountSnapshot, Balance, BootstrapState, Candle, CredentialStatus, DcaPlan, Direction, EconomicEvent, ExchangeCapabilities,
  ExchangeId, Instrument, MarginMode, MarketSnapshot, OpenOrder, OrderIntent, OrderResult, OrderReview, Position,
  PositionReview, PublicTrade, RiskEvent, RiskSettings, RoutingSettings, Timeframe, TradeFill, TradingAnalytics, TradingPlan
} from "../types";
import { DEFAULT_CHECKLIST } from "../types";
import { evaluateChecklist } from "../lib/checklist";
import { classifyAsset, effectiveFeeProfile, preferredExchange } from "../lib/routing";
import { TauriGateway } from "./TauriGateway";

const STORAGE_KEY = "discipline-trader-demo-v2";
const timeframeSeconds: Record<Timeframe, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400 };

interface DemoState {
  riskSettings: RiskSettings | null;
  routingSettings: RoutingSettings;
  plans: TradingPlan[];
  positions: Position[];
  orders: OpenOrder[];
  reviews: PositionReview[];
  dcaPlans: DcaPlan[];
  templates: ChartTemplate[];
  fills: TradeFill[];
  riskEvents: RiskEvent[];
  balance: number;
  realizedPnl: number;
  emergencyStopped: boolean;
}

const initialState = (): DemoState => ({
  riskSettings: {
    enforceGlobalLimits: true,
    restrictAllowedSymbols: true,
    maxLeverage: 10,
    maxNotional: "10000",
    maxRiskPercent: "1",
    dailyLossLimit: "300",
    allowedSymbols: ["BTC_USDT", "ETH_USDT", "SOL_USDT", "NVDASTOCK_USDT", "TSLASTOCK_USDT", "WTI_USDT", "BRENT_USDT", "XAU_USDT", "XAG_USDT"],
    marketDataTimeoutSeconds: 15,
    maxClockSkewSeconds: 5
  },
  routingSettings: defaultRoutingSettings(),
  plans: [], positions: [], orders: [], reviews: [], dcaPlans: [], templates: [], fills: [], riskEvents: [],
  balance: 10_000, realizedPnl: 0, emergencyStopped: false
});

function load(): DemoState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? { ...initialState(), ...JSON.parse(raw) as DemoState } : initialState();
  } catch { return initialState(); }
}

function persist(state: DemoState): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* preview-only storage can be unavailable */ }
}

function normalizePlan(plan: TradingPlan): TradingPlan {
  return { ...plan, entryReason: plan.entryReason ?? "", takeProfitReason: plan.takeProfitReason ?? "", customQuestions: plan.customQuestions ?? [], answers: plan.answers ?? [] };
}

function basePrice(symbol: string): number {
  if (symbol.includes("WTI")) return 63.8;
  if (symbol.includes("BRENT")) return 67.2;
  if (symbol.includes("XAU") || symbol.includes("GOLD")) return 4647.5;
  if (symbol.includes("XAG") || symbol.includes("SILVER")) return 52.4;
  if (symbol.includes("NVDA")) return 186.2;
  if (symbol.startsWith("ETH")) return 3784.21;
  if (symbol.startsWith("SOL")) return 186.47;
  return 118_642.4;
}

function defaultRoutingSettings(): RoutingSettings { return { cryptoExchange: "ourbit", stockExchange: "mexc", oilExchange: "mexc", preciousMetalExchange: "mexc", mexcFees: { makerPercent: "0.06", takerPercent: "0.08", source: "MEXC API 公告默认值（须按账户复核）" }, ourbitFees: { makerPercent: "0.008", takerPercent: "0.025", source: "用户提供的 Ourbit VIP 费率（须按账户复核）" }, warnOnOverride: true, updatedAt: Date.now() }; }

function symbolFormat(symbol: string, value: number): string {
  return symbol.startsWith("BTC") ? value.toFixed(1) : value.toFixed(2);
}

function generateCandles(symbol: string, timeframe: Timeframe, limit = 360): Candle[] {
  const interval = timeframeSeconds[timeframe];
  const now = Math.floor(Date.now() / 1000 / interval) * interval;
  const base = basePrice(symbol);
  const scale = base * 0.00085;
  let previous = base * 0.976;
  return Array.from({ length: limit }, (_, index) => {
    const time = now - (limit - index) * interval;
    const trend = index * scale * 0.038;
    const wave = Math.sin(index / 8) * scale * 3.2 + Math.sin(index / 23) * scale * 5.4;
    const close = base * 0.976 + trend + wave;
    const open = previous;
    const high = Math.max(open, close) + scale * (0.5 + Math.abs(Math.sin(index * 1.9)));
    const low = Math.min(open, close) - scale * (0.45 + Math.abs(Math.cos(index * 1.6)));
    previous = close;
    return { time, open, high, low, close, volume: 50 + Math.abs(Math.sin(index / 3)) * 290 + (index % 11) * 12 };
  });
}

function capabilities(exchange: ExchangeId): ExchangeCapabilities {
  const mexc = exchange === "mexc";
  return {
    exchange, marketData: true, accountRead: false, liveTrading: false,
    orderTypes: { market: true, limit: true, post_only: true, ioc: true, fok: true, trigger: !mexc, trailing: !mexc },
    supportsReduceOnly: true, supportsTpSl: true, supportsTrailingStop: !mexc,
    supportsHedgeMode: true, supportsCrossMargin: true,
    reason: "浏览器预览未配置 API 凭据；桌面版会按账户权限探测",
    checkedAt: Date.now()
  };
}

function snapshot(exchange: ExchangeId, symbol: string, timeframe: Timeframe): MarketSnapshot {
  const candles = generateCandles(symbol, timeframe);
  const last = candles.at(-1)!.close;
  const spread = last * 0.00008;
  const bids = Array.from({ length: 16 }, (_, index) => ({ price: symbolFormat(symbol, last - spread * (index + 1)), quantity: (0.08 + ((index * 17) % 23) / 10).toFixed(3) }));
  const asks = Array.from({ length: 16 }, (_, index) => ({ price: symbolFormat(symbol, last + spread * (index + 1)), quantity: (0.12 + ((index * 13) % 19) / 10).toFixed(3) }));
  const trades: PublicTrade[] = Array.from({ length: 25 }, (_, index) => ({
    id: `demo-${index}`, time: Date.now() - index * 1300,
    price: symbolFormat(symbol, last + Math.sin(index * 2.7) * spread * 5),
    quantity: (0.002 + ((index * 7) % 31) / 100).toFixed(3), side: index % 3 === 0 ? "sell" : "buy"
  }));
  return {
    instrument: { exchange, symbol, baseAsset: symbol.split("_")[0], quoteAsset: "USDT", assetClass: classifyAsset(symbol), priceTick: symbol.startsWith("BTC") ? "0.1" : "0.01", quantityStep: "0.001", minQuantity: "0.001", contractSize: "1", maxLeverage: 125, status: "online" },
    ticker: { symbol, last: symbolFormat(symbol, last), change24h: "+2.84", high24h: symbolFormat(symbol, last * 1.017), low24h: symbolFormat(symbol, last * 0.972), volume24h: "1.28B", fundingRate: "0.0100", nextFundingAt: Date.now() + 3_640_000, markPrice: symbolFormat(symbol, last * 0.99998), indexPrice: symbolFormat(symbol, last * 1.00002) },
    candles, depth: { symbol, sequence: Date.now(), updatedAt: Date.now(), bids, asks }, trades,
    connected: true, source: "demo"
  };
}

export class DemoGateway implements TradingGateway {
  private state = load();
  private reviews = new Map<string, OrderReview>();
  private unlockedUntil = 0;

  async bootstrap(): Promise<BootstrapState> {
    return {
      mode: "paper", selectedExchange: "ourbit", selectedSymbol: "BTC_USDT",
      capabilities: [capabilities("mexc"), capabilities("ourbit")],
      credentials: ["mexc", "ourbit"].map((exchange) => ({ exchange: exchange as ExchangeId, configured: false, verified: false, permissions: [], message: "尚未配置" })),
      riskSettings: this.state.riskSettings,
      routingSettings: this.state.routingSettings,
      liveLock: { locked: Date.now() >= this.unlockedUntil, emergencyStopped: this.state.emergencyStopped, reasons: this.state.emergencyStopped ? ["已触发立即停止实盘"] : ["预览模式不发送真实订单"] },
      plans: this.state.plans.map(normalizePlan), positions: this.state.positions, orders: this.state.orders,
      balances: [{ asset: "USDT", total: this.state.balance.toFixed(2), available: (this.state.balance - this.state.positions.reduce((sum, p) => sum + Number(p.quantity) * Number(p.entryPrice) / p.leverage, 0)).toFixed(2), unrealizedPnl: this.state.positions.reduce((sum, p) => sum + Number(p.unrealizedPnl), 0).toFixed(2) }],
      fills: this.state.fills, reviews: this.state.reviews, riskEvents: this.state.riskEvents
    };
  }
  async getCapabilities(exchange: ExchangeId): Promise<ExchangeCapabilities> { return capabilities(exchange); }
  async getMarket(exchange: ExchangeId, symbol: string, timeframe: Timeframe): Promise<MarketSnapshot> { return snapshot(exchange, symbol, timeframe); }
  async getKlines(_exchange: ExchangeId, symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> { return generateCandles(symbol, timeframe, limit); }
  async getInstruments(exchange: ExchangeId): Promise<Instrument[]> { const symbols = exchange === "mexc" ? ["BTC_USDT", "ETH_USDT", "SOL_USDT", "NVDASTOCK_USDT", "TSLASTOCK_USDT", "OIL(WTI)_USDT", "OIL(BRENT)_USDT", "GOLD(XAU)_USDT", "SILVER(XAG)_USDT"] : ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "DOGE_USDT", "HYPE_USDT"]; return symbols.map((symbol) => snapshot(exchange, symbol, "15m").instrument); }
  async syncLiveAccount(exchange: ExchangeId): Promise<AccountSnapshot> { return { exchange, balances: [{ asset: "USDT", total: this.state.balance.toFixed(2), available: this.state.balance.toFixed(2), unrealizedPnl: "0" }], positions: this.state.positions, orders: this.state.orders, syncedAt: Date.now() }; }
  async setExchangeLeverage(_exchange: ExchangeId, _symbol: string, _leverage: number, _direction: Direction): Promise<void> { throw new Error("浏览器预览不支持实盘杠杆设置"); }
  async setExchangeMarginMode(_exchange: ExchangeId, _symbol: string, _mode: MarginMode): Promise<void> { throw new Error("浏览器预览不支持实盘保证金模式设置"); }
  async subscribeMarket(exchange: ExchangeId, symbol: string, timeframe: Timeframe, listener: (value: MarketSnapshot) => void): Promise<() => void> {
    let current = snapshot(exchange, symbol, timeframe);
    listener(current);
    const timer = globalThis.setInterval(() => {
      const jitter = (Math.random() - 0.48) * basePrice(symbol) * 0.00015;
      const candle = current.candles.at(-1)!;
      const nextClose = Math.max(0.001, candle.close + jitter);
      const updated = { ...candle, high: Math.max(candle.high, nextClose), low: Math.min(candle.low, nextClose), close: nextClose, volume: candle.volume + Math.random() * 8 };
      current = snapshot(exchange, symbol, timeframe);
      current.candles[current.candles.length - 1] = updated;
      current.ticker.last = symbolFormat(symbol, nextClose);
      listener(current);
    }, 1400);
    return () => globalThis.clearInterval(timer);
  }
  async saveCredentials(input: CredentialInput): Promise<CredentialStatus> {
    if (input.declaredPermissions.includes("withdraw")) throw new Error("检测到提现权限，拒绝保存。请在交易所创建仅只读和交易权限的 Key。 ");
    throw new Error("浏览器预览不会保存 API Key；请在 Windows 桌面版设置中录入");
  }
  async removeCredentials(): Promise<void> { return; }
  async saveRiskSettings(settings: RiskSettings): Promise<RiskSettings> {
    if (settings.enforceGlobalLimits && (settings.maxLeverage < 1 || settings.maxNotional === "" || settings.dailyLossLimit === "")) throw new Error("设限模式下必须填写有效的全局风险参数");
    if (settings.restrictAllowedSymbols && settings.allowedSymbols.length === 0) throw new Error("合约设限模式下至少添加一个允许交易的合约");
    this.state.riskSettings = settings; persist(this.state); return settings;
  }
  async saveRoutingSettings(settings: RoutingSettings): Promise<RoutingSettings> { this.state.routingSettings = { ...settings, updatedAt: Date.now() }; persist(this.state); return this.state.routingSettings; }
  async setPin(pin: string): Promise<void> { if (!/^\d{6,12}$/.test(pin)) throw new Error("PIN 必须为 6–12 位数字"); }
  async unlockLive(_pin: string): Promise<void> { throw new Error("浏览器预览禁止实盘；请使用桌面版"); }
  async lockLive(_reason?: string): Promise<void> { this.unlockedUntil = 0; }
  async emergencyStop(): Promise<void> { this.state.emergencyStopped = true; persist(this.state); }
  async clearEmergencyStop(_pin: string): Promise<void> { this.state.emergencyStopped = false; persist(this.state); }
  async listPlans(): Promise<TradingPlan[]> { return this.state.plans.map(normalizePlan); }
  async savePlan(plan: TradingPlan): Promise<TradingPlan> {
    const now = Date.now();
    const saved = normalizePlan({ ...plan, id: plan.id || crypto.randomUUID(), createdAt: plan.createdAt || now, updatedAt: now, status: plan.status || "draft" });
    this.state.plans = [...this.state.plans.filter((item) => item.id !== saved.id), saved]; persist(this.state); return saved;
  }
  async armPlan(planId: string): Promise<TradingPlan> {
    const plan = this.requirePlan(planId); const updated = { ...plan, status: "armed" as const, armedAt: Date.now(), updatedAt: Date.now() };
    if (!plan.stopLoss || !plan.targets.length || !plan.entryReason.trim() || !plan.takeProfitReason.trim()) throw new Error("启用前必须填写止损、目标位、下单原因和止盈原因");
    return this.savePlan(updated);
  }
  async triggerPlan(planId: string): Promise<TradingPlan> {
    const plan = this.requirePlan(planId);
    if (plan.status !== "armed") throw new Error("只有已启用的计划可以触发");
    const now = Date.now();
    return this.savePlan({ ...plan, status: "triggered", triggeredAt: now, earliestEntryAt: now + plan.cooldownMinutes * 60_000, updatedAt: now });
  }
  async prepareOrder(intent: OrderIntent): Promise<OrderReview> {
    const blockedReasons: string[] = [];
    const warnings: string[] = [];
    const settings = this.state.riskSettings;
    const market = snapshot(intent.exchange, intent.symbol, "15m");
    const price = Number(intent.price || market.ticker.last);
    const notional = price * Number(intent.quantity);
    const plan = intent.planId ? this.state.plans.find((item) => item.id === intent.planId) : undefined;
    const checklist = evaluateChecklist(intent.checkMode, plan?.answers ?? [], [...DEFAULT_CHECKLIST, ...(plan?.customQuestions ?? [])]);
    if (intent.action === "open") {
      if (!plan) blockedReasons.push("开仓必须关联交易计划");
      else if (plan.status !== "triggered") blockedReasons.push("交易计划尚未触发");
      else if (!plan.earliestEntryAt || Date.now() < plan.earliestEntryAt) blockedReasons.push(`冷静期尚未结束（${new Date(plan.earliestEntryAt || 0).toLocaleTimeString()} 后可下单）`);
      if (!intent.stopLoss) blockedReasons.push("开仓必须设置止损");
      if (intent.checkMode === "block" && !checklist.passed) blockedReasons.push("纪律问题未全部通过");
    }
    if (settings) {
      if (intent.leverage <= 0) blockedReasons.push("杠杆必须大于 0x");
      if (settings.enforceGlobalLimits && intent.leverage > settings.maxLeverage) blockedReasons.push(`杠杆超过全局上限 ${settings.maxLeverage}x`);
      if (settings.enforceGlobalLimits && notional > Number(settings.maxNotional)) blockedReasons.push(`名义价值超过全局上限 ${settings.maxNotional} USDT`);
      if (settings.restrictAllowedSymbols && !settings.allowedSymbols.includes(intent.symbol)) blockedReasons.push("该合约不在允许交易列表");
      const stopRisk = intent.stopLoss ? Math.abs(price - Number(intent.stopLoss)) * Number(intent.quantity) : 0;
      if (settings.enforceGlobalLimits && stopRisk > this.state.balance * Number(settings.maxRiskPercent) / 100) blockedReasons.push("止损最大亏损超过单笔风险比例");
      if (settings.enforceGlobalLimits && Math.min(0, this.state.realizedPnl) <= -Number(settings.dailyLossLimit)) blockedReasons.push("今日亏损额度已用尽，只允许减仓或平仓");
    } else if (intent.mode === "live") blockedReasons.push("尚未完成实盘风险设置");
    if (intent.checkMode === "warn" && (checklist.failed.length || checklist.unanswered.length)) warnings.push("纪律清单存在未通过项，提交前需要额外确认");
    const assetClass = classifyAsset(intent.symbol); const routing = this.state.routingSettings;
    const recommendedExchange = preferredExchange(routing, assetClass);
    const feeProfile = effectiveFeeProfile(routing, intent.exchange, assetClass);
    if (intent.action === "open" && routing.warnOnOverride && intent.exchange !== recommendedExchange) warnings.push(`当前交易所偏离默认路由，建议使用 ${recommendedExchange.toUpperCase()}`);
    if (!feeProfile.verifiedAt) warnings.push("当前手续费档案尚未按 API 账户费率页确认，成本仅为估算");
    if (intent.mode === "live") blockedReasons.push("当前为安全预览环境，实盘路径不可用");
    const token = crypto.randomUUID();
    const stopLossValue = intent.stopLoss ? Math.abs(price - Number(intent.stopLoss)) * Number(intent.quantity) : null;
    const review: OrderReview = {
      token, expiresAt: Date.now() + 60_000, intent,
      notional: notional.toFixed(2), marginRequired: (notional / intent.leverage).toFixed(2),
      maxStopLoss: stopLossValue?.toFixed(2) ?? null,
      estimatedLiquidationPrice: (intent.direction === "long" ? price * (1 - 0.9 / intent.leverage) : price * (1 + 0.9 / intent.leverage)).toFixed(2),
      assetClass, recommendedExchange, routeReason: assetClass === "crypto" ? "加密货币合约默认由 Ourbit 处理" : assetClass === "stock" ? "股票合约默认由 MEXC 处理" : assetClass === "oil" ? "原油合约默认由 MEXC 处理" : "贵金属合约默认由 MEXC 处理",
      estimatedMakerFee: (notional * Number(feeProfile.makerPercent) / 100).toFixed(8), estimatedTakerFee: (notional * Number(feeProfile.takerPercent) / 100).toFixed(8), feeProfileVerified: Boolean(feeProfile.verifiedAt),
      fundingRatePercent: market.ticker.fundingRate,
      estimatedFundingFee: (notional * Math.abs(Number(market.ticker.fundingRate)) / 100).toFixed(8),
      checklist, warnings, blockedReasons
    };
    this.reviews.set(token, review); return review;
  }
  async submitOrder(reviewToken: string, warningAccepted: boolean): Promise<OrderResult> {
    const review = this.reviews.get(reviewToken);
    if (!review || review.expiresAt < Date.now()) throw new Error("订单确认已过期，请重新检查");
    this.reviews.delete(reviewToken);
    if (review.blockedReasons.length) throw new Error(review.blockedReasons.join("；"));
    if (review.warnings.length && !warningAccepted) throw new Error("必须确认纪律警告后才能继续");
    const intent = review.intent;
    const market = snapshot(intent.exchange, intent.symbol, "15m");
    const marketPrice = Number(market.ticker.last);
    const isMarket = intent.orderType === "market";
    const fillPrice = isMarket ? marketPrice * (intent.direction === "long" ? 1.0005 : 0.9995) : Number(intent.price);
    const orderId = `P-${Date.now().toString(36).toUpperCase()}`;
    if (isMarket) {
      if (intent.action === "open") this.state.positions.push({ id: crypto.randomUUID(), exchange: intent.exchange, symbol: intent.symbol, direction: intent.direction, quantity: intent.quantity, entryPrice: fillPrice.toFixed(2), markPrice: marketPrice.toFixed(2), liquidationPrice: review.estimatedLiquidationPrice, leverage: intent.leverage, marginMode: intent.marginMode, unrealizedPnl: "0.00", realizedPnl: "0.00", stopLoss: intent.stopLoss, takeProfit: intent.takeProfit });
      else this.state.positions = this.state.positions.filter((item) => item.symbol !== intent.symbol || item.direction !== intent.direction);
      const feeProfile = effectiveFeeProfile(this.state.routingSettings, intent.exchange, classifyAsset(intent.symbol)); const feePercent = intent.orderType === "limit" || intent.orderType === "post_only" ? feeProfile.makerPercent : feeProfile.takerPercent;
      this.state.fills.unshift({ id: crypto.randomUUID(), exchange: intent.exchange, symbol: intent.symbol, mode: "paper", direction: intent.direction, action: intent.action, orderId, clientOrderId: intent.clientOrderId, quantity: intent.quantity, price: fillPrice.toFixed(2), fee: (fillPrice * Number(intent.quantity) * Number(feePercent) / 100).toFixed(8), realizedPnl: "0", createdAt: Date.now() });
    } else {
      this.state.orders.push({ ...intent, orderId, status: "submitted", filledQuantity: "0", createdAt: Date.now() });
    }
    persist(this.state);
    return { accepted: true, orderId, clientOrderId: intent.clientOrderId, state: isMarket ? "filled" : "submitted", message: isMarket ? "模拟成交（含 5bp 滑点）" : "模拟限价单已进入队列", filledQuantity: isMarket ? intent.quantity : "0", averagePrice: isMarket ? fillPrice.toFixed(2) : undefined };
  }
  async cancelOrder(_exchange: ExchangeId, orderId: string): Promise<OrderResult> {
    const order = this.state.orders.find((item) => item.orderId === orderId);
    this.state.orders = this.state.orders.filter((item) => item.orderId !== orderId); persist(this.state);
    return { accepted: Boolean(order), orderId, clientOrderId: order?.clientOrderId ?? "", state: "cancelled", message: order ? "已撤销" : "订单不存在", filledQuantity: order?.filledQuantity ?? "0" };
  }
  async cancelAll(exchange: ExchangeId, symbol?: string): Promise<number> {
    const before = this.state.orders.length;
    this.state.orders = this.state.orders.filter((item) => item.exchange !== exchange || (symbol && item.symbol !== symbol)); persist(this.state); return before - this.state.orders.length;
  }
  async listOrders(): Promise<OpenOrder[]> { return this.state.orders; }
  async savePositionReview(review: PositionReview): Promise<PositionReview> {
    const saved = { ...review, id: review.id || crypto.randomUUID(), createdAt: review.createdAt || Date.now() };
    this.state.reviews = [...this.state.reviews.filter((item) => item.id !== saved.id), saved]; persist(this.state); return saved;
  }
  async getAnalytics(): Promise<TradingAnalytics> {
    const disciplined = this.state.reviews.filter((item) => item.followedPlan).length;
    const closed = this.state.fills.filter((fill) => fill.action === "close");
    const wins = closed.filter((fill) => Number(fill.realizedPnl) > 0);
    const losses = closed.filter((fill) => Number(fill.realizedPnl) < 0);
    const grossProfit = wins.reduce((sum, fill) => sum + Number(fill.realizedPnl), 0);
    const grossLoss = Math.abs(losses.reduce((sum, fill) => sum + Number(fill.realizedPnl), 0));
    const netPnl = this.state.fills.reduce((sum, fill) => sum + Number(fill.realizedPnl) - Number(fill.fee), 0);
    const byId = new Map(this.state.fills.map((fill) => [fill.id, fill]));
    const tags = new Map<string, { count: number; pnl: number }>();
    for (const review of this.state.reviews) for (const tag of review.mistakeTags) {
      const value = tags.get(tag) ?? { count: 0, pnl: 0 };
      const fill = byId.get(review.positionId);
      value.count += 1; value.pnl += fill ? Number(fill.realizedPnl) - Number(fill.fee) : 0; tags.set(tag, value);
    }
    const dailyPnl = Array.from({ length: 7 }, (_, index) => ({ date: new Date(Date.now() - (6 - index) * 86400000).toISOString().slice(0, 10), pnl: 0 }));
    for (const fill of this.state.fills) { const point = dailyPnl.find((item) => item.date === new Date(fill.createdAt).toISOString().slice(0, 10)); if (point) point.pnl += Number(fill.realizedPnl) - Number(fill.fee); }
    const sessions = [{ label: "亚洲早盘 08–12", trades: 0, pnl: 0, wins: 0 }, { label: "欧洲时段 12–20", trades: 0, pnl: 0, wins: 0 }, { label: "美盘时段 20–08", trades: 0, pnl: 0, wins: 0 }];
    for (const fill of closed) { const hour = new Date(fill.createdAt + 8 * 3600000).getUTCHours(); const item = sessions[hour >= 8 && hour < 12 ? 0 : hour >= 12 && hour < 20 ? 1 : 2]; item.trades += 1; item.pnl += Number(fill.realizedPnl) - Number(fill.fee); if (Number(fill.realizedPnl) > 0) item.wins += 1; }
    return {
      totalTrades: closed.length, reviewedTrades: this.state.reviews.length, plannedTrades: disciplined,
      winRate: closed.length ? wins.length / closed.length * 100 : 0, profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? 999.99 : 0,
      netPnl: netPnl.toFixed(4), averageWin: (wins.length ? grossProfit / wins.length : 0).toFixed(4), averageLoss: (losses.length ? -grossLoss / losses.length : 0).toFixed(4),
      disciplineScore: this.state.reviews.length ? Math.round(disciplined / this.state.reviews.length * 100) : 0,
      topMistakes: [...tags].sort((a, b) => b[1].count - a[1].count).map(([tag, value]) => ({ tag, count: value.count, pnl: value.pnl.toFixed(4) })),
      dailyPnl: dailyPnl.map((item) => ({ date: item.date, pnl: item.pnl.toFixed(4) })),
      sessions: sessions.map((item) => ({ label: item.label, trades: item.trades, pnl: item.pnl.toFixed(4), winRate: item.trades ? item.wins / item.trades * 100 : 0 }))
    };
  }
  async listDcaPlans(): Promise<DcaPlan[]> { return this.state.dcaPlans; }
  async saveDcaPlan(plan: DcaPlan): Promise<DcaPlan> {
    if (plan.mode === "live") throw new Error("首版 DCA 仅支持模拟计划");
    const saved = { ...plan, id: plan.id || crypto.randomUUID() };
    this.state.dcaPlans = [...this.state.dcaPlans.filter((item) => item.id !== saved.id), saved]; persist(this.state); return saved;
  }
  async listEconomicEvents(from: number, to: number): Promise<EconomicEvent[]> {
    return demoEconomicEvents().filter((item) => item.occursAt >= from && item.occursAt <= to);
  }
  async saveChartTemplate(template: ChartTemplate): Promise<ChartTemplate> {
    this.state.templates = [...this.state.templates.filter((item) => item.id !== template.id), template]; persist(this.state); return template;
  }
  async listChartTemplates(): Promise<ChartTemplate[]> { return this.state.templates; }
  private requirePlan(id: string): TradingPlan {
    const plan = this.state.plans.find((item) => item.id === id);
    if (!plan) throw new Error("交易计划不存在"); return normalizePlan(plan);
  }
}

function demoEconomicEvents(): EconomicEvent[] {
  const at = (month: number, day: number, hour: number, minute: number) => Date.UTC(2026, month - 1, day, hour, minute);
  const event = (id: string, title: string, country: string, impact: EconomicEvent["impact"], occursAt: number, previous: string, forecast: string, source: string, category: EconomicEvent["category"], affectedAssets: EconomicEvent["affectedAssets"]): EconomicEvent => ({ id, title, country, impact, occursAt, previous, forecast, source, category, affectedAssets });
  return [
    event("us-gdp-2q-second", "美国二季度实际 GDP（二次估算）", "US", "high", at(8, 26, 12, 30), "1.5%", "待更新", "美国商务部 BEA", "macro", ["crypto", "oil", "metals", "stocks"]),
    event("us-pce-jul", "美国 7 月核心 PCE 物价指数", "US", "high", at(8, 26, 12, 30), "待更新", "待更新", "美国商务部 BEA", "macro", ["crypto", "oil", "metals", "stocks"]),
    event("us-income-outlays", "美国 7 月个人收入与支出", "US", "high", at(8, 26, 12, 30), "待更新", "待更新", "美国商务部 BEA", "macro", ["crypto", "oil", "metals", "stocks"]),
    event("us-corporate-profits", "美国二季度企业利润初值", "US", "medium", at(8, 26, 12, 30), "—", "—", "美国商务部 BEA", "macro", ["stocks", "metals"]),
    event("bls-leave", "美国劳工休假使用情况", "US", "low", at(8, 26, 14, 0), "—", "—", "美国劳工统计局 BLS", "employment", ["stocks"]),
    event("eia-crude", "美国 EIA 原油库存", "US", "high", at(8, 26, 14, 30), "待更新", "待更新", "美国能源信息署 EIA", "energy", ["oil", "stocks"]),
    event("eia-gasoline", "美国 EIA 汽油库存", "US", "medium", at(8, 26, 14, 30), "待更新", "待更新", "美国能源信息署 EIA", "energy", ["oil"]),
    event("eia-cushing", "美国 EIA 库欣原油库存", "US", "medium", at(8, 26, 14, 30), "待更新", "待更新", "美国能源信息署 EIA", "energy", ["oil"]),
    event("us-jobless", "美国初请失业金人数", "US", "high", at(8, 27, 12, 30), "待更新", "待更新", "美国劳工部 DOL", "employment", ["crypto", "metals", "stocks"]),
    event("bls-employment-projection", "美国就业预测与职业展望", "US", "low", at(8, 27, 14, 0), "—", "—", "美国劳工统计局 BLS", "employment", ["stocks"]),
    event("fed-balance-sheet", "美联储资产负债表 H.4.1", "US", "medium", at(8, 28, 0, 30), "待更新", "—", "美联储", "central_bank", ["crypto", "metals", "stocks"]),
    event("crypto-monthly-expiry", "BTC / ETH 月度期权集中到期", "GLOBAL", "high", at(8, 28, 8, 0), "—", "—", "衍生品规则日历", "crypto", ["crypto"]),
    event("fed-jackson-hole", "美联储主席杰克逊霍尔主题讲话", "US", "high", at(8, 28, 14, 0), "—", "—", "美联储", "central_bank", ["crypto", "oil", "metals", "stocks"]),
    event("bls-ces-benchmark", "美国非农就业年度初步基准修订", "US", "medium", at(8, 28, 14, 0), "—", "—", "美国劳工统计局 BLS", "employment", ["metals", "stocks"]),
    event("baker-hughes", "美国 Baker Hughes 石油钻井总数", "US", "medium", at(8, 28, 17, 0), "待更新", "—", "Baker Hughes", "energy", ["oil"]),
    event("cftc-cot", "CFTC 原油与贵金属持仓周报", "US", "medium", at(8, 28, 19, 30), "—", "—", "美国 CFTC", "market", ["oil", "metals"]),
    event("crypto-weekend", "加密市场周末流动性收缩窗口", "GLOBAL", "medium", at(8, 29, 0, 0), "—", "—", "本地风险模板·交易前核实", "crypto", ["crypto"]),
    event("china-pmi", "中国 8 月官方制造业 PMI", "CN", "high", at(8, 31, 1, 30), "待更新", "待更新", "本地日程模板·待实时源确认", "macro", ["crypto", "oil", "metals", "stocks"]),
    event("eurozone-cpi", "欧元区 8 月 CPI 初值", "EU", "high", at(8, 31, 9, 0), "待更新", "待更新", "本地日程模板·待实时源确认", "macro", ["crypto", "oil", "metals", "stocks"]),
    event("month-end-rebalance", "全球指数与基金月末再平衡窗口", "GLOBAL", "high", at(8, 31, 15, 30), "—", "—", "市场日历", "market", ["crypto", "oil", "metals", "stocks"]),
    event("fed-h10", "美联储 H.10 外汇汇率周报", "US", "low", at(9, 1, 0, 15), "—", "—", "美联储", "central_bank", ["crypto", "metals", "stocks"])
  ];
}

export function createGateway(): TradingGateway {
  return "__TAURI_INTERNALS__" in globalThis ? new TauriGateway() : new DemoGateway();
}
