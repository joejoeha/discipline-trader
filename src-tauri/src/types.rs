use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ExchangeId {
    Mexc,
    Ourbit,
}

impl ExchangeId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mexc => "mexc",
            Self::Ourbit => "ourbit",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TradingMode {
    Paper,
    Live,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CheckMode {
    Block,
    Warn,
    Off,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Long,
    Short,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum OrderType {
    Market,
    Limit,
    PostOnly,
    Ioc,
    Fok,
    Trigger,
    Trailing,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MarginMode {
    Isolated,
    Cross,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PositionMode {
    OneWay,
    Hedge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetClass {
    Crypto,
    Stock,
    Oil,
    PreciousMetal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub exchange: ExchangeId,
    pub symbol: String,
    pub base_asset: String,
    pub quote_asset: String,
    pub asset_class: AssetClass,
    pub price_tick: Decimal,
    pub quantity_step: Decimal,
    pub min_quantity: Decimal,
    pub contract_size: Decimal,
    pub max_leverage: u32,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeProfile {
    pub maker_percent: Decimal,
    pub taker_percent: Decimal,
    pub source: String,
    pub verified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingSettings {
    pub crypto_exchange: ExchangeId,
    pub stock_exchange: ExchangeId,
    pub oil_exchange: ExchangeId,
    pub precious_metal_exchange: ExchangeId,
    pub mexc_fees: FeeProfile,
    pub ourbit_fees: FeeProfile,
    pub warn_on_override: bool,
    pub updated_at: i64,
}

impl RoutingSettings {
    pub fn user_default() -> Self {
        Self {
            crypto_exchange: ExchangeId::Ourbit,
            stock_exchange: ExchangeId::Mexc,
            oil_exchange: ExchangeId::Mexc,
            precious_metal_exchange: ExchangeId::Mexc,
            // MEXC's public API fee notice effective Jun 1, 2026. The user can
            // replace this only after checking the fee page for their API key.
            mexc_fees: FeeProfile {
                maker_percent: Decimal::new(6, 2),
                taker_percent: Decimal::new(8, 2),
                source: "MEXC API 公告默认值（须按账户复核）".into(),
                verified_at: None,
            },
            ourbit_fees: FeeProfile {
                maker_percent: Decimal::new(8, 3),
                taker_percent: Decimal::new(25, 3),
                source: "用户提供的 Ourbit VIP 费率（须按账户复核）".into(),
                verified_at: None,
            },
            warn_on_override: true,
            updated_at: chrono::Utc::now().timestamp_millis(),
        }
    }

    pub fn preferred_exchange(&self, asset_class: AssetClass) -> ExchangeId {
        match asset_class {
            AssetClass::Crypto => self.crypto_exchange,
            AssetClass::Stock => self.stock_exchange,
            AssetClass::Oil => self.oil_exchange,
            AssetClass::PreciousMetal => self.precious_metal_exchange,
        }
    }

    pub fn fees(&self, exchange: ExchangeId) -> &FeeProfile {
        match exchange {
            ExchangeId::Mexc => &self.mexc_fees,
            ExchangeId::Ourbit => &self.ourbit_fees,
        }
    }

    pub fn effective_fees(&self, exchange: ExchangeId, asset_class: AssetClass) -> FeeProfile {
        let mut profile = self.fees(exchange).clone();
        if exchange == ExchangeId::Mexc && asset_class != AssetClass::Crypto {
            profile.maker_percent = Decimal::ZERO;
            profile.taker_percent = Decimal::ZERO;
            profile.source = "用户指定：MEXC 股票、原油与贵金属合约 0% 交易手续费".into();
        }
        profile
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candle {
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticker {
    pub symbol: String,
    pub last: Decimal,
    pub change24h: Decimal,
    pub high24h: Decimal,
    pub low24h: Decimal,
    pub volume24h: String,
    pub funding_rate: Decimal,
    pub next_funding_at: i64,
    pub mark_price: Decimal,
    pub index_price: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthLevel {
    pub price: Decimal,
    pub quantity: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthBook {
    pub symbol: String,
    pub sequence: i64,
    pub updated_at: i64,
    pub bids: Vec<DepthLevel>,
    pub asks: Vec<DepthLevel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicTrade {
    pub id: String,
    pub time: i64,
    pub price: Decimal,
    pub quantity: Decimal,
    pub side: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Balance {
    pub asset: String,
    pub total: Decimal,
    pub available: Decimal,
    pub unrealized_pnl: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub id: String,
    pub exchange: ExchangeId,
    pub symbol: String,
    pub direction: Direction,
    pub quantity: Decimal,
    pub entry_price: Decimal,
    pub mark_price: Decimal,
    pub liquidation_price: Option<Decimal>,
    pub leverage: u32,
    pub margin_mode: MarginMode,
    pub unrealized_pnl: Decimal,
    pub realized_pnl: Decimal,
    #[serde(default)]
    pub stop_loss: Option<Decimal>,
    #[serde(default)]
    pub take_profit: Option<Decimal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeFill {
    pub id: String,
    pub exchange: ExchangeId,
    pub symbol: String,
    pub mode: TradingMode,
    pub direction: Direction,
    pub action: String,
    pub order_id: String,
    pub client_order_id: String,
    pub quantity: Decimal,
    pub price: Decimal,
    pub fee: Decimal,
    pub realized_pnl: Decimal,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskEvent {
    pub id: String,
    pub event_type: String,
    pub message: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderIntent {
    pub client_order_id: String,
    pub exchange: ExchangeId,
    pub symbol: String,
    pub mode: TradingMode,
    pub direction: Direction,
    pub action: String,
    pub order_type: OrderType,
    pub quantity: Decimal,
    pub price: Option<Decimal>,
    pub trigger_price: Option<Decimal>,
    pub trailing_percent: Option<Decimal>,
    pub leverage: u32,
    pub margin_mode: MarginMode,
    pub position_mode: PositionMode,
    pub reduce_only: bool,
    pub take_profit: Option<Decimal>,
    pub stop_loss: Option<Decimal>,
    pub plan_id: Option<String>,
    pub check_mode: CheckMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderResult {
    pub accepted: bool,
    pub order_id: Option<String>,
    pub client_order_id: String,
    pub state: String,
    pub message: String,
    pub filled_quantity: Decimal,
    pub average_price: Option<Decimal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOrder {
    #[serde(flatten)]
    pub intent: OrderIntent,
    pub order_id: String,
    pub status: String,
    pub filled_quantity: Decimal,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeCapabilities {
    pub exchange: ExchangeId,
    pub market_data: bool,
    pub account_read: bool,
    pub live_trading: bool,
    pub order_types: HashMap<OrderType, bool>,
    pub supports_reduce_only: bool,
    pub supports_tp_sl: bool,
    pub supports_trailing_stop: bool,
    pub supports_hedge_mode: bool,
    pub supports_cross_margin: bool,
    pub reason: Option<String>,
    pub checked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskSettings {
    #[serde(default = "default_true")]
    pub enforce_global_limits: bool,
    #[serde(default = "default_true")]
    pub restrict_allowed_symbols: bool,
    pub max_leverage: u32,
    pub max_notional: Decimal,
    pub max_risk_percent: Decimal,
    pub daily_loss_limit: Decimal,
    pub allowed_symbols: Vec<String>,
    pub market_data_timeout_seconds: u32,
    pub max_clock_skew_seconds: u32,
}

impl RiskSettings {
    pub fn safe_default() -> Self {
        Self {
            enforce_global_limits: true,
            restrict_allowed_symbols: true,
            max_leverage: 10,
            max_notional: Decimal::new(10_000, 0),
            max_risk_percent: Decimal::ONE,
            daily_loss_limit: Decimal::new(300, 0),
            allowed_symbols: vec![
                "BTC_USDT".into(),
                "ETH_USDT".into(),
                "SOL_USDT".into(),
                "NVDASTOCK_USDT".into(),
                "TSLASTOCK_USDT".into(),
                "WTI_USDT".into(),
                "BRENT_USDT".into(),
                "XAU_USDT".into(),
                "XAG_USDT".into(),
            ],
            market_data_timeout_seconds: 15,
            max_clock_skew_seconds: 5,
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistAnswer {
    pub question_id: String,
    pub value: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistQuestion {
    pub id: String,
    pub prompt: String,
    pub expected: bool,
    pub critical: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradingPlan {
    pub id: String,
    pub name: String,
    pub exchange: ExchangeId,
    pub symbol: String,
    pub direction: Direction,
    pub trigger_condition: String,
    #[serde(default)]
    pub entry_reason: String,
    #[serde(default)]
    pub take_profit_reason: String,
    pub planned_price: Decimal,
    pub stop_loss: Decimal,
    pub targets: Vec<Decimal>,
    pub allowed_order_types: Vec<OrderType>,
    pub check_mode: CheckMode,
    #[serde(default)]
    pub custom_questions: Vec<ChecklistQuestion>,
    pub answers: Vec<ChecklistAnswer>,
    pub status: String,
    pub armed_at: Option<i64>,
    pub triggered_at: Option<i64>,
    pub earliest_entry_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub cooldown_minutes: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistResult {
    pub passed: bool,
    pub mode: CheckMode,
    pub failed: Vec<String>,
    pub unanswered: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderReview {
    pub token: String,
    pub expires_at: i64,
    pub intent: OrderIntent,
    pub notional: Decimal,
    pub margin_required: Decimal,
    pub max_stop_loss: Option<Decimal>,
    pub estimated_liquidation_price: Decimal,
    pub asset_class: AssetClass,
    pub recommended_exchange: ExchangeId,
    pub route_reason: String,
    pub estimated_maker_fee: Decimal,
    pub estimated_taker_fee: Decimal,
    pub funding_rate_percent: Decimal,
    pub estimated_funding_fee: Decimal,
    pub fee_profile_verified: bool,
    pub checklist: ChecklistResult,
    pub warnings: Vec<String>,
    pub blocked_reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    pub exchange: ExchangeId,
    pub api_key: String,
    pub secret: String,
    pub passphrase: Option<String>,
    pub declared_permissions: Vec<String>,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub exchange: ExchangeId,
    pub configured: bool,
    pub verified: bool,
    pub permissions: Vec<String>,
    pub expires_at: Option<i64>,
    pub last_verified_at: Option<i64>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveLockState {
    pub locked: bool,
    pub emergency_stopped: bool,
    pub reasons: Vec<String>,
    pub unlocked_until: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSnapshot {
    pub instrument: Instrument,
    pub ticker: Ticker,
    pub candles: Vec<Candle>,
    pub depth: DepthBook,
    pub trades: Vec<PublicTrade>,
    pub connected: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapState {
    pub mode: TradingMode,
    pub selected_exchange: ExchangeId,
    pub selected_symbol: String,
    pub capabilities: Vec<ExchangeCapabilities>,
    pub credentials: Vec<CredentialStatus>,
    pub risk_settings: Option<RiskSettings>,
    pub routing_settings: RoutingSettings,
    pub live_lock: LiveLockState,
    pub plans: Vec<TradingPlan>,
    pub positions: Vec<Position>,
    pub orders: Vec<OpenOrder>,
    pub balances: Vec<Balance>,
    pub fills: Vec<TradeFill>,
    pub reviews: Vec<PositionReview>,
    pub risk_events: Vec<RiskEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshot {
    pub exchange: ExchangeId,
    pub balances: Vec<Balance>,
    pub positions: Vec<Position>,
    pub orders: Vec<OpenOrder>,
    pub synced_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionReview {
    pub id: String,
    pub position_id: String,
    pub plan_id: Option<String>,
    pub rating: u8,
    pub followed_plan: bool,
    pub mistake_tags: Vec<String>,
    pub thesis: String,
    pub execution_notes: String,
    pub lesson: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MistakeStat {
    pub tag: String,
    pub count: u32,
    pub pnl: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyPnl {
    pub date: String,
    pub pnl: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStat {
    pub label: String,
    pub trades: u32,
    pub pnl: Decimal,
    pub win_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradingAnalytics {
    pub total_trades: u32,
    pub reviewed_trades: u32,
    pub planned_trades: u32,
    pub win_rate: f64,
    pub profit_factor: f64,
    pub net_pnl: Decimal,
    pub average_win: Decimal,
    pub average_loss: Decimal,
    pub discipline_score: u32,
    pub top_mistakes: Vec<MistakeStat>,
    pub daily_pnl: Vec<DailyPnl>,
    pub sessions: Vec<SessionStat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DcaPlan {
    pub id: String,
    pub exchange: ExchangeId,
    pub symbol: String,
    pub amount_usdt: Decimal,
    pub frequency: String,
    pub panic_drop_percent: Option<Decimal>,
    pub max_purchases_per_day: u32,
    pub mode: TradingMode,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EconomicEvent {
    pub id: String,
    pub title: String,
    pub country: String,
    pub impact: String,
    pub occurs_at: i64,
    pub previous: Option<String>,
    pub forecast: Option<String>,
    pub actual: Option<String>,
    pub source: String,
    pub category: String,
    pub affected_assets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartTemplate {
    pub id: String,
    pub name: String,
    pub layout: u8,
    pub indicators: serde_json::Value,
    pub drawings_json: String,
}
