export type ExchangeId = "mexc" | "ourbit";
export type TradingMode = "paper" | "live";
export type CheckMode = "block" | "warn" | "off";
export type Direction = "long" | "short";
export type OrderType = "market" | "limit" | "post_only" | "ioc" | "fok" | "trigger" | "trailing";
export type MarginMode = "isolated" | "cross";
export type PositionMode = "one_way" | "hedge";
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export type AssetClass = "crypto" | "stock" | "oil" | "precious_metal";

export interface DecimalString { value: string }

export interface Instrument {
  exchange: ExchangeId;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  assetClass: AssetClass;
  priceTick: string;
  quantityStep: string;
  minQuantity: string;
  contractSize: string;
  maxLeverage: number;
  status: "online" | "maintenance" | "offline";
}

export interface FeeProfile { makerPercent: string; takerPercent: string; source: string; verifiedAt?: number | null }
export interface RoutingSettings {
  cryptoExchange: ExchangeId;
  stockExchange: ExchangeId;
  oilExchange: ExchangeId;
  preciousMetalExchange: ExchangeId;
  mexcFees: FeeProfile;
  ourbitFees: FeeProfile;
  warnOnOverride: boolean;
  updatedAt: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  symbol: string;
  last: string;
  change24h: string;
  high24h: string;
  low24h: string;
  volume24h: string;
  fundingRate: string;
  nextFundingAt: number;
  markPrice: string;
  indexPrice: string;
}

export interface DepthLevel { price: string; quantity: string }
export interface DepthBook {
  symbol: string;
  sequence: number;
  updatedAt: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface PublicTrade {
  id: string;
  time: number;
  price: string;
  quantity: string;
  side: "buy" | "sell";
}

export interface Balance { asset: string; total: string; available: string; unrealizedPnl: string }
export interface Position {
  id: string;
  exchange: ExchangeId;
  symbol: string;
  direction: Direction;
  quantity: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string | null;
  leverage: number;
  marginMode: MarginMode;
  unrealizedPnl: string;
  realizedPnl: string;
  stopLoss?: string | null;
  takeProfit?: string | null;
}

export interface TradeFill { id: string; exchange: ExchangeId; symbol: string; mode: TradingMode; direction: Direction; action: "open" | "close"; orderId: string; clientOrderId: string; quantity: string; price: string; fee: string; realizedPnl: string; createdAt: number }
export interface RiskEvent { id: string; eventType: string; message: string; createdAt: number }

export interface OrderIntent {
  clientOrderId: string;
  exchange: ExchangeId;
  symbol: string;
  mode: TradingMode;
  direction: Direction;
  action: "open" | "close";
  orderType: OrderType;
  quantity: string;
  price?: string;
  triggerPrice?: string;
  trailingPercent?: string;
  leverage: number;
  marginMode: MarginMode;
  positionMode: PositionMode;
  reduceOnly: boolean;
  takeProfit?: string;
  stopLoss?: string;
  planId?: string;
  checkMode: CheckMode;
}

export interface OrderResult {
  accepted: boolean;
  orderId?: string;
  clientOrderId: string;
  state: "submitted" | "filled" | "partial" | "cancelled" | "rejected" | "unknown";
  message: string;
  filledQuantity: string;
  averagePrice?: string;
}

export interface OpenOrder extends OrderIntent {
  orderId: string;
  status: OrderResult["state"];
  filledQuantity: string;
  createdAt: number;
}

export interface ExchangeCapabilities {
  exchange: ExchangeId;
  marketData: boolean;
  accountRead: boolean;
  liveTrading: boolean;
  orderTypes: Record<OrderType, boolean>;
  supportsReduceOnly: boolean;
  supportsTpSl: boolean;
  supportsTrailingStop: boolean;
  supportsHedgeMode: boolean;
  supportsCrossMargin: boolean;
  reason?: string;
  checkedAt: number;
}

export interface RiskSettings {
  /** 关闭后不再强制本地杠杆、名义价值、单笔风险与日亏额度。 */
  enforceGlobalLimits: boolean;
  /** 关闭后所有交易所已支持的合约均可交易。 */
  restrictAllowedSymbols: boolean;
  maxLeverage: number;
  maxNotional: string;
  maxRiskPercent: string;
  dailyLossLimit: string;
  allowedSymbols: string[];
  marketDataTimeoutSeconds: number;
  maxClockSkewSeconds: number;
}

export interface ChecklistQuestion {
  id: string;
  prompt: string;
  expected: boolean;
  critical: boolean;
}

export interface ChecklistAnswer {
  questionId: string;
  value: boolean | null;
}

export interface TradingPlan {
  id: string;
  name: string;
  exchange: ExchangeId;
  symbol: string;
  direction: Direction;
  triggerCondition: string;
  entryReason: string;
  takeProfitReason: string;
  plannedPrice: string;
  stopLoss: string;
  targets: string[];
  allowedOrderTypes: OrderType[];
  checkMode: CheckMode;
  customQuestions: ChecklistQuestion[];
  answers: ChecklistAnswer[];
  status: "draft" | "armed" | "triggered" | "expired" | "completed";
  armedAt?: number;
  triggeredAt?: number;
  earliestEntryAt?: number;
  expiresAt?: number;
  cooldownMinutes: number;
  createdAt: number;
  updatedAt: number;
}

export interface PositionReview {
  id: string;
  positionId: string;
  planId?: string;
  rating: number;
  followedPlan: boolean;
  mistakeTags: string[];
  thesis: string;
  executionNotes: string;
  lesson: string;
  createdAt: number;
}

export interface TradingAnalytics {
  totalTrades: number;
  reviewedTrades: number;
  plannedTrades: number;
  winRate: number;
  profitFactor: number;
  netPnl: string;
  averageWin: string;
  averageLoss: string;
  disciplineScore: number;
  topMistakes: Array<{ tag: string; count: number; pnl: string }>;
  dailyPnl: Array<{ date: string; pnl: string }>;
  sessions: Array<{ label: string; trades: number; pnl: string; winRate: number }>;
}

export interface DcaPlan {
  id: string;
  exchange: ExchangeId;
  symbol: string;
  amountUsdt: string;
  frequency: "daily" | "weekly" | "monthly" | "panic";
  panicDropPercent?: string;
  maxPurchasesPerDay: number;
  mode: TradingMode;
  enabled: boolean;
  nextRunAt?: number;
}

export interface EconomicEvent {
  id: string;
  title: string;
  country: string;
  impact: "low" | "medium" | "high";
  occursAt: number;
  previous?: string;
  forecast?: string;
  actual?: string;
  source: string;
  category: "macro" | "central_bank" | "employment" | "energy" | "crypto" | "market";
  affectedAssets: Array<"crypto" | "oil" | "metals" | "stocks">;
}

export interface ChecklistResult {
  passed: boolean;
  mode: CheckMode;
  failed: string[];
  unanswered: string[];
}

export interface OrderReview {
  token: string;
  expiresAt: number;
  intent: OrderIntent;
  notional: string;
  marginRequired: string;
  maxStopLoss: string | null;
  estimatedLiquidationPrice: string;
  assetClass: AssetClass;
  recommendedExchange: ExchangeId;
  routeReason: string;
  estimatedMakerFee: string;
  estimatedTakerFee: string;
  fundingRatePercent: string;
  estimatedFundingFee: string;
  feeProfileVerified: boolean;
  checklist: ChecklistResult;
  warnings: string[];
  blockedReasons: string[];
}

export interface CredentialStatus {
  exchange: ExchangeId;
  configured: boolean;
  verified: boolean;
  permissions: string[];
  expiresAt?: number;
  lastVerifiedAt?: number;
  message: string;
}

export interface LiveLockState {
  locked: boolean;
  emergencyStopped: boolean;
  reasons: string[];
  unlockedUntil?: number;
}

export interface MarketSnapshot {
  instrument: Instrument;
  ticker: Ticker;
  candles: Candle[];
  depth: DepthBook;
  trades: PublicTrade[];
  connected: boolean;
  source: "exchange" | "replay" | "demo";
}

export interface BootstrapState {
  mode: TradingMode;
  selectedExchange: ExchangeId;
  selectedSymbol: string;
  capabilities: ExchangeCapabilities[];
  credentials: CredentialStatus[];
  riskSettings: RiskSettings | null;
  routingSettings: RoutingSettings;
  liveLock: LiveLockState;
  plans: TradingPlan[];
  positions: Position[];
  orders: OpenOrder[];
  balances: Balance[];
  fills: TradeFill[];
  reviews: PositionReview[];
  riskEvents: RiskEvent[];
}

export interface AccountSnapshot {
  exchange: ExchangeId;
  balances: Balance[];
  positions: Position[];
  orders: OpenOrder[];
  syncedAt: number;
}

export interface IndicatorSettings {
  volume: boolean;
  ma: number[];
  ema: number[];
  bollinger: { enabled: boolean; period: number; deviation: number };
  vwap: boolean;
  rsi: { enabled: boolean; period: number };
  stochRsi: { enabled: boolean; rsiPeriod: number; stochPeriod: number; kSmooth: number; dSmooth: number };
  macd: { enabled: boolean; fast: number; slow: number; signal: number };
  atr: { enabled: boolean; period: number };
}

export type DrawingTool = "cursor" | "delete" | "trend" | "horizontal" | "vertical" | "ray" | "rectangle" | "text" | "fibonacci" | "measure" | "long_rr" | "short_rr";
export interface DrawingPoint { time: number; price: number }
export interface ChartDrawing {
  id: string;
  tool: DrawingTool;
  points: DrawingPoint[];
  text?: string;
  color: string;
  createdAt: number;
}

export const DEFAULT_CHECKLIST: ChecklistQuestion[] = [
  { id: "emotion", prompt: "当前没有情绪化交易或冲动下单？", expected: true, critical: true },
  { id: "revenge", prompt: "这不是为了急于回本的报复性交易？", expected: true, critical: true },
  { id: "frequency", prompt: "近期交易频率仍在计划范围内？", expected: true, critical: false },
  { id: "losses", prompt: "连续亏损尚未触发暂停规则？", expected: true, critical: true },
  { id: "size", prompt: "仓位与止损后的最大亏损可接受？", expected: true, critical: true },
  { id: "analysis", prompt: "已完成多周期行情分析并写出依据？", expected: true, critical: false },
  { id: "trend", prompt: "交易方向与所选周期趋势不冲突？", expected: true, critical: false },
  { id: "liquidity", prompt: "盘口流动性足够，滑点风险可接受？", expected: true, critical: false },
  { id: "intent", prompt: "已考虑主力诱多/诱空与流动性位置？", expected: true, critical: false },
  { id: "stop", prompt: "止损价格明确且不会随意扩大？", expected: true, critical: true },
  { id: "accept", prompt: "即使止损，仍会认可这次决策过程？", expected: true, critical: true }
];

export const DEFAULT_INDICATORS: IndicatorSettings = {
  volume: true,
  ma: [20, 60],
  ema: [],
  bollinger: { enabled: false, period: 20, deviation: 2 },
  vwap: false,
  rsi: { enabled: false, period: 14 },
  stochRsi: { enabled: false, rsiPeriod: 14, stochPeriod: 14, kSmooth: 3, dSmooth: 3 },
  macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
  atr: { enabled: false, period: 14 }
};

export function normalizeIndicatorSettings(value?: Partial<IndicatorSettings>): IndicatorSettings {
  return {
    volume: value?.volume ?? DEFAULT_INDICATORS.volume,
    ma: Array.isArray(value?.ma) ? [...value.ma] : [...DEFAULT_INDICATORS.ma],
    ema: Array.isArray(value?.ema) ? [...value.ema] : [...DEFAULT_INDICATORS.ema],
    bollinger: { ...DEFAULT_INDICATORS.bollinger, ...(value?.bollinger ?? {}) },
    vwap: value?.vwap ?? DEFAULT_INDICATORS.vwap,
    rsi: { ...DEFAULT_INDICATORS.rsi, ...(value?.rsi ?? {}) },
    stochRsi: { ...DEFAULT_INDICATORS.stochRsi, ...(value?.stochRsi ?? {}) },
    macd: { ...DEFAULT_INDICATORS.macd, ...(value?.macd ?? {}) },
    atr: { ...DEFAULT_INDICATORS.atr, ...(value?.atr ?? {}) }
  };
}
