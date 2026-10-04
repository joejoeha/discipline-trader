use crate::{
    exchange::ExchangeAdapter,
    state::AppState,
    types::{Candle, DepthBook, DepthLevel, MarketSnapshot, PublicTrade},
};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use rust_decimal::Decimal;
use serde_json::{json, Value};
use std::{str::FromStr, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::Instant;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const MAX_DEPTH_LEVELS: usize = 50;

#[derive(Debug, PartialEq, Eq)]
pub enum DepthApply {
    Applied,
    Gap { expected: i64, received: i64 },
    IgnoredOld,
}

pub struct DepthSynchronizer {
    book: Option<DepthBook>,
}

impl DepthSynchronizer {
    pub fn new() -> Self {
        Self { book: None }
    }
    pub fn snapshot(&mut self, mut book: DepthBook) {
        book.bids.truncate(MAX_DEPTH_LEVELS);
        book.asks.truncate(MAX_DEPTH_LEVELS);
        self.book = Some(book);
    }
    pub fn apply_delta(
        &mut self,
        sequence: i64,
        bids: Vec<DepthLevel>,
        asks: Vec<DepthLevel>,
    ) -> DepthApply {
        let Some(book) = self.book.as_mut() else {
            return DepthApply::Gap {
                expected: 0,
                received: sequence,
            };
        };
        if sequence <= book.sequence {
            return DepthApply::IgnoredOld;
        }
        if sequence != book.sequence + 1 {
            let expected = book.sequence + 1;
            self.book = None;
            return DepthApply::Gap {
                expected,
                received: sequence,
            };
        }
        merge_levels(&mut book.bids, bids, true);
        merge_levels(&mut book.asks, asks, false);
        book.sequence = sequence;
        book.updated_at = chrono::Utc::now().timestamp_millis();
        DepthApply::Applied
    }
    pub fn requires_snapshot(&self) -> bool {
        self.book.is_none()
    }
    pub fn current(&self) -> Option<&DepthBook> {
        self.book.as_ref()
    }
}

fn merge_levels(current: &mut Vec<DepthLevel>, delta: Vec<DepthLevel>, descending: bool) {
    for update in delta {
        if let Some(index) = current.iter().position(|item| item.price == update.price) {
            if update.quantity.is_zero() {
                current.remove(index);
            } else {
                current[index] = update;
            }
        } else if !update.quantity.is_zero() {
            current.push(update);
        }
    }
    if descending {
        current.sort_by(|a, b| b.price.cmp(&a.price));
    } else {
        current.sort_by(|a, b| a.price.cmp(&b.price));
    }
    current.truncate(MAX_DEPTH_LEVELS);
}

pub struct ReconnectPolicy {
    attempts: u32,
}
impl ReconnectPolicy {
    pub fn new() -> Self {
        Self { attempts: 0 }
    }
    pub fn next_delay(&mut self, retry_after: Option<Duration>) -> Duration {
        if let Some(value) = retry_after {
            return value.min(Duration::from_secs(300));
        }
        let seconds = 2u64.saturating_pow(self.attempts.min(7)).min(120);
        self.attempts += 1;
        Duration::from_secs(seconds)
    }
    pub fn reset(&mut self) {
        self.attempts = 0;
    }
    pub fn should_rotate(connected_for: Duration) -> bool {
        connected_for >= Duration::from_secs(23 * 60 * 60 + 50 * 60)
    }
}

pub async fn run_mexc_market_stream(
    app: AppHandle,
    channel: String,
    symbol: String,
    timeframe: String,
    mut snapshot: MarketSnapshot,
) {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("DisciplineTrader/0.1")
        .build()
        .expect("market HTTP client");
    let mut reconnect = ReconnectPolicy::new();
    let mut last_market_at = Instant::now();
    let mut stale_locked = false;

    while subscription_active(&app, &channel) {
        match connect_async("wss://contract.mexc.com/edge").await {
            Ok((socket, _)) => {
                reconnect.reset();
                let (mut writer, mut reader) = socket.split();
                let subscriptions = [
                    json!({"method":"sub.ticker","param":{"symbol":symbol}}),
                    json!({"method":"sub.kline","param":{"symbol":symbol,"interval":mexc_interval(&timeframe)}}),
                    json!({"method":"sub.deal","param":{"symbol":symbol}}),
                    json!({"method":"sub.depth","param":{"symbol":symbol,"compress":false}}),
                ];
                let mut subscribe_failed = false;
                for request in subscriptions {
                    if writer
                        .send(Message::Text(request.to_string().into()))
                        .await
                        .is_err()
                    {
                        subscribe_failed = true;
                        break;
                    }
                }
                if subscribe_failed {
                    mark_disconnected(&app, &channel, &mut snapshot);
                } else {
                    let mut depth = DepthSynchronizer::new();
                    if let Ok(book) =
                        fetch_contract_depth(&client, "https://contract.mexc.com", &symbol).await
                    {
                        depth.snapshot(book.clone());
                        snapshot.depth = book;
                    }
                    snapshot.connected = true;
                    snapshot.source = "exchange".into();
                    publish_snapshot(&app, &channel, &snapshot);

                    let connected_at = Instant::now();
                    let mut ping = tokio::time::interval(Duration::from_secs(15));
                    let mut health = tokio::time::interval(Duration::from_secs(1));
                    let mut ui_refresh = tokio::time::interval(Duration::from_millis(100));
                    ui_refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    let mut market_dirty = false;
                    loop {
                        if !subscription_active(&app, &channel)
                            || ReconnectPolicy::should_rotate(connected_at.elapsed())
                        {
                            break;
                        }
                        tokio::select! {
                            _ = ui_refresh.tick() => {
                                if market_dirty {
                                    publish_snapshot(&app, &channel, &snapshot);
                                    market_dirty = false;
                                }
                            }
                            _ = health.tick() => {
                                if !stale_locked && last_market_at.elapsed() >= market_timeout(&app) {
                                    stale_locked = lock_for_stale_market(&app);
                                    snapshot.connected = false;
                                    publish_snapshot(&app, &channel, &snapshot);
                                }
                            }
                            _ = ping.tick() => {
                                if writer.send(Message::Text(json!({"method":"ping"}).to_string().into())).await.is_err() {
                                    break;
                                }
                            }
                            incoming = reader.next() => {
                                match incoming {
                                    Some(Ok(Message::Text(text))) => {
                                        if let Ok(value) = serde_json::from_str::<Value>(text.as_ref()) {
                                            let is_market_message = value.get("channel").and_then(Value::as_str).is_some_and(|name| name.starts_with("push."));
                                            if is_market_message {
                                                last_market_at = Instant::now();
                                            }
                                            let needs_snapshot = apply_mexc_message(&mut snapshot, &mut depth, &value);
                                            if needs_snapshot {
                                                if let Ok(book) = fetch_contract_depth(&client, "https://contract.mexc.com", &symbol).await {
                                                    depth.snapshot(book.clone());
                                                    snapshot.depth = book;
                                                }
                                            }
                                            snapshot.connected = true;
                                            snapshot.source = "exchange".into();
                                            market_dirty |= is_market_message || needs_snapshot;
                                        }
                                    }
                                    Some(Ok(Message::Ping(payload))) => {
                                        if writer.send(Message::Pong(payload)).await.is_err() { break; }
                                    }
                                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                                    _ => {}
                                }
                            }
                        }
                    }
                    mark_disconnected(&app, &channel, &mut snapshot);
                }
            }
            Err(_) => mark_disconnected(&app, &channel, &mut snapshot),
        }

        if !subscription_active(&app, &channel) {
            break;
        }
        tokio::time::sleep(reconnect.next_delay(None)).await;
        if !stale_locked && last_market_at.elapsed() >= market_timeout(&app) {
            stale_locked = lock_for_stale_market(&app);
        }
    }
}

pub async fn run_ourbit_market_poll(
    app: AppHandle,
    channel: String,
    symbol: String,
    timeframe: String,
    adapter: Arc<dyn ExchangeAdapter>,
    mut snapshot: MarketSnapshot,
) {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("DisciplineTrader/0.1")
        .build()
        .expect("market HTTP client");
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    let mut last_success = Instant::now();
    let mut stale_locked = false;
    snapshot.trades.clear();

    while subscription_active(&app, &channel) {
        interval.tick().await;
        let (candles, depth) = tokio::join!(
            adapter.get_klines(&symbol, &timeframe, 360),
            fetch_contract_depth(&client, "https://futures.ourbit.com", &symbol)
        );
        let mut updated = false;
        if let Ok(values) = candles {
            if !values.is_empty() {
                if let Some(last) = values.last() {
                    snapshot.ticker.last = decimal_f64(last.close);
                    snapshot.ticker.mark_price = snapshot.ticker.last;
                    snapshot.ticker.index_price = snapshot.ticker.last;
                }
                snapshot.candles = values;
                updated = true;
            }
        }
        if let Ok(book) = depth {
            snapshot.depth = book;
            updated = true;
        }
        snapshot.connected = updated;
        snapshot.source = if updated { "exchange" } else { "demo" }.into();
        if updated {
            last_success = Instant::now();
        } else if !stale_locked && last_success.elapsed() >= market_timeout(&app) {
            stale_locked = lock_for_stale_market(&app);
        }
        publish_snapshot(&app, &channel, &snapshot);
    }
}

fn subscription_active(app: &AppHandle, channel: &str) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    let active = state
        .runtime()
        .map(|runtime| runtime.subscriptions.contains(channel))
        .unwrap_or(false);
    active
}

fn mark_disconnected(app: &AppHandle, channel: &str, snapshot: &mut MarketSnapshot) {
    snapshot.connected = false;
    publish_snapshot(app, channel, snapshot);
}

fn publish_snapshot(app: &AppHandle, channel: &str, snapshot: &MarketSnapshot) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut runtime) = state.runtime() {
            runtime.markets.insert(
                format!(
                    "{}/{}",
                    snapshot.instrument.exchange.as_str(),
                    snapshot.instrument.symbol
                ),
                snapshot.clone(),
            );
        }
        let _ = crate::update_paper_market(&state, snapshot);
    }
    let _ = app.emit(channel, snapshot);
}

fn market_timeout(app: &AppHandle) -> Duration {
    app.try_state::<AppState>()
        .and_then(|state| state.risk_settings().ok())
        .map(|settings| Duration::from_secs(u64::from(settings.market_data_timeout_seconds)))
        .unwrap_or_else(|| Duration::from_secs(15))
}

fn lock_for_stale_market(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    let seconds = state
        .risk_settings()
        .map(|settings| settings.market_data_timeout_seconds)
        .unwrap_or(15);
    state
        .lock_live(&format!("行情断流超过 {seconds} 秒"))
        .is_ok()
}

async fn fetch_contract_depth(
    client: &Client,
    base_url: &str,
    symbol: &str,
) -> Result<DepthBook, reqwest::Error> {
    let value: Value = client
        .get(format!("{base_url}/api/v1/contract/depth/{symbol}"))
        .query(&[("limit", "20")])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let data = value.get("data").unwrap_or(&value);
    Ok(DepthBook {
        symbol: symbol.into(),
        sequence: data
            .get("version")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        updated_at: value
            .get("ts")
            .or_else(|| data.get("timestamp"))
            .and_then(Value::as_i64)
            .unwrap_or_else(|| Utc::now().timestamp_millis()),
        bids: parse_depth_levels(data.get("bids")),
        asks: parse_depth_levels(data.get("asks")),
    })
}

fn apply_mexc_message(
    snapshot: &mut MarketSnapshot,
    depth: &mut DepthSynchronizer,
    value: &Value,
) -> bool {
    let channel = value
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let data = value.get("data").unwrap_or(&Value::Null);
    match channel {
        "push.ticker" => {
            snapshot.ticker.last = decimal_value(data.get("lastPrice"));
            snapshot.ticker.change24h =
                decimal_value(data.get("riseFallRate")) * Decimal::from(100);
            snapshot.ticker.high24h = decimal_value(data.get("high24Price"));
            snapshot.ticker.low24h = decimal_value(data.get("lower24Price"));
            snapshot.ticker.volume24h = value_text(data.get("volume24"));
            snapshot.ticker.funding_rate =
                decimal_value(data.get("fundingRate")) * Decimal::from(100);
            snapshot.ticker.mark_price = decimal_value(data.get("fairPrice"));
            snapshot.ticker.index_price = decimal_value(data.get("indexPrice"));
        }
        "push.kline" => {
            let candle = Candle {
                time: data.get("t").and_then(Value::as_i64).unwrap_or_default(),
                open: f64_value(data.get("o")),
                high: f64_value(data.get("h")),
                low: f64_value(data.get("l")),
                close: f64_value(data.get("c")),
                volume: f64_value(data.get("q")),
            };
            if let Some(last) = snapshot.candles.last_mut() {
                if last.time == candle.time {
                    *last = candle;
                } else if candle.time > last.time {
                    snapshot.candles.push(candle);
                }
            } else {
                snapshot.candles.push(candle);
            }
            if snapshot.candles.len() > 1000 {
                snapshot.candles.remove(0);
            }
        }
        "push.deal" => {
            let trade = PublicTrade {
                id: format!(
                    "mexc-{}-{}",
                    data.get("t").and_then(Value::as_i64).unwrap_or_default(),
                    snapshot.trades.len()
                ),
                time: data
                    .get("t")
                    .and_then(Value::as_i64)
                    .unwrap_or_else(|| Utc::now().timestamp_millis()),
                price: decimal_value(data.get("p")),
                quantity: decimal_value(data.get("v")),
                side: if data.get("T").and_then(Value::as_i64) == Some(2) {
                    "sell"
                } else {
                    "buy"
                }
                .into(),
            };
            snapshot.trades.insert(0, trade);
            snapshot.trades.truncate(40);
        }
        "push.depth" => {
            let sequence = data
                .get("version")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            match depth.apply_delta(
                sequence,
                parse_depth_levels(data.get("bids")),
                parse_depth_levels(data.get("asks")),
            ) {
                DepthApply::Applied => {
                    if let Some(book) = depth.current() {
                        snapshot.depth = book.clone();
                    }
                }
                DepthApply::Gap { .. } => return true,
                DepthApply::IgnoredOld => {}
            }
        }
        _ => {}
    }
    false
}

fn parse_depth_levels(value: Option<&Value>) -> Vec<DepthLevel> {
    value
        .and_then(Value::as_array)
        .map(|levels| {
            levels
                .iter()
                .filter_map(|level| {
                    let values = level.as_array()?;
                    Some(DepthLevel {
                        price: decimal_value(values.first()),
                        quantity: decimal_value(values.get(1)),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn decimal_value(value: Option<&Value>) -> Decimal {
    value
        .and_then(|item| {
            item.as_str()
                .and_then(|text| Decimal::from_str(text).ok())
                .or_else(|| Decimal::from_str(&item.to_string()).ok())
        })
        .unwrap_or_default()
}

fn decimal_f64(value: f64) -> Decimal {
    Decimal::from_f64_retain(value).unwrap_or_default()
}

fn f64_value(value: Option<&Value>) -> f64 {
    value
        .and_then(|item| item.as_f64().or_else(|| item.as_str()?.parse().ok()))
        .unwrap_or_default()
}

fn value_text(value: Option<&Value>) -> String {
    value
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| item.to_string())
        })
        .unwrap_or_else(|| "0".into())
}

fn mexc_interval(value: &str) -> &'static str {
    match value {
        "1m" => "Min1",
        "5m" => "Min5",
        "15m" => "Min15",
        "30m" => "Min30",
        "1h" => "Min60",
        "4h" => "Hour4",
        "1d" => "Day1",
        _ => "Min15",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{exchange::demo_market, types::ExchangeId};
    use rust_decimal::Decimal;
    use rust_decimal_macros::dec;
    fn book() -> DepthBook {
        DepthBook {
            symbol: "BTC_USDT".into(),
            sequence: 10,
            updated_at: 0,
            bids: vec![DepthLevel {
                price: dec!(100),
                quantity: dec!(1),
            }],
            asks: vec![DepthLevel {
                price: dec!(101),
                quantity: dec!(1),
            }],
        }
    }
    #[test]
    fn gap_invalidates_book_and_requires_snapshot() {
        let mut sync = DepthSynchronizer::new();
        sync.snapshot(book());
        assert_eq!(
            sync.apply_delta(12, vec![], vec![]),
            DepthApply::Gap {
                expected: 11,
                received: 12
            }
        );
        assert!(sync.requires_snapshot());
    }
    #[test]
    fn consecutive_delta_is_applied() {
        let mut sync = DepthSynchronizer::new();
        sync.snapshot(book());
        assert_eq!(
            sync.apply_delta(
                11,
                vec![DepthLevel {
                    price: dec!(100),
                    quantity: Decimal::ZERO
                }],
                vec![]
            ),
            DepthApply::Applied
        );
    }
    #[test]
    fn depth_book_stays_bounded_after_many_new_prices() {
        let mut sync = DepthSynchronizer::new();
        sync.snapshot(book());
        let bids = (1..=200)
            .map(|price| DepthLevel {
                price: Decimal::from(price),
                quantity: dec!(1),
            })
            .collect();
        let asks = (101..=300)
            .map(|price| DepthLevel {
                price: Decimal::from(price),
                quantity: dec!(1),
            })
            .collect();
        assert_eq!(sync.apply_delta(11, bids, asks), DepthApply::Applied);
        let current = sync.current().unwrap();
        assert_eq!(current.bids.len(), MAX_DEPTH_LEVELS);
        assert_eq!(current.asks.len(), MAX_DEPTH_LEVELS);
        assert!(current
            .bids
            .windows(2)
            .all(|pair| pair[0].price >= pair[1].price));
        assert!(current
            .asks
            .windows(2)
            .all(|pair| pair[0].price <= pair[1].price));
    }
    #[test]
    fn retry_backoff_is_capped_and_honors_retry_after() {
        let mut policy = ReconnectPolicy::new();
        assert_eq!(policy.next_delay(None), Duration::from_secs(1));
        assert_eq!(policy.next_delay(None), Duration::from_secs(2));
        assert_eq!(
            policy.next_delay(Some(Duration::from_secs(40))),
            Duration::from_secs(40)
        );
    }

    #[test]
    fn mexc_public_payload_updates_ticker_and_kline() {
        let mut snapshot = demo_market(ExchangeId::Mexc, "BTC_USDT", "15m");
        let mut depth = DepthSynchronizer::new();
        depth.snapshot(book());
        let ticker = json!({
            "channel":"push.ticker",
            "data":{
                "lastPrice":120000.5,
                "riseFallRate":0.0125,
                "high24Price":121000,
                "lower24Price":117000,
                "volume24":9000,
                "fundingRate":0.0001,
                "fairPrice":120001,
                "indexPrice":119999
            }
        });
        assert!(!apply_mexc_message(&mut snapshot, &mut depth, &ticker));
        assert_eq!(snapshot.ticker.last, dec!(120000.5));
        assert_eq!(snapshot.ticker.change24h, dec!(1.25));

        let next_time = snapshot.candles.last().unwrap().time + 900;
        let kline = json!({
            "channel":"push.kline",
            "data":{"t":next_time,"o":120000,"h":120100,"l":119900,"c":120050,"q":42}
        });
        let count = snapshot.candles.len();
        assert!(!apply_mexc_message(&mut snapshot, &mut depth, &kline));
        assert_eq!(snapshot.candles.len(), count + 1);
        assert_eq!(snapshot.candles.last().unwrap().close, 120050.0);
    }
}
