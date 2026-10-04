import type {
  AccountSnapshot, BootstrapState, Candle, CredentialStatus, DcaPlan, Direction, EconomicEvent, ExchangeCapabilities,
  ExchangeId, IndicatorSettings, Instrument, MarginMode, MarketSnapshot, OpenOrder, OrderIntent, OrderResult, OrderReview,
  PositionReview, RiskSettings, RoutingSettings, Timeframe, TradingAnalytics, TradingPlan
} from "../types";

export interface CredentialInput {
  exchange: ExchangeId;
  apiKey: string;
  secret: string;
  passphrase?: string;
  declaredPermissions: Array<"read" | "trade" | "withdraw">;
  expiresAt?: number;
}

export interface ChartTemplate {
  id: string;
  name: string;
  layout: 1 | 2 | 4;
  indicators: IndicatorSettings;
  drawingsJson: string;
}

export interface TradingGateway {
  bootstrap(): Promise<BootstrapState>;
  getCapabilities(exchange: ExchangeId, refresh?: boolean): Promise<ExchangeCapabilities>;
  getMarket(exchange: ExchangeId, symbol: string, timeframe: Timeframe): Promise<MarketSnapshot>;
  subscribeMarket(exchange: ExchangeId, symbol: string, timeframe: Timeframe, listener: (snapshot: MarketSnapshot) => void): Promise<() => void>;
  getKlines(exchange: ExchangeId, symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  getInstruments(exchange: ExchangeId): Promise<Instrument[]>;
  syncLiveAccount(exchange: ExchangeId): Promise<AccountSnapshot>;
  setExchangeLeverage(exchange: ExchangeId, symbol: string, leverage: number, direction: Direction): Promise<void>;
  setExchangeMarginMode(exchange: ExchangeId, symbol: string, mode: MarginMode): Promise<void>;
  saveCredentials(input: CredentialInput): Promise<CredentialStatus>;
  removeCredentials(exchange: ExchangeId): Promise<void>;
  saveRiskSettings(settings: RiskSettings): Promise<RiskSettings>;
  saveRoutingSettings(settings: RoutingSettings): Promise<RoutingSettings>;
  setPin(pin: string): Promise<void>;
  unlockLive(pin: string): Promise<void>;
  lockLive(reason?: string): Promise<void>;
  emergencyStop(reason: string): Promise<void>;
  clearEmergencyStop(pin: string): Promise<void>;
  listPlans(): Promise<TradingPlan[]>;
  savePlan(plan: TradingPlan): Promise<TradingPlan>;
  armPlan(planId: string): Promise<TradingPlan>;
  triggerPlan(planId: string): Promise<TradingPlan>;
  prepareOrder(intent: OrderIntent): Promise<OrderReview>;
  submitOrder(reviewToken: string, warningAccepted: boolean): Promise<OrderResult>;
  cancelOrder(exchange: ExchangeId, orderId: string): Promise<OrderResult>;
  cancelAll(exchange: ExchangeId, symbol?: string): Promise<number>;
  listOrders(): Promise<OpenOrder[]>;
  savePositionReview(review: PositionReview): Promise<PositionReview>;
  getAnalytics(): Promise<TradingAnalytics>;
  listDcaPlans(): Promise<DcaPlan[]>;
  saveDcaPlan(plan: DcaPlan): Promise<DcaPlan>;
  listEconomicEvents(from: number, to: number): Promise<EconomicEvent[]>;
  saveChartTemplate(template: ChartTemplate): Promise<ChartTemplate>;
  listChartTemplates(): Promise<ChartTemplate[]>;
}
