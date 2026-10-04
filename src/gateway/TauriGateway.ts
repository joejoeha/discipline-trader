import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TradingGateway, CredentialInput, ChartTemplate } from "./TradingGateway";
import type {
  AccountSnapshot, BootstrapState, Candle, CredentialStatus, DcaPlan, Direction, EconomicEvent, ExchangeCapabilities,
  ExchangeId, Instrument, MarginMode, MarketSnapshot, OpenOrder, OrderIntent, OrderResult, OrderReview,
  PositionReview, RiskSettings, RoutingSettings, Timeframe, TradingAnalytics, TradingPlan
} from "../types";

export class TauriGateway implements TradingGateway {
  bootstrap = () => invoke<BootstrapState>("bootstrap");
  getCapabilities = (exchange: ExchangeId, refresh = false) => invoke<ExchangeCapabilities>("get_capabilities", { exchange, refresh });
  getMarket = (exchange: ExchangeId, symbol: string, timeframe: Timeframe) => invoke<MarketSnapshot>("get_market", { exchange, symbol, timeframe });
  getKlines = (exchange: ExchangeId, symbol: string, timeframe: Timeframe, limit: number) => invoke<Candle[]>("get_klines", { exchange, symbol, timeframe, limit });
  getInstruments = (exchange: ExchangeId) => invoke<Instrument[]>("get_instruments", { exchange });
  syncLiveAccount = (exchange: ExchangeId) => invoke<AccountSnapshot>("sync_live_account", { exchange });
  setExchangeLeverage = (exchange: ExchangeId, symbol: string, leverage: number, direction: Direction) => invoke<void>("set_exchange_leverage", { exchange, symbol, leverage, direction });
  setExchangeMarginMode = (exchange: ExchangeId, symbol: string, mode: MarginMode) => invoke<void>("set_exchange_margin_mode", { exchange, symbol, mode });
  async subscribeMarket(exchange: ExchangeId, symbol: string, timeframe: Timeframe, listener: (snapshot: MarketSnapshot) => void): Promise<UnlistenFn> {
    const channel = `market://${exchange}/${symbol}/${timeframe}`;
    const unlisten = await listen<MarketSnapshot>(channel, ({ payload }) => listener(payload));
    await invoke("subscribe_market", { exchange, symbol, timeframe, channel });
    return async () => { await invoke("unsubscribe_market", { channel }); unlisten(); };
  }
  saveCredentials = (input: CredentialInput) => invoke<CredentialStatus>("save_credentials", { input });
  removeCredentials = (exchange: ExchangeId) => invoke<void>("remove_credentials", { exchange });
  saveRiskSettings = (settings: RiskSettings) => invoke<RiskSettings>("save_risk_settings", { settings });
  saveRoutingSettings = (settings: RoutingSettings) => invoke<RoutingSettings>("save_routing_settings", { settings });
  setPin = (pin: string) => invoke<void>("set_pin", { pin });
  unlockLive = (pin: string) => invoke<void>("unlock_live", { pin });
  lockLive = (reason?: string) => invoke<void>("lock_live", { reason });
  emergencyStop = (reason: string) => invoke<void>("emergency_stop", { reason });
  clearEmergencyStop = (pin: string) => invoke<void>("clear_emergency_stop", { pin });
  listPlans = () => invoke<TradingPlan[]>("list_plans");
  savePlan = (plan: TradingPlan) => invoke<TradingPlan>("save_plan", { plan });
  armPlan = (planId: string) => invoke<TradingPlan>("arm_plan", { planId });
  triggerPlan = (planId: string) => invoke<TradingPlan>("trigger_plan", { planId });
  prepareOrder = (intent: OrderIntent) => invoke<OrderReview>("prepare_order", { intent });
  submitOrder = (reviewToken: string, warningAccepted: boolean) => invoke<OrderResult>("submit_order", { reviewToken, warningAccepted });
  cancelOrder = (exchange: ExchangeId, orderId: string) => invoke<OrderResult>("cancel_order", { exchange, orderId });
  cancelAll = (exchange: ExchangeId, symbol?: string) => invoke<number>("cancel_all", { exchange, symbol });
  listOrders = () => invoke<OpenOrder[]>("list_orders");
  savePositionReview = (review: PositionReview) => invoke<PositionReview>("save_position_review", { review });
  getAnalytics = () => invoke<TradingAnalytics>("get_analytics");
  listDcaPlans = () => invoke<DcaPlan[]>("list_dca_plans");
  saveDcaPlan = (plan: DcaPlan) => invoke<DcaPlan>("save_dca_plan", { plan });
  listEconomicEvents = (from: number, to: number) => invoke<EconomicEvent[]>("list_economic_events", { from, to });
  saveChartTemplate = (template: ChartTemplate) => invoke<ChartTemplate>("save_chart_template", { template });
  listChartTemplates = () => invoke<ChartTemplate[]>("list_chart_templates");
}
