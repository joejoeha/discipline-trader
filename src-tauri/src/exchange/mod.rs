mod adapter;
mod mexc;
mod ourbit;

pub use adapter::ExchangeAdapter;
pub use mexc::MexcAdapter;
pub use ourbit::OurbitAdapter;

use crate::types::*;
use chrono::Utc;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use serde_json::Value;
use std::str::FromStr;

pub fn classify_symbol(symbol: &str) -> AssetClass {
    let upper = symbol.to_ascii_uppercase();
    if upper.contains("WTI") || upper.contains("BRENT") || upper.contains("OIL") {
        return AssetClass::Oil;
    }
    if [
        "XAU",
        "XAUT",
        "GOLD",
        "XAG",
        "SILVER",
        "XPT",
        "PLATINUM",
        "XPD",
        "PALLADIUM",
    ]
    .iter()
    .any(|token| upper.contains(token))
    {
        return AssetClass::PreciousMetal;
    }
    let base = upper.split('_').next().unwrap_or(&upper);
    if upper.contains("STOCK")
        || [
            "AAPL", "AMZN", "COIN", "GOOGL", "HOOD", "MCD", "META", "MSTR", "NFLX", "NVDA", "TSLA",
        ]
        .iter()
        .any(|ticker| base == *ticker)
    {
        return AssetClass::Stock;
    }
    AssetClass::Crypto
}

pub fn demo_market(exchange: ExchangeId, symbol: &str, timeframe: &str) -> MarketSnapshot {
    let interval = match timeframe {
        "1m" => 60,
        "5m" => 300,
        "15m" => 900,
        "30m" => 1800,
        "1h" => 3600,
        "4h" => 14_400,
        "1d" => 86_400,
        _ => 900,
    };
    let base = if symbol.starts_with("ETH") {
        3784.21
    } else if symbol.starts_with("SOL") {
        186.47
    } else {
        118_642.4
    };
    let now = Utc::now().timestamp() / interval * interval;
    let mut previous = base * 0.976;
    let candles: Vec<Candle> = (0..360)
        .map(|index| {
            let index_f = index as f64;
            let scale = base * 0.00085;
            let close = base * 0.976
                + index_f * scale * 0.038
                + (index_f / 8.0).sin() * scale * 3.2
                + (index_f / 23.0).sin() * scale * 5.4;
            let open = previous;
            previous = close;
            Candle {
                time: now - (360 - index as i64) * interval,
                open,
                high: open.max(close) + scale * (0.5 + (index_f * 1.9).sin().abs()),
                low: open.min(close) - scale * (0.45 + (index_f * 1.6).cos().abs()),
                close,
                volume: 50.0 + (index_f / 3.0).sin().abs() * 290.0 + (index % 11) as f64 * 12.0,
            }
        })
        .collect();
    let last = Decimal::from_f64_retain(candles.last().map(|c| c.close).unwrap_or(base))
        .unwrap_or(dec!(0));
    let spread = last * dec!(0.00008);
    let levels = |side: Decimal| {
        (0..16)
            .map(|index| DepthLevel {
                price: (last + side * spread * Decimal::from(index + 1)).round_dp(2),
                quantity: (dec!(0.08) + Decimal::from((index * 17) % 23) / dec!(10)).round_dp(3),
            })
            .collect()
    };
    MarketSnapshot {
        instrument: Instrument {
            exchange,
            symbol: symbol.into(),
            base_asset: symbol.split('_').next().unwrap_or("BTC").into(),
            quote_asset: "USDT".into(),
            asset_class: classify_symbol(symbol),
            price_tick: dec!(0.1),
            quantity_step: dec!(0.001),
            min_quantity: dec!(0.001),
            contract_size: Decimal::ONE,
            max_leverage: 125,
            status: "online".into(),
        },
        ticker: Ticker {
            symbol: symbol.into(),
            last,
            change24h: dec!(2.84),
            high24h: last * dec!(1.017),
            low24h: last * dec!(0.972),
            volume24h: "1.28B".into(),
            funding_rate: dec!(0.0100),
            next_funding_at: Utc::now().timestamp_millis() + 3_640_000,
            mark_price: last * dec!(0.99998),
            index_price: last * dec!(1.00002),
        },
        depth: DepthBook {
            symbol: symbol.into(),
            sequence: Utc::now().timestamp_millis(),
            updated_at: Utc::now().timestamp_millis(),
            bids: levels(dec!(-1)),
            asks: levels(Decimal::ONE),
        },
        trades: (0..25)
            .map(|index| PublicTrade {
                id: format!("demo-{index}"),
                time: Utc::now().timestamp_millis() - index * 1300,
                price: last
                    + Decimal::from_str(
                        &((index as f64 * 2.7).sin()
                            * spread.to_string().parse::<f64>().unwrap_or(0.0)
                            * 5.0)
                            .to_string(),
                    )
                    .unwrap_or_default(),
                quantity: dec!(0.002) + Decimal::from((index * 7) % 31) / dec!(100),
                side: if index % 3 == 0 {
                    "sell".into()
                } else {
                    "buy".into()
                },
            })
            .collect(),
        candles,
        connected: true,
        source: "demo".into(),
    }
}

pub(crate) fn parse_contract_positions(exchange: ExchangeId, value: &Value) -> Vec<Position> {
    response_items(value)
        .into_iter()
        .filter(|item| decimal_field(item, &["holdVol", "vol"]) > Decimal::ZERO)
        .map(|item| {
            let entry_price = decimal_field(item, &["holdAvgPrice", "openAvgPrice"]);
            let liquidation = decimal_field(item, &["liquidatePrice", "liquidationPrice"]);
            Position {
                id: value_text(item.get("positionId")),
                exchange,
                symbol: item
                    .get("symbol")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .into(),
                direction: if value_i64(item.get("positionType")) == 2 {
                    Direction::Short
                } else {
                    Direction::Long
                },
                quantity: decimal_field(item, &["holdVol", "vol"]),
                entry_price,
                mark_price: {
                    let mark = decimal_field(item, &["fairPrice", "markPrice"]);
                    if mark.is_zero() {
                        entry_price
                    } else {
                        mark
                    }
                },
                liquidation_price: (!liquidation.is_zero()).then_some(liquidation),
                leverage: value_i64(item.get("leverage")).max(1) as u32,
                margin_mode: if value_i64(item.get("openType")) == 2 {
                    MarginMode::Cross
                } else {
                    MarginMode::Isolated
                },
                unrealized_pnl: decimal_field(item, &["unrealized", "unrealised", "unrealizedPnl"]),
                realized_pnl: decimal_field(item, &["realised", "realized", "profit"]),
                stop_loss: nonzero_decimal(item, &["stopLossPrice"]),
                take_profit: nonzero_decimal(item, &["takeProfitPrice"]),
            }
        })
        .collect()
}

pub(crate) fn parse_contract_orders(exchange: ExchangeId, value: &Value) -> Vec<OpenOrder> {
    response_items(value)
        .into_iter()
        .map(|item| {
            let side = value_i64(item.get("side"));
            let (action, direction) = match side {
                2 => ("close", Direction::Short),
                3 => ("open", Direction::Short),
                4 => ("close", Direction::Long),
                _ => ("open", Direction::Long),
            };
            let order_id = value_text(item.get("orderId"));
            let external_id = value_text(item.get("externalOid"));
            OpenOrder {
                intent: OrderIntent {
                    client_order_id: if external_id.is_empty() {
                        format!("{}-{order_id}", exchange.as_str())
                    } else {
                        external_id
                    },
                    exchange,
                    symbol: item
                        .get("symbol")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    mode: TradingMode::Live,
                    direction,
                    action: action.into(),
                    order_type: match value_i64(item.get("orderType")) {
                        2 => OrderType::PostOnly,
                        3 => OrderType::Ioc,
                        4 => OrderType::Fok,
                        5 => OrderType::Market,
                        _ => OrderType::Limit,
                    },
                    quantity: decimal_field(item, &["vol", "quantity"]),
                    price: nonzero_decimal(item, &["price"]),
                    trigger_price: nonzero_decimal(item, &["triggerPrice"]),
                    trailing_percent: None,
                    leverage: value_i64(item.get("leverage")).max(1) as u32,
                    margin_mode: if value_i64(item.get("openType")) == 2 {
                        MarginMode::Cross
                    } else {
                        MarginMode::Isolated
                    },
                    position_mode: if value_i64(item.get("positionMode")) == 2 {
                        PositionMode::OneWay
                    } else {
                        PositionMode::Hedge
                    },
                    reduce_only: action == "close",
                    take_profit: nonzero_decimal(item, &["takeProfitPrice"]),
                    stop_loss: nonzero_decimal(item, &["stopLossPrice"]),
                    plan_id: None,
                    check_mode: CheckMode::Off,
                },
                order_id,
                status: match value_i64(item.get("state")) {
                    2 => "partial",
                    3 => "filled",
                    4 => "cancelled",
                    5 => "rejected",
                    _ => "submitted",
                }
                .into(),
                filled_quantity: decimal_field(item, &["dealVol", "filledQuantity"]),
                created_at: value_i64(item.get("createTime")),
            }
        })
        .collect()
}

fn response_items(value: &Value) -> Vec<&Value> {
    let data = value.get("data").unwrap_or(value);
    data.as_array()
        .or_else(|| data.get("resultList").and_then(Value::as_array))
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn decimal_field(item: &Value, names: &[&str]) -> Decimal {
    names
        .iter()
        .find_map(|name| item.get(*name))
        .and_then(|value| {
            value
                .as_str()
                .and_then(|text| Decimal::from_str(text).ok())
                .or_else(|| Decimal::from_str(&value.to_string()).ok())
        })
        .unwrap_or_default()
}

fn nonzero_decimal(item: &Value, names: &[&str]) -> Option<Decimal> {
    let value = decimal_field(item, names);
    (!value.is_zero()).then_some(value)
}

fn value_i64(value: Option<&Value>) -> i64 {
    value
        .and_then(|item| {
            item.as_i64()
                .or_else(|| item.as_str().and_then(|text| text.parse().ok()))
        })
        .unwrap_or_default()
}

fn value_text(value: Option<&Value>) -> String {
    value
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| item.to_string().trim_matches('"').into())
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod mapping_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_supported_asset_routes() {
        assert_eq!(classify_symbol("BTC_USDT"), AssetClass::Crypto);
        assert_eq!(classify_symbol("NVDA_USDT"), AssetClass::Stock);
        assert_eq!(classify_symbol("TSLASTOCK_USDT"), AssetClass::Stock);
        assert_eq!(classify_symbol("WTI_USDT"), AssetClass::Oil);
        assert_eq!(classify_symbol("BRENT_USDT"), AssetClass::Oil);
        assert_eq!(classify_symbol("XAU_USDT"), AssetClass::PreciousMetal);
        assert_eq!(classify_symbol("XAG_USDT"), AssetClass::PreciousMetal);
    }

    #[test]
    fn default_routing_matches_user_asset_split() {
        let routing = RoutingSettings::user_default();
        assert_eq!(
            routing.preferred_exchange(AssetClass::Crypto),
            ExchangeId::Ourbit
        );
        assert_eq!(
            routing.preferred_exchange(AssetClass::Stock),
            ExchangeId::Mexc
        );
        assert_eq!(
            routing.preferred_exchange(AssetClass::Oil),
            ExchangeId::Mexc
        );
        assert_eq!(
            routing.preferred_exchange(AssetClass::PreciousMetal),
            ExchangeId::Mexc
        );
        assert_eq!(routing.ourbit_fees.maker_percent, dec!(0.008));
        assert_eq!(routing.ourbit_fees.taker_percent, dec!(0.025));
        assert_eq!(
            routing
                .effective_fees(ExchangeId::Mexc, AssetClass::Stock)
                .maker_percent,
            Decimal::ZERO
        );
        assert_eq!(
            routing
                .effective_fees(ExchangeId::Mexc, AssetClass::Oil)
                .taker_percent,
            Decimal::ZERO
        );
        assert_eq!(
            routing
                .effective_fees(ExchangeId::Mexc, AssetClass::PreciousMetal)
                .maker_percent,
            Decimal::ZERO
        );
        assert_eq!(
            routing
                .effective_fees(ExchangeId::Mexc, AssetClass::Crypto)
                .taker_percent,
            dec!(0.08)
        );
    }

    #[test]
    fn maps_live_position_and_close_order_without_guessing_side() {
        let positions = parse_contract_positions(
            ExchangeId::Ourbit,
            &json!({"data":[{"positionId":7,"symbol":"BTC_USDT","positionType":2,"openType":1,"holdVol":"3","holdAvgPrice":"100","liquidatePrice":"130","leverage":5,"unrealized":"-2"}]}),
        );
        assert_eq!(positions[0].direction, Direction::Short);
        assert_eq!(positions[0].quantity, dec!(3));

        let orders = parse_contract_orders(
            ExchangeId::Ourbit,
            &json!({"data":[{"orderId":9,"symbol":"BTC_USDT","side":4,"orderType":2,"vol":"1","price":"101","leverage":5,"openType":1,"state":1}]}),
        );
        assert_eq!(orders[0].intent.action, "close");
        assert_eq!(orders[0].intent.direction, Direction::Long);
        assert!(orders[0].intent.reduce_only);
    }
}
