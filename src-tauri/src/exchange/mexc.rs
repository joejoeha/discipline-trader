use super::{classify_symbol, parse_contract_orders, parse_contract_positions, ExchangeAdapter};
use crate::{
    error::{AppError, AppResult},
    storage::CredentialSecret,
    types::*,
};
use async_trait::async_trait;
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::{Client, Method};
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sha2::Sha256;
use std::{collections::HashMap, str::FromStr, time::Duration};

pub struct MexcAdapter {
    client: Client,
    base_url: String,
    api_url: String,
}

impl MexcAdapter {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(10))
                .user_agent("DisciplineTrader/0.1")
                .build()
                .expect("HTTP client"),
            base_url: "https://contract.mexc.com".into(),
            api_url: "https://api.mexc.com".into(),
        }
    }

    fn signed_headers(
        &self,
        credentials: &CredentialSecret,
        body: &str,
        timestamp: i64,
    ) -> AppResult<reqwest::header::HeaderMap> {
        let signature = sign_mexc(&credentials.api_key, &credentials.secret, timestamp, body)?;
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "ApiKey",
            credentials
                .api_key
                .parse()
                .map_err(|_| AppError::Validation("MEXC API Key 格式无效".into()))?,
        );
        headers.insert("Request-Time", timestamp.to_string().parse().unwrap());
        headers.insert("Recv-Window", "10".parse().unwrap());
        headers.insert("Signature", signature.parse().unwrap());
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            "application/json".parse().unwrap(),
        );
        Ok(headers)
    }

    async fn private_json(
        &self,
        method: Method,
        path: &str,
        credentials: &CredentialSecret,
        body: Value,
    ) -> AppResult<Value> {
        let payload = if body.is_null() {
            String::new()
        } else {
            serde_json::to_string(&body)?
        };
        let timestamp = Utc::now().timestamp_millis();
        let request = self
            .client
            .request(method, format!("{}{}", self.api_url, path))
            .headers(self.signed_headers(credentials, &payload, timestamp)?);
        let response = if payload.is_empty() {
            request.send().await?
        } else {
            request.body(payload).send().await?
        };
        let status = response.status();
        let value: Value = response.json().await?;
        if !status.is_success() || value.get("success").and_then(Value::as_bool) == Some(false) {
            return Err(AppError::Exchange(format!(
                "MEXC {}: {}",
                status,
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("请求失败")
            )));
        }
        Ok(value)
    }

    async fn query_by_external_id(
        &self,
        credentials: &CredentialSecret,
        symbol: &str,
        external_id: &str,
    ) -> AppResult<Option<OrderResult>> {
        let path = format!("/api/v1/private/order/external/{symbol}/{external_id}");
        let value = match self
            .private_json(Method::GET, &path, credentials, Value::Null)
            .await
        {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        let Some(data) = value.get("data").filter(|data| !data.is_null()) else {
            return Ok(None);
        };
        let state = match data.get("state").and_then(Value::as_i64) {
            Some(3) => "filled",
            Some(4) => "cancelled",
            Some(5) => "rejected",
            Some(1 | 2) => "submitted",
            _ => "unknown",
        };
        Ok(Some(OrderResult {
            accepted: !matches!(state, "rejected" | "unknown"),
            order_id: data.get("orderId").map(value_string),
            client_order_id: external_id.into(),
            state: state.into(),
            message: "已按客户端订单 ID 核对 MEXC 订单状态".into(),
            filled_quantity: decimal(data.get("dealVol")),
            average_price: Some(decimal(data.get("dealAvgPrice"))),
        }))
    }
}

#[async_trait]
impl ExchangeAdapter for MexcAdapter {
    fn id(&self) -> ExchangeId {
        ExchangeId::Mexc
    }
    async fn get_capabilities(
        &self,
        credentials: Option<&CredentialSecret>,
    ) -> AppResult<ExchangeCapabilities> {
        let account_read = if let Some(secret) = credentials {
            self.private_json(
                Method::GET,
                "/api/v1/private/account/assets",
                secret,
                Value::Null,
            )
            .await
            .is_ok()
        } else {
            false
        };
        Ok(ExchangeCapabilities {
            exchange: self.id(),
            market_data: true,
            account_read,
            live_trading: account_read,
            order_types: all_order_types(false),
            supports_reduce_only: true,
            supports_tp_sl: true,
            supports_trailing_stop: false,
            supports_hedge_mode: true,
            supports_cross_margin: true,
            reason: if account_read {
                Some("MEXC Futures API 已开放；最终下单权限由交易所和账户地区确认".into())
            } else {
                Some("尚未通过 MEXC 只读账户验证".into())
            },
            checked_at: Utc::now().timestamp_millis(),
        })
    }
    async fn get_instruments(&self) -> AppResult<Vec<Instrument>> {
        let value: Value = self
            .client
            .get(format!("{}/api/v1/contract/detail", self.base_url))
            .send()
            .await?
            .json()
            .await?;
        let data = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| AppError::Exchange("MEXC 合约列表格式异常".into()))?;
        Ok(data
            .iter()
            .filter_map(|item| {
                let symbol = item.get("symbol")?.as_str()?.to_string();
                Some(Instrument {
                    exchange: self.id(),
                    base_asset: symbol.split('_').next().unwrap_or("").into(),
                    quote_asset: "USDT".into(),
                    asset_class: classify_symbol(&symbol),
                    symbol,
                    price_tick: decimal(item.get("priceUnit")),
                    quantity_step: decimal(item.get("volUnit")),
                    min_quantity: decimal(item.get("minVol")),
                    contract_size: decimal(item.get("contractSize")),
                    max_leverage: item.get("maxLeverage").and_then(Value::as_u64).unwrap_or(1)
                        as u32,
                    status: if item.get("state").and_then(Value::as_u64) == Some(0) {
                        "online".into()
                    } else {
                        "maintenance".into()
                    },
                })
            })
            .collect())
    }
    async fn get_klines(
        &self,
        symbol: &str,
        timeframe: &str,
        limit: usize,
    ) -> AppResult<Vec<Candle>> {
        let interval = mexc_interval(timeframe);
        let value: Value = self
            .client
            .get(format!(
                "{}/api/v1/contract/kline/{}",
                self.base_url, symbol
            ))
            .query(&[("interval", interval)])
            .send()
            .await?
            .json()
            .await?;
        parse_mexc_klines(&value, limit)
    }
    async fn get_balances(&self, credentials: &CredentialSecret) -> AppResult<Vec<Balance>> {
        let value = self
            .private_json(
                Method::GET,
                "/api/v1/private/account/assets",
                credentials,
                Value::Null,
            )
            .await?;
        let empty = Vec::new();
        Ok(value
            .get("data")
            .and_then(Value::as_array)
            .unwrap_or(&empty)
            .iter()
            .map(|item| Balance {
                asset: item
                    .get("currency")
                    .and_then(Value::as_str)
                    .unwrap_or("USDT")
                    .into(),
                total: decimal(item.get("equity")),
                available: decimal(item.get("availableBalance")),
                unrealized_pnl: decimal(item.get("unrealized")),
            })
            .collect())
    }
    async fn get_positions(&self, credentials: &CredentialSecret) -> AppResult<Vec<Position>> {
        let value = self
            .private_json(
                Method::GET,
                "/api/v1/private/position/open_positions",
                credentials,
                Value::Null,
            )
            .await?;
        Ok(parse_contract_positions(self.id(), &value))
    }
    async fn get_orders(
        &self,
        credentials: &CredentialSecret,
        symbol: Option<&str>,
    ) -> AppResult<Vec<OpenOrder>> {
        let path = symbol
            .map(|value| format!("/api/v1/private/order/list/open_orders/{value}"))
            .unwrap_or_else(|| "/api/v1/private/order/list/open_orders".into());
        let value = self
            .private_json(Method::GET, &path, credentials, Value::Null)
            .await?;
        Ok(parse_contract_orders(self.id(), &value))
    }
    async fn place_order(
        &self,
        credentials: &CredentialSecret,
        intent: &OrderIntent,
    ) -> AppResult<OrderResult> {
        let body = map_mexc_order(intent);
        let value = match self
            .private_json(
                Method::POST,
                "/api/v1/private/order/create",
                credentials,
                body,
            )
            .await
        {
            Ok(value) => value,
            Err(error) => {
                return match self
                    .query_by_external_id(credentials, &intent.symbol, &intent.client_order_id)
                    .await?
                {
                    Some(result) => Ok(result),
                    None => Ok(OrderResult {
                        accepted: false,
                        order_id: None,
                        client_order_id: intent.client_order_id.clone(),
                        state: "unknown".into(),
                        message: format!("MEXC 下单状态不确定，已禁止自动重发：{error}"),
                        filled_quantity: Decimal::ZERO,
                        average_price: None,
                    }),
                };
            }
        };
        let order_id = value
            .get("data")
            .and_then(|data| data.get("orderId"))
            .map(value_string);
        Ok(OrderResult {
            accepted: order_id.is_some(),
            order_id,
            client_order_id: intent.client_order_id.clone(),
            state: "submitted".into(),
            message: "MEXC 已接受订单".into(),
            filled_quantity: Decimal::ZERO,
            average_price: None,
        })
    }
    async fn cancel_order(
        &self,
        credentials: &CredentialSecret,
        order_id: &str,
    ) -> AppResult<OrderResult> {
        self.private_json(
            Method::POST,
            "/api/v1/private/order/cancel",
            credentials,
            json!({"orderIds":[order_id]}),
        )
        .await?;
        Ok(OrderResult {
            accepted: true,
            order_id: Some(order_id.into()),
            client_order_id: String::new(),
            state: "cancelled".into(),
            message: "MEXC 已接受撤单".into(),
            filled_quantity: Decimal::ZERO,
            average_price: None,
        })
    }
    async fn cancel_all(
        &self,
        credentials: &CredentialSecret,
        symbol: Option<&str>,
    ) -> AppResult<u32> {
        self.private_json(
            Method::POST,
            "/api/v1/private/order/cancel_all",
            credentials,
            json!({"symbol":symbol.unwrap_or("")}),
        )
        .await?;
        Ok(0)
    }
    async fn set_leverage(
        &self,
        credentials: &CredentialSecret,
        symbol: &str,
        leverage: u32,
        direction: Direction,
    ) -> AppResult<()> {
        self.private_json(Method::POST, "/api/v1/private/position/change_leverage", credentials, json!({"symbol":symbol,"leverage":leverage,"positionType":if direction==Direction::Long {1}else{2}})).await?;
        Ok(())
    }
    async fn set_margin_mode(
        &self,
        _credentials: &CredentialSecret,
        _symbol: &str,
        _mode: MarginMode,
    ) -> AppResult<()> {
        Err(AppError::Exchange(
            "MEXC 保证金模式由订单 openType 指定，无需账户级切换".into(),
        ))
    }
}

pub fn sign_mexc(
    api_key: &str,
    secret: &str,
    timestamp: i64,
    parameters: &str,
) -> AppResult<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| AppError::Security("MEXC Secret 无效".into()))?;
    mac.update(format!("{api_key}{timestamp}{parameters}").as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn map_mexc_order(intent: &OrderIntent) -> Value {
    let side = match (intent.action.as_str(), intent.direction) {
        ("open", Direction::Long) => 1,
        ("close", Direction::Short) => 2,
        ("open", Direction::Short) => 3,
        _ => 4,
    };
    let order_type = match intent.order_type {
        OrderType::Limit => 1,
        OrderType::PostOnly => 2,
        OrderType::Ioc => 3,
        OrderType::Fok => 4,
        OrderType::Market => 5,
        _ => 1,
    };
    json!({ "symbol": intent.symbol, "price": intent.price.unwrap_or_default(), "vol": intent.quantity, "leverage": intent.leverage, "side": side, "type": order_type, "openType": if intent.margin_mode == MarginMode::Isolated { 1 } else { 2 }, "externalOid": intent.client_order_id, "stopLossPrice": intent.stop_loss, "takeProfitPrice": intent.take_profit, "positionMode": if intent.position_mode == PositionMode::Hedge { 1 } else { 2 }, "reduceOnly": intent.reduce_only })
}

fn value_string(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn parse_mexc_klines(value: &Value, limit: usize) -> AppResult<Vec<Candle>> {
    let data = value
        .get("data")
        .ok_or_else(|| AppError::Exchange("MEXC K线数据为空".into()))?;
    let times = data
        .get("time")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Exchange("MEXC K线格式异常".into()))?;
    let field = |name: &str, i: usize| {
        data.get(name)
            .and_then(Value::as_array)
            .and_then(|a| a.get(i))
            .map(value_f64)
            .unwrap_or(0.0)
    };
    let start = times.len().saturating_sub(limit);
    Ok((start..times.len())
        .map(|i| Candle {
            time: times[i].as_i64().unwrap_or_default(),
            open: field("open", i),
            high: field("high", i),
            low: field("low", i),
            close: field("close", i),
            volume: field("vol", i),
        })
        .collect())
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
fn value_f64(value: &Value) -> f64 {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .unwrap_or(0.0)
}
fn decimal(value: Option<&Value>) -> Decimal {
    value
        .and_then(|item| {
            item.as_str()
                .and_then(|v| Decimal::from_str(v).ok())
                .or_else(|| item.as_f64().and_then(Decimal::from_f64_retain))
        })
        .unwrap_or_default()
}
fn all_order_types(enabled: bool) -> HashMap<OrderType, bool> {
    [
        OrderType::Market,
        OrderType::Limit,
        OrderType::PostOnly,
        OrderType::Ioc,
        OrderType::Fok,
        OrderType::Trigger,
        OrderType::Trailing,
    ]
    .into_iter()
    .map(|item| (item, enabled))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn official_style_signature_is_stable() {
        assert_eq!(
            sign_mexc("key", "secret", 1_700_000_000_000, "{}").unwrap(),
            "df84fea6bbf222908eac212a0e478fb6e3b6a0b68fce9eea65e70b7da9638046"
        );
    }
    #[test]
    fn maps_direction_independently() {
        let mut intent: OrderIntent = serde_json::from_value(json!({"clientOrderId":"x","exchange":"mexc","symbol":"BTC_USDT","mode":"paper","direction":"short","action":"open","orderType":"limit","quantity":"1","price":"100","leverage":3,"marginMode":"isolated","positionMode":"hedge","reduceOnly":false,"checkMode":"block"})).unwrap();
        assert_eq!(map_mexc_order(&intent)["side"], 3);
        intent.action = "close".into();
        assert_eq!(map_mexc_order(&intent)["side"], 2);
    }
}
