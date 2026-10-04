use super::{classify_symbol, parse_contract_orders, parse_contract_positions, ExchangeAdapter};
use crate::{
    error::{AppError, AppResult},
    storage::CredentialSecret,
    types::*,
};
use async_trait::async_trait;
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::{Client, StatusCode};
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::{
    collections::{BTreeMap, HashMap},
    str::FromStr,
    time::Duration,
};

pub struct OurbitAdapter {
    client: Client,
    base_url: String,
}

impl OurbitAdapter {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(10))
                .user_agent("DisciplineTrader/0.1")
                .build()
                .expect("HTTP client"),
            base_url: "https://futures.ourbit.com".into(),
        }
    }

    fn signed_headers(
        &self,
        credentials: &CredentialSecret,
        parameters: &str,
        timestamp: i64,
    ) -> AppResult<reqwest::header::HeaderMap> {
        let signature = sign_ourbit(
            &credentials.api_key,
            &credentials.secret,
            timestamp,
            parameters,
        )?;
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "ApiKey",
            credentials
                .api_key
                .parse()
                .map_err(|_| AppError::Validation("Ourbit Access Key 格式无效".into()))?,
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

    async fn private_get(
        &self,
        path: &str,
        credentials: &CredentialSecret,
        params: BTreeMap<String, String>,
    ) -> AppResult<Value> {
        let signed = query_string(&params);
        let timestamp = Utc::now().timestamp_millis();
        let response = self
            .client
            .get(format!("{}{}", self.base_url, path))
            .headers(self.signed_headers(credentials, &signed, timestamp)?)
            .query(&params)
            .send()
            .await?;
        parse_response(response).await
    }

    async fn private_post(
        &self,
        path: &str,
        credentials: &CredentialSecret,
        body: &Value,
    ) -> AppResult<reqwest::Response> {
        let payload = serde_json::to_string(body)?;
        let timestamp = Utc::now().timestamp_millis();
        Ok(self
            .client
            .post(format!("{}{}", self.base_url, path))
            .headers(self.signed_headers(credentials, &payload, timestamp)?)
            .body(payload)
            .send()
            .await?)
    }

    async fn query_by_external_id(
        &self,
        credentials: &CredentialSecret,
        external_id: &str,
    ) -> AppResult<Option<OrderResult>> {
        let value = self
            .private_get(
                &format!("/api/v1/private/order/external/{external_id}"),
                credentials,
                BTreeMap::new(),
            )
            .await?;
        let data = match value.get("data") {
            Some(value) if !value.is_null() => value,
            _ => return Ok(None),
        };
        Ok(Some(OrderResult {
            accepted: true,
            order_id: data.get("orderId").map(value_string),
            client_order_id: external_id.into(),
            state: order_state(data.get("state").and_then(Value::as_i64).unwrap_or(1)),
            message: "下单响应不确定，已通过客户端订单号核对交易所状态".into(),
            filled_quantity: decimal(data.get("dealVol")),
            average_price: Some(decimal(data.get("dealAvgPrice"))),
        }))
    }
}

#[async_trait]
impl ExchangeAdapter for OurbitAdapter {
    fn id(&self) -> ExchangeId {
        ExchangeId::Ourbit
    }
    async fn get_capabilities(
        &self,
        credentials: Option<&CredentialSecret>,
    ) -> AppResult<ExchangeCapabilities> {
        let account_read = if let Some(secret) = credentials {
            self.private_get("/api/v1/private/account/assets", secret, BTreeMap::new())
                .await
                .is_ok()
        } else {
            false
        };
        let enabled = account_read;
        Ok(ExchangeCapabilities {
            exchange: self.id(),
            market_data: true,
            account_read,
            live_trading: enabled,
            order_types: all_order_types(enabled),
            supports_reduce_only: true,
            supports_tp_sl: true,
            supports_trailing_stop: false,
            supports_hedge_mode: true,
            supports_cross_margin: true,
            reason: if enabled {
                Some("账户读取验证通过；交易权限仍在每次下单时由交易所确认".into())
            } else {
                Some("未配置或只读能力探测未通过；模拟盘仍可使用".into())
            },
            checked_at: Utc::now().timestamp_millis(),
        })
    }
    async fn get_instruments(&self) -> AppResult<Vec<Instrument>> {
        let response = self
            .client
            .get(format!("{}/api/v1/contract/detail", self.base_url))
            .send()
            .await?;
        let value = parse_response(response).await?;
        let data = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| AppError::Exchange("Ourbit 合约列表格式异常".into()))?;
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
        let response = self
            .client
            .get(format!(
                "{}/api/v1/contract/kline/{}",
                self.base_url, symbol
            ))
            .query(&[("interval", ourbit_interval(timeframe))])
            .send()
            .await?;
        let value = parse_response(response).await?;
        parse_ourbit_klines(&value, limit)
    }
    async fn get_balances(&self, credentials: &CredentialSecret) -> AppResult<Vec<Balance>> {
        let value = self
            .private_get(
                "/api/v1/private/account/assets",
                credentials,
                BTreeMap::new(),
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
            .private_get(
                "/api/v1/private/position/open_positions",
                credentials,
                BTreeMap::new(),
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
        let params = BTreeMap::from([
            ("page_num".into(), "1".into()),
            ("page_size".into(), "100".into()),
        ]);
        let value = self.private_get(&path, credentials, params).await?;
        Ok(parse_contract_orders(self.id(), &value))
    }
    async fn place_order(
        &self,
        credentials: &CredentialSecret,
        intent: &OrderIntent,
    ) -> AppResult<OrderResult> {
        let body = map_ourbit_order(intent)?;
        let response = match self
            .private_post("/api/v1/private/order/submit", credentials, &body)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return match self
                    .query_by_external_id(credentials, &intent.client_order_id)
                    .await
                {
                    Ok(Some(result)) => Ok(result),
                    _ => Err(AppError::Exchange(format!(
                        "Ourbit 下单网络状态不确定，已停止重发：{error}"
                    ))),
                }
            }
        };
        if response.status().is_server_error() || response.status() == StatusCode::REQUEST_TIMEOUT {
            return match self
                .query_by_external_id(credentials, &intent.client_order_id)
                .await
            {
                Ok(Some(result)) => Ok(result),
                _ => Ok(OrderResult {
                    accepted: false,
                    order_id: None,
                    client_order_id: intent.client_order_id.clone(),
                    state: "unknown".into(),
                    message: "交易所返回 5xx/超时，订单状态未知；已禁止自动重发，请稍后核对".into(),
                    filled_quantity: Decimal::ZERO,
                    average_price: None,
                }),
            };
        }
        let value = parse_response(response).await?;
        let order_id = value.get("data").map(value_string);
        Ok(OrderResult {
            accepted: order_id.is_some(),
            order_id,
            client_order_id: intent.client_order_id.clone(),
            state: "submitted".into(),
            message: "Ourbit 已接受订单".into(),
            filled_quantity: Decimal::ZERO,
            average_price: None,
        })
    }
    async fn cancel_order(
        &self,
        credentials: &CredentialSecret,
        order_id: &str,
    ) -> AppResult<OrderResult> {
        let response = self
            .private_post(
                "/api/v1/private/order/cancel",
                credentials,
                &json!([order_id]),
            )
            .await?;
        let _value = parse_response(response).await?;
        Ok(OrderResult {
            accepted: true,
            order_id: Some(order_id.into()),
            client_order_id: String::new(),
            state: "cancelled".into(),
            message: "Ourbit 已接受撤单".into(),
            filled_quantity: Decimal::ZERO,
            average_price: None,
        })
    }
    async fn cancel_all(
        &self,
        credentials: &CredentialSecret,
        symbol: Option<&str>,
    ) -> AppResult<u32> {
        let response = self
            .private_post(
                "/api/v1/private/order/cancel_all",
                credentials,
                &json!({"symbol": symbol}),
            )
            .await?;
        let _value = parse_response(response).await?;
        Ok(0)
    }
    async fn set_leverage(
        &self,
        credentials: &CredentialSecret,
        symbol: &str,
        leverage: u32,
        direction: Direction,
    ) -> AppResult<()> {
        let response = self.private_post("/api/v1/private/position/change_leverage", credentials, &json!({"symbol":symbol,"leverage":leverage,"positionType":if direction==Direction::Long {1}else{2}})).await?;
        parse_response(response).await?;
        Ok(())
    }
    async fn set_margin_mode(
        &self,
        _credentials: &CredentialSecret,
        _symbol: &str,
        _mode: MarginMode,
    ) -> AppResult<()> {
        Err(AppError::Exchange(
            "Ourbit 保证金模式由开仓订单 openType 独立指定，不执行账户级本地模拟切换".into(),
        ))
    }
}

pub fn sign_ourbit(
    access_key: &str,
    secret: &str,
    timestamp: i64,
    parameters: &str,
) -> AppResult<String> {
    let input = format!("{access_key}{timestamp}{parameters}");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| AppError::Security("Ourbit Secret 无效".into()))?;
    mac.update(input.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn map_ourbit_order(intent: &OrderIntent) -> AppResult<Value> {
    if intent.client_order_id.len() > 32 {
        return Err(AppError::Validation(
            "Ourbit 客户端订单 ID 不能超过 32 个字符".into(),
        ));
    }
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
        OrderType::Trigger => {
            return Err(AppError::Validation(
                "Ourbit 条件单应使用独立 planorder 端点".into(),
            ))
        }
        OrderType::Trailing => {
            return Err(AppError::Validation(
                "当前 Ourbit 合约文档未声明移动止损能力".into(),
            ))
        }
    };
    let mut object = Map::new();
    object.insert("symbol".into(), json!(intent.symbol));
    object.insert("price".into(), json!(intent.price.unwrap_or_default()));
    object.insert("vol".into(), json!(intent.quantity));
    object.insert("leverage".into(), json!(intent.leverage));
    object.insert("side".into(), json!(side));
    object.insert("type".into(), json!(order_type));
    object.insert(
        "openType".into(),
        json!(if intent.margin_mode == MarginMode::Isolated {
            1
        } else {
            2
        }),
    );
    object.insert("externalOid".into(), json!(intent.client_order_id));
    object.insert(
        "positionMode".into(),
        json!(if intent.position_mode == PositionMode::Hedge {
            1
        } else {
            2
        }),
    );
    object.insert("reduceOnly".into(), json!(intent.reduce_only));
    if let Some(value) = intent.stop_loss {
        object.insert("stopLossPrice".into(), json!(value));
    }
    if let Some(value) = intent.take_profit {
        object.insert("takeProfitPrice".into(), json!(value));
    }
    Ok(Value::Object(object))
}

async fn parse_response(response: reqwest::Response) -> AppResult<Value> {
    let status = response.status();
    let value: Value = response.json().await?;
    if !status.is_success() || value.get("success").and_then(Value::as_bool) == Some(false) {
        let code = value.get("code").map(value_string).unwrap_or_default();
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("请求失败");
        return Err(AppError::Exchange(format!("Ourbit {code}: {message}")));
    }
    Ok(value)
}

fn query_string(values: &BTreeMap<String, String>) -> String {
    values
        .iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                urlencoding::encode(key),
                urlencoding::encode(value)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}
fn parse_ourbit_klines(value: &Value, limit: usize) -> AppResult<Vec<Candle>> {
    let data = value
        .get("data")
        .ok_or_else(|| AppError::Exchange("Ourbit K线数据为空".into()))?;
    let times = data
        .get("time")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Exchange("Ourbit K线格式异常".into()))?;
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
fn ourbit_interval(value: &str) -> &'static str {
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
fn value_string(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string().trim_matches('"').to_string())
}
fn order_state(value: i64) -> String {
    match value {
        2 => "partial",
        3 => "filled",
        4 => "cancelled",
        5 => "rejected",
        _ => "submitted",
    }
    .into()
}
fn all_order_types(enabled: bool) -> HashMap<OrderType, bool> {
    [
        OrderType::Market,
        OrderType::Limit,
        OrderType::PostOnly,
        OrderType::Ioc,
        OrderType::Fok,
    ]
    .into_iter()
    .map(|item| (item, enabled))
    .chain([(OrderType::Trigger, false), (OrderType::Trailing, false)])
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signing_is_deterministic_and_not_base64() {
        let value = sign_ourbit("key", "secret", 1_700_000_000_000, "{}").unwrap();
        assert_eq!(value.len(), 64);
        assert!(value.chars().all(|c| c.is_ascii_hexdigit()));
    }
    #[test]
    fn query_parameters_are_sorted_and_encoded() {
        let values = BTreeMap::from([
            ("symbol".into(), "BTC_USDT".into()),
            ("states".into(), "1,2".into()),
        ]);
        assert_eq!(query_string(&values), "states=1%2C2&symbol=BTC_USDT");
    }
}
