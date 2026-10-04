mod error;
mod exchange;
mod market_stream;
mod risk;
mod state;
mod storage;
mod types;

use crate::{
    error::{AppError, AppResult},
    exchange::{classify_symbol, demo_market},
    market_stream::{run_mexc_market_stream, run_ourbit_market_poll},
    risk::{prepare_review, validate_risk_settings},
    state::AppState,
    storage::CredentialSecret,
    types::*,
};
use chrono::{Duration, TimeZone, Timelike, Utc};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroize;

#[tauri::command]
async fn bootstrap(state: State<'_, AppState>) -> AppResult<BootstrapState> {
    let mut capabilities = Vec::new();
    let mut credentials = Vec::new();
    for exchange in [ExchangeId::Mexc, ExchangeId::Ourbit] {
        let secret = state.secrets.load(exchange)?;
        let cached = {
            let runtime = state.runtime()?;
            runtime.capabilities.get(&exchange).cloned()
        };
        let mut capability = if let Some(cached) = cached {
            cached
        } else {
            state
                .adapter(exchange)?
                .get_capabilities(secret.as_ref())
                .await?
        };
        let metadata = state.db.credential_status(exchange)?;
        if let Some(metadata) = &metadata {
            if !metadata.permissions.iter().any(|value| value == "trade") {
                capability.live_trading = false;
                capability.reason = Some("API Key 未声明交易权限".into());
            }
            if metadata
                .expires_at
                .is_some_and(|expires| expires <= Utc::now().timestamp_millis())
            {
                capability.live_trading = false;
                capability.reason = Some("API Key 已超过登记的到期时间，请重新验证".into());
                state.lock_live("API Key 已到期")?;
            }
        }
        state
            .runtime()?
            .capabilities
            .insert(exchange, capability.clone());
        capabilities.push(capability);
        credentials.push(metadata.unwrap_or(CredentialStatus {
            exchange,
            configured: false,
            verified: false,
            permissions: Vec::new(),
            expires_at: None,
            last_verified_at: None,
            message: "尚未配置".into(),
        }));
    }
    let runtime = state.runtime()?;
    let unlocked_until = runtime
        .live_unlocked_until
        .filter(|value| *value > Utc::now().timestamp_millis());
    let live_lock = LiveLockState {
        locked: unlocked_until.is_none(),
        emergency_stopped: runtime.emergency_stopped,
        reasons: runtime.lock_reasons.clone(),
        unlocked_until,
    };
    drop(runtime);
    let balance = state
        .db
        .get_setting::<Decimal>("paper_balance")?
        .unwrap_or(dec!(10000));
    let positions = state.db.list_positions()?;
    let unrealized = positions
        .iter()
        .fold(Decimal::ZERO, |sum, item| sum + item.unrealized_pnl);
    let used_margin = positions.iter().fold(Decimal::ZERO, |sum, item| {
        sum + item.quantity * item.entry_price / Decimal::from(item.leverage.max(1))
    });
    let available = (balance - used_margin).max(Decimal::ZERO);
    Ok(BootstrapState {
        mode: TradingMode::Paper,
        selected_exchange: ExchangeId::Ourbit,
        selected_symbol: "BTC_USDT".into(),
        capabilities,
        credentials,
        risk_settings: state.db.get_setting("risk_settings")?,
        routing_settings: state
            .db
            .get_setting("routing_settings")?
            .unwrap_or_else(RoutingSettings::user_default),
        live_lock,
        plans: state.db.list_plans()?,
        positions,
        orders: state.db.list_orders()?,
        balances: vec![Balance {
            asset: "USDT".into(),
            total: balance,
            available,
            unrealized_pnl: unrealized,
        }],
        fills: state.db.list_fills()?,
        reviews: state.db.list_reviews()?,
        risk_events: state.db.list_risk_events()?,
    })
}

#[tauri::command]
async fn get_capabilities(
    exchange: ExchangeId,
    refresh: bool,
    state: State<'_, AppState>,
) -> AppResult<ExchangeCapabilities> {
    if !refresh {
        let cached = {
            let runtime = state.runtime()?;
            runtime.capabilities.get(&exchange).cloned()
        };
        if let Some(value) = cached {
            return Ok(value);
        }
    }
    let secret = state.secrets.load(exchange)?;
    let mut capability = state
        .adapter(exchange)?
        .get_capabilities(secret.as_ref())
        .await?;
    if let Some(metadata) = state.db.credential_status(exchange)? {
        if !metadata.permissions.iter().any(|value| value == "trade") {
            capability.live_trading = false;
            capability.reason = Some("API Key 未声明交易权限".into());
        }
    }
    state
        .runtime()?
        .capabilities
        .insert(exchange, capability.clone());
    state.db.audit("exchange", "capability_probe", serde_json::json!({"exchange":exchange,"marketData":capability.market_data,"accountRead":capability.account_read,"liveTrading":capability.live_trading}))?;
    Ok(capability)
}

#[tauri::command]
async fn get_klines(
    exchange: ExchangeId,
    symbol: String,
    timeframe: String,
    limit: usize,
    state: State<'_, AppState>,
) -> AppResult<Vec<Candle>> {
    match state
        .adapter(exchange)?
        .get_klines(&symbol, &timeframe, limit.min(1000))
        .await
    {
        Ok(values) if !values.is_empty() => Ok(values),
        _ => Ok(demo_market(exchange, &symbol, &timeframe)
            .candles
            .into_iter()
            .rev()
            .take(limit)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()),
    }
}

#[tauri::command]
async fn get_market(
    exchange: ExchangeId,
    symbol: String,
    timeframe: String,
    state: State<'_, AppState>,
) -> AppResult<MarketSnapshot> {
    let mut market = demo_market(exchange, &symbol, &timeframe);
    if let Ok(candles) = state
        .adapter(exchange)?
        .get_klines(&symbol, &timeframe, 360)
        .await
    {
        if !candles.is_empty() {
            if let Some(last) = candles.last() {
                if let Some(last_price) = Decimal::from_f64_retain(last.close) {
                    market.ticker.last = last_price;
                    market.ticker.mark_price = last_price;
                    market.ticker.index_price = last_price;
                }
            }
            market.candles = candles;
            market.source = "exchange".into();
        }
    }
    market.connected = false;
    state
        .runtime()?
        .markets
        .insert(format!("{}/{}", exchange.as_str(), symbol), market.clone());
    Ok(market)
}

#[tauri::command]
async fn subscribe_market(
    exchange: ExchangeId,
    symbol: String,
    timeframe: String,
    channel: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let expected = format!("market://{}/{}/{}", exchange.as_str(), symbol, timeframe);
    if channel != expected {
        return Err(AppError::Security("行情事件通道不匹配".into()));
    }
    if !state.runtime()?.subscriptions.insert(channel.clone()) {
        return Ok(());
    }
    let adapter = state.adapter(exchange)?;
    let mut initial = demo_market(exchange, &symbol, &timeframe);
    if let Ok(candles) = adapter.get_klines(&symbol, &timeframe, 360).await {
        if !candles.is_empty() {
            initial.candles = candles;
            initial.source = "exchange".into();
        }
    }
    match exchange {
        ExchangeId::Mexc => {
            tauri::async_runtime::spawn(run_mexc_market_stream(
                app, channel, symbol, timeframe, initial,
            ));
        }
        ExchangeId::Ourbit => {
            tauri::async_runtime::spawn(run_ourbit_market_poll(
                app, channel, symbol, timeframe, adapter, initial,
            ));
        }
    }
    Ok(())
}

#[tauri::command]
fn unsubscribe_market(channel: String, state: State<'_, AppState>) -> AppResult<()> {
    state.runtime()?.subscriptions.remove(&channel);
    Ok(())
}

#[tauri::command]
async fn get_instruments(
    exchange: ExchangeId,
    state: State<'_, AppState>,
) -> AppResult<Vec<Instrument>> {
    state.adapter(exchange)?.get_instruments().await
}

#[tauri::command]
async fn sync_live_account(
    exchange: ExchangeId,
    state: State<'_, AppState>,
) -> AppResult<AccountSnapshot> {
    let credentials = state
        .secrets
        .load(exchange)?
        .ok_or_else(|| AppError::Security("交易所凭据不存在".into()))?;
    let adapter = state.adapter(exchange)?;
    let (balances, positions, orders) = tokio::try_join!(
        adapter.get_balances(&credentials),
        adapter.get_positions(&credentials),
        adapter.get_orders(&credentials, None)
    )?;
    let snapshot = AccountSnapshot {
        exchange,
        balances,
        positions,
        orders,
        synced_at: Utc::now().timestamp_millis(),
    };
    state.db.audit(
        "account",
        "live_state_synced",
        serde_json::json!({
            "exchange": exchange,
            "balances": snapshot.balances.len(),
            "positions": snapshot.positions.len(),
            "orders": snapshot.orders.len()
        }),
    )?;
    Ok(snapshot)
}

#[tauri::command]
async fn set_exchange_leverage(
    exchange: ExchangeId,
    symbol: String,
    leverage: u32,
    direction: Direction,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let settings = state.risk_settings()?;
    if leverage == 0 || (settings.enforce_global_limits && leverage > settings.max_leverage) {
        return Err(AppError::Risk("杠杆超过全局风险上限".into()));
    }
    let credentials = state
        .secrets
        .load(exchange)?
        .ok_or_else(|| AppError::Security("交易所凭据不存在".into()))?;
    state
        .adapter(exchange)?
        .set_leverage(&credentials, &symbol, leverage, direction)
        .await
}

#[tauri::command]
async fn set_exchange_margin_mode(
    exchange: ExchangeId,
    symbol: String,
    mode: MarginMode,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let credentials = state
        .secrets
        .load(exchange)?
        .ok_or_else(|| AppError::Security("交易所凭据不存在".into()))?;
    state
        .adapter(exchange)?
        .set_margin_mode(&credentials, &symbol, mode)
        .await
}

#[tauri::command]
async fn save_credentials(
    mut input: CredentialInput,
    state: State<'_, AppState>,
) -> AppResult<CredentialStatus> {
    if input
        .declared_permissions
        .iter()
        .any(|value| value.eq_ignore_ascii_case("withdraw"))
    {
        input.api_key.zeroize();
        input.secret.zeroize();
        return Err(AppError::Security(
            "检测到提现权限，拒绝保存。请创建仅读取与交易权限的 API Key".into(),
        ));
    }
    if !input
        .declared_permissions
        .iter()
        .any(|value| value == "read")
    {
        return Err(AppError::Validation("API Key 必须包含读取权限".into()));
    }
    if input
        .expires_at
        .is_some_and(|expires| expires <= Utc::now().timestamp_millis())
    {
        return Err(AppError::Validation(
            "API Key 到期时间必须晚于当前时间".into(),
        ));
    }
    let secret = CredentialSecret {
        api_key: input.api_key.clone(),
        secret: input.secret.clone(),
        passphrase: input.passphrase.clone(),
    };
    let capability = state
        .adapter(input.exchange)?
        .get_capabilities(Some(&secret))
        .await?;
    if !capability.account_read {
        return Err(AppError::Security("只读权限验证未通过，凭据未保存".into()));
    }
    state.secrets.save(input.exchange, &secret)?;
    let now = Utc::now().timestamp_millis();
    let status = CredentialStatus {
        exchange: input.exchange,
        configured: true,
        verified: true,
        permissions: input.declared_permissions.clone(),
        expires_at: input.expires_at,
        last_verified_at: Some(now),
        message: if capability.live_trading {
            "读取权限已验证；交易权限将在实盘提交时由交易所最终确认".into()
        } else {
            capability
                .reason
                .clone()
                .unwrap_or_else(|| "读取能力已验证；实盘能力不可用".into())
        },
    };
    state.db.save_credential_status(&status)?;
    state
        .runtime()?
        .capabilities
        .insert(input.exchange, capability);
    state.db.audit("security", "credentials_saved", serde_json::json!({"exchange":input.exchange,"permissions":input.declared_permissions,"expiresAt":input.expires_at}))?;
    input.api_key.zeroize();
    input.secret.zeroize();
    Ok(status)
}

#[tauri::command]
fn remove_credentials(exchange: ExchangeId, state: State<'_, AppState>) -> AppResult<()> {
    state.secrets.delete(exchange)?;
    state.db.delete_credential_status(exchange)?;
    state.runtime()?.capabilities.remove(&exchange);
    state.lock_live("交易所凭据已删除")
}

#[tauri::command]
fn save_risk_settings(
    settings: RiskSettings,
    state: State<'_, AppState>,
) -> AppResult<RiskSettings> {
    validate_risk_settings(&settings)?;
    state.db.set_setting("risk_settings", &settings)?;
    state
        .db
        .audit("risk", "settings_updated", serde_json::to_value(&settings)?)?;
    Ok(settings)
}

#[tauri::command]
fn save_routing_settings(
    mut settings: RoutingSettings,
    state: State<'_, AppState>,
) -> AppResult<RoutingSettings> {
    for profile in [&settings.mexc_fees, &settings.ourbit_fees] {
        if profile.maker_percent < Decimal::ZERO
            || profile.taker_percent < Decimal::ZERO
            || profile.maker_percent > Decimal::ONE
            || profile.taker_percent > Decimal::ONE
        {
            return Err(AppError::Validation(
                "Maker/Taker 费率必须在 0–1% 之间".into(),
            ));
        }
    }
    settings.updated_at = Utc::now().timestamp_millis();
    state.db.set_setting("routing_settings", &settings)?;
    state.db.audit(
        "routing",
        "settings_updated",
        serde_json::json!({
            "crypto": settings.crypto_exchange,
            "stock": settings.stock_exchange,
            "oil": settings.oil_exchange,
            "preciousMetal": settings.precious_metal_exchange,
            "mexcMaker": settings.mexc_fees.maker_percent,
            "mexcTaker": settings.mexc_fees.taker_percent,
            "ourbitMaker": settings.ourbit_fees.maker_percent,
            "ourbitTaker": settings.ourbit_fees.taker_percent
        }),
    )?;
    Ok(settings)
}
#[tauri::command]
fn set_pin(pin: String, state: State<'_, AppState>) -> AppResult<()> {
    state.set_pin(&pin)
}
#[tauri::command]
fn unlock_live(pin: String, state: State<'_, AppState>) -> AppResult<()> {
    if state
        .db
        .get_setting::<RiskSettings>("risk_settings")?
        .is_none()
    {
        return Err(AppError::Risk("首次启用实盘前必须保存全部风险参数".into()));
    }
    state.unlock_live(&pin)
}
#[tauri::command]
fn lock_live(reason: Option<String>, state: State<'_, AppState>) -> AppResult<()> {
    state.lock_live(reason.as_deref().unwrap_or("用户手动锁定"))
}
#[tauri::command]
fn emergency_stop(reason: String, state: State<'_, AppState>) -> AppResult<()> {
    let mut runtime = state.runtime()?;
    runtime.emergency_stopped = true;
    runtime.live_unlocked_until = None;
    runtime.lock_reasons.push(reason.clone());
    drop(runtime);
    state.db.set_setting("emergency_stopped", &true)?;
    state.db.record_risk_event("emergency_stop", &reason)?;
    state.db.audit(
        "risk",
        "emergency_stop",
        serde_json::json!({"reason":reason}),
    )
}
#[tauri::command]
fn clear_emergency_stop(pin: String, state: State<'_, AppState>) -> AppResult<()> {
    state.verify_pin(&pin)?;
    let mut runtime = state.runtime()?;
    runtime.emergency_stopped = false;
    runtime
        .lock_reasons
        .retain(|value| !value.contains("立即停止"));
    drop(runtime);
    state.db.set_setting("emergency_stopped", &false)?;
    state
        .db
        .audit("risk", "emergency_stop_cleared", serde_json::json!({}))
}

#[tauri::command]
fn list_plans(state: State<'_, AppState>) -> AppResult<Vec<TradingPlan>> {
    state.db.list_plans()
}
#[tauri::command]
fn save_plan(mut plan: TradingPlan, state: State<'_, AppState>) -> AppResult<TradingPlan> {
    if plan.cooldown_minutes == 0 {
        return Err(AppError::Validation("冷静期至少为 1 分钟".into()));
    }
    if plan.name.trim().is_empty() || plan.trigger_condition.trim().is_empty() {
        return Err(AppError::Validation("计划名称与触发条件不能为空".into()));
    }
    let now = Utc::now().timestamp_millis();
    if plan.id.is_empty() {
        plan.id = uuid::Uuid::new_v4().to_string();
        plan.created_at = now;
        plan.status = "draft".into();
    }
    plan.updated_at = now;
    state.db.save_plan(&plan)?;
    state.db.audit(
        "plan",
        "saved",
        serde_json::json!({"planId":plan.id,"status":plan.status}),
    )?;
    Ok(plan)
}
#[tauri::command]
fn arm_plan(plan_id: String, state: State<'_, AppState>) -> AppResult<TradingPlan> {
    let mut plan = find_plan(&state, &plan_id)?;
    if plan.stop_loss <= Decimal::ZERO
        || plan.targets.is_empty()
        || plan.allowed_order_types.is_empty()
        || plan.entry_reason.trim().is_empty()
        || plan.take_profit_reason.trim().is_empty()
    {
        return Err(AppError::Validation(
            "启用前必须填写止损、目标位、下单原因、止盈原因和允许订单类型".into(),
        ));
    }
    plan.status = "armed".into();
    plan.armed_at = Some(Utc::now().timestamp_millis());
    plan.updated_at = Utc::now().timestamp_millis();
    state.db.save_plan(&plan)?;
    state
        .db
        .audit("plan", "armed", serde_json::json!({"planId":plan.id}))?;
    Ok(plan)
}
#[tauri::command]
fn trigger_plan(plan_id: String, state: State<'_, AppState>) -> AppResult<TradingPlan> {
    let mut plan = find_plan(&state, &plan_id)?;
    if plan.status != "armed" {
        return Err(AppError::Validation(
            "只有等待触发的计划可以标记为触发".into(),
        ));
    }
    let now = Utc::now().timestamp_millis();
    plan.status = "triggered".into();
    plan.triggered_at = Some(now);
    plan.earliest_entry_at = Some(now + i64::from(plan.cooldown_minutes) * 60_000);
    plan.updated_at = now;
    state.db.save_plan(&plan)?;
    state.db.audit(
        "plan",
        "triggered",
        serde_json::json!({"planId":plan.id,"earliestEntryAt":plan.earliest_entry_at}),
    )?;
    Ok(plan)
}

#[tauri::command]
async fn prepare_order(
    mut intent: OrderIntent,
    state: State<'_, AppState>,
) -> AppResult<OrderReview> {
    if intent.quantity <= Decimal::ZERO {
        return Err(AppError::Validation("订单数量必须大于零".into()));
    }
    if intent.action == "close" {
        intent.reduce_only = true;
    }
    if state
        .runtime()?
        .used_client_order_ids
        .contains(&intent.client_order_id)
    {
        return Err(AppError::Risk("检测到重复客户端订单 ID".into()));
    }
    let plan = intent
        .plan_id
        .as_ref()
        .map(|id| find_plan(&state, id))
        .transpose()?;
    if let Some(plan) = &plan {
        intent.check_mode = plan.check_mode;
    }
    let settings = state.risk_settings()?;
    let live_requested = intent.mode == TradingMode::Live;
    let risk_increasing = intent.action == "open";
    let balance = if live_requested && risk_increasing {
        let credentials = state
            .secrets
            .load(intent.exchange)?
            .ok_or_else(|| AppError::Security("交易所凭据不存在".into()))?;
        state
            .adapter(intent.exchange)?
            .get_balances(&credentials)
            .await?
            .into_iter()
            .find(|item| item.asset.eq_ignore_ascii_case("USDT"))
            .map(|item| item.available)
            .ok_or_else(|| AppError::Risk("未能同步实盘 USDT 可用余额".into()))?
    } else {
        let total = state
            .db
            .get_setting::<Decimal>("paper_balance")?
            .unwrap_or(dec!(10000));
        let used_margin = state
            .db
            .list_positions()?
            .iter()
            .fold(Decimal::ZERO, |sum, position| {
                sum + position.quantity * position.entry_price
                    / Decimal::from(position.leverage.max(1))
            });
        (total - used_margin).max(Decimal::ZERO)
    };
    let daily = state
        .db
        .get_setting::<Decimal>(&daily_pnl_key())?
        .unwrap_or_default();
    let market = state
        .runtime()?
        .markets
        .get(&format!("{}/{}", intent.exchange.as_str(), intent.symbol))
        .cloned()
        .unwrap_or_else(|| demo_market(intent.exchange, &intent.symbol, "15m"));
    let live_market_ready = market.connected && market.source == "exchange";
    let price = intent.price.unwrap_or(market.ticker.last);
    let capability = get_capabilities(intent.exchange, false, state.clone()).await?;
    let runtime = state.runtime()?;
    let emergency = runtime.emergency_stopped;
    drop(runtime);
    let mut review = prepare_review(
        intent,
        plan.as_ref(),
        &settings,
        balance,
        daily,
        emergency,
        state.is_live_unlocked()?,
        &capability,
        price,
    );
    let routing: RoutingSettings = state
        .db
        .get_setting("routing_settings")?
        .unwrap_or_else(RoutingSettings::user_default);
    let asset_class = classify_symbol(&review.intent.symbol);
    let recommended = routing.preferred_exchange(asset_class);
    let fees = routing.effective_fees(review.intent.exchange, asset_class);
    review.asset_class = asset_class;
    review.recommended_exchange = recommended;
    review.estimated_maker_fee = (review.notional * fees.maker_percent / dec!(100)).round_dp(8);
    review.estimated_taker_fee = (review.notional * fees.taker_percent / dec!(100)).round_dp(8);
    review.funding_rate_percent = market.ticker.funding_rate;
    review.estimated_funding_fee =
        (review.notional * market.ticker.funding_rate.abs() / dec!(100)).round_dp(8);
    review.fee_profile_verified = fees.verified_at.is_some();
    review.route_reason = match asset_class {
        AssetClass::Crypto => "加密货币合约默认由 Ourbit 处理".into(),
        AssetClass::Stock => "股票合约默认由 MEXC 处理".into(),
        AssetClass::Oil => "原油合约默认由 MEXC 处理".into(),
        AssetClass::PreciousMetal => "贵金属合约默认由 MEXC 处理".into(),
    };
    if risk_increasing && routing.warn_on_override && review.intent.exchange != recommended {
        review.warnings.push(format!(
            "当前交易所偏离默认路由：该类合约建议使用 {}",
            recommended.as_str().to_ascii_uppercase()
        ));
    }
    if fees.verified_at.is_none() {
        review
            .warnings
            .push("当前手续费档案尚未按 API 账户费率页确认，成本仅为估算".into());
    }
    if review.intent.mode == TradingMode::Live
        && state
            .db
            .get_setting::<RiskSettings>("risk_settings")?
            .is_none()
    {
        review
            .blocked_reasons
            .push("首次实盘风险参数尚未保存".into());
    }
    if live_requested && risk_increasing && !live_market_ready {
        review
            .blocked_reasons
            .push("真实行情未连接或已断流，禁止新增实盘风险".into());
    }
    state
        .runtime()?
        .reviews
        .insert(review.token.clone(), review.clone());
    state.db.audit("order", "review_prepared", serde_json::json!({"clientOrderId":review.intent.client_order_id,"exchange":review.intent.exchange,"symbol":review.intent.symbol,"blocked":review.blocked_reasons}))?;
    Ok(review)
}

#[tauri::command]
async fn submit_order(
    review_token: String,
    warning_accepted: bool,
    state: State<'_, AppState>,
) -> AppResult<OrderResult> {
    let review = state
        .runtime()?
        .reviews
        .remove(&review_token)
        .ok_or_else(|| AppError::Risk("订单复核不存在或已经使用".into()))?;
    if review.expires_at < Utc::now().timestamp_millis() {
        return Err(AppError::Risk("订单复核已过期，请重新检查".into()));
    }
    if !review.blocked_reasons.is_empty() {
        return Err(AppError::Risk(review.blocked_reasons.join("；")));
    }
    if !review.warnings.is_empty() && !warning_accepted {
        return Err(AppError::Risk("必须明确接受纪律警告后才能继续".into()));
    }
    if review.intent.mode == TradingMode::Live {
        let risk_increasing = review.intent.action == "open";
        let (emergency_stopped, market_ready) = {
            let runtime = state.runtime()?;
            let market_ready = runtime
                .markets
                .get(&format!(
                    "{}/{}",
                    review.intent.exchange.as_str(),
                    review.intent.symbol
                ))
                .is_some_and(|market| market.connected && market.source == "exchange");
            (runtime.emergency_stopped, market_ready)
        };
        if risk_increasing {
            if !state.is_live_unlocked()? {
                return Err(AppError::Risk("实盘锁已重新生效，请重新用 PIN 解锁".into()));
            }
            if emergency_stopped {
                return Err(AppError::Risk("立即停止实盘开关已触发".into()));
            }
            if !market_ready {
                return Err(AppError::Risk("最终提交前检测到真实行情断流".into()));
            }
        }
        let capability = get_capabilities(review.intent.exchange, false, state.clone()).await?;
        if !capability.live_trading {
            return Err(AppError::Risk(
                capability
                    .reason
                    .unwrap_or_else(|| "交易所实盘能力不可用".into()),
            ));
        }
    }
    state
        .runtime()?
        .used_client_order_ids
        .insert(review.intent.client_order_id.clone());
    let result = match review.intent.mode {
        TradingMode::Paper => paper_submit(&state, &review)?,
        TradingMode::Live => {
            let credentials = state
                .secrets
                .load(review.intent.exchange)?
                .ok_or_else(|| AppError::Security("交易所凭据不存在".into()))?;
            state
                .adapter(review.intent.exchange)?
                .place_order(&credentials, &review.intent)
                .await?
        }
    };
    if review.intent.mode == TradingMode::Live {
        state.db.save_live_order_map(
            &result.client_order_id,
            review.intent.exchange,
            result.order_id.as_deref(),
            &result.state,
        )?;
        if result.filled_quantity > Decimal::ZERO {
            if let Some(price) = result.average_price {
                state.db.save_fill(&TradeFill {
                    id: uuid::Uuid::new_v4().to_string(),
                    exchange: review.intent.exchange,
                    symbol: review.intent.symbol.clone(),
                    mode: TradingMode::Live,
                    direction: review.intent.direction,
                    action: review.intent.action.clone(),
                    order_id: result.order_id.clone().unwrap_or_default(),
                    client_order_id: result.client_order_id.clone(),
                    quantity: result.filled_quantity,
                    price,
                    fee: Decimal::ZERO,
                    realized_pnl: Decimal::ZERO,
                    created_at: Utc::now().timestamp_millis(),
                })?;
            }
        }
    }
    state.db.audit("order", "submitted", serde_json::json!({"clientOrderId":result.client_order_id,"orderId":result.order_id,"state":result.state,"mode":review.intent.mode}))?;
    Ok(result)
}

#[tauri::command]
async fn cancel_order(
    exchange: ExchangeId,
    order_id: String,
    state: State<'_, AppState>,
) -> AppResult<OrderResult> {
    if let Some(order) = state
        .db
        .list_orders()?
        .into_iter()
        .find(|value| value.order_id == order_id)
    {
        state.db.delete_order(&order_id)?;
        return Ok(OrderResult {
            accepted: true,
            order_id: Some(order_id),
            client_order_id: order.intent.client_order_id,
            state: "cancelled".into(),
            message: "模拟挂单已撤销".into(),
            filled_quantity: order.filled_quantity,
            average_price: None,
        });
    }
    let credentials = state
        .secrets
        .load(exchange)?
        .ok_or_else(|| AppError::Security("交易所凭据不存在".into()))?;
    state
        .adapter(exchange)?
        .cancel_order(&credentials, &order_id)
        .await
}

#[tauri::command]
async fn cancel_all(
    exchange: ExchangeId,
    symbol: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<u32> {
    let orders = state.db.list_orders()?;
    let targets = orders
        .iter()
        .filter(|value| {
            value.intent.exchange == exchange
                && symbol
                    .as_ref()
                    .map(|item| item == &value.intent.symbol)
                    .unwrap_or(true)
        })
        .map(|value| value.order_id.clone())
        .collect::<Vec<_>>();
    for id in &targets {
        state.db.delete_order(id)?;
    }
    if !targets.is_empty() {
        return Ok(targets.len() as u32);
    }
    let credentials = state
        .secrets
        .load(exchange)?
        .ok_or_else(|| AppError::Security("交易所凭据不存在".into()))?;
    state
        .adapter(exchange)?
        .cancel_all(&credentials, symbol.as_deref())
        .await
}

#[tauri::command]
fn list_orders(state: State<'_, AppState>) -> AppResult<Vec<OpenOrder>> {
    state.db.list_orders()
}
#[tauri::command]
fn save_position_review(
    mut review: PositionReview,
    state: State<'_, AppState>,
) -> AppResult<PositionReview> {
    if review.rating > 5 {
        return Err(AppError::Validation("复盘评分必须为 0–5".into()));
    }
    if review.id.is_empty() {
        review.id = uuid::Uuid::new_v4().to_string();
        review.created_at = Utc::now().timestamp_millis();
    }
    state.db.save_review(&review)?;
    state.db.audit("review","saved",serde_json::json!({"positionId":review.position_id,"followedPlan":review.followed_plan,"mistakeTags":review.mistake_tags}))?;
    Ok(review)
}
#[tauri::command]
fn get_analytics(state: State<'_, AppState>) -> AppResult<TradingAnalytics> {
    analytics(&state)
}
#[tauri::command]
fn list_dca_plans(state: State<'_, AppState>) -> AppResult<Vec<DcaPlan>> {
    state.db.list_dca_plans()
}
#[tauri::command]
fn save_dca_plan(mut plan: DcaPlan, state: State<'_, AppState>) -> AppResult<DcaPlan> {
    if plan.mode == TradingMode::Live {
        return Err(AppError::Risk("首版 DCA 仅允许模拟执行".into()));
    }
    if plan.amount_usdt <= Decimal::ZERO || plan.max_purchases_per_day == 0 {
        return Err(AppError::Validation("DCA 金额与每日次数必须大于零".into()));
    }
    let settings = state.risk_settings()?;
    if settings.enforce_global_limits && plan.amount_usdt > settings.max_notional {
        return Err(AppError::Risk(
            "单次 DCA 金额超过全局单笔名义价值上限".into(),
        ));
    }
    if settings.restrict_allowed_symbols && !settings
        .allowed_symbols
        .iter()
        .any(|symbol| symbol == &plan.symbol)
    {
        return Err(AppError::Risk("该 DCA 合约不在全局允许交易清单内".into()));
    }
    if plan.frequency == "panic"
        && plan
            .panic_drop_percent
            .is_none_or(|percent| percent <= Decimal::ZERO || percent > dec!(50))
    {
        return Err(AppError::Validation("恐慌定投跌幅必须在 0–50% 之间".into()));
    }
    if plan.id.is_empty() {
        plan.id = uuid::Uuid::new_v4().to_string();
    }
    state.db.save_dca_plan(&plan)?;
    state.db.audit(
        "dca",
        "saved",
        serde_json::json!({"id":plan.id,"frequency":plan.frequency,"enabled":plan.enabled}),
    )?;
    Ok(plan)
}
#[tauri::command]
fn list_economic_events(from: i64, to: i64) -> Vec<EconomicEvent> {
    economic_events()
        .into_iter()
        .filter(|value| value.occurs_at >= from && value.occurs_at <= to)
        .collect()
}
#[tauri::command]
fn save_chart_template(
    template: ChartTemplate,
    state: State<'_, AppState>,
) -> AppResult<ChartTemplate> {
    if ![1, 2, 4].contains(&template.layout) {
        return Err(AppError::Validation("图表布局只能为 1、2 或 4".into()));
    }
    state.db.save_chart_template(&template)?;
    Ok(template)
}
#[tauri::command]
fn list_chart_templates(state: State<'_, AppState>) -> AppResult<Vec<ChartTemplate>> {
    state.db.list_chart_templates()
}

fn find_plan(state: &State<'_, AppState>, id: &str) -> AppResult<TradingPlan> {
    state
        .db
        .list_plans()?
        .into_iter()
        .find(|value| value.id == id)
        .ok_or_else(|| AppError::Validation("交易计划不存在".into()))
}

fn paper_submit(state: &State<'_, AppState>, review: &OrderReview) -> AppResult<OrderResult> {
    let intent = &review.intent;
    let market_price = state
        .runtime()?
        .markets
        .get(&format!("{}/{}", intent.exchange.as_str(), intent.symbol))
        .map(|market| market.ticker.last)
        .unwrap_or_else(|| {
            demo_market(intent.exchange, &intent.symbol, "15m")
                .ticker
                .last
        });
    let order_id = format!("P-{}", uuid::Uuid::new_v4().simple());
    if intent.order_type == OrderType::Market {
        let is_buy = matches!(
            (intent.action.as_str(), intent.direction),
            ("open", Direction::Long) | ("close", Direction::Short)
        );
        let fill = if is_buy {
            market_price * dec!(1.0005)
        } else {
            market_price * dec!(0.9995)
        };
        let trade = execute_paper_fill(state, intent, fill, &order_id)?;
        Ok(OrderResult {
            accepted: true,
            order_id: Some(order_id),
            client_order_id: intent.client_order_id.clone(),
            state: "filled".into(),
            message: format!(
                "模拟市价单已成交（5bp 滑点，手续费 {} USDT，已实现盈亏 {} USDT）",
                trade.fee.round_dp(4),
                trade.realized_pnl.round_dp(4)
            ),
            filled_quantity: trade.quantity,
            average_price: Some(fill),
        })
    } else {
        let order = OpenOrder {
            intent: intent.clone(),
            order_id: order_id.clone(),
            status: "submitted".into(),
            filled_quantity: Decimal::ZERO,
            created_at: Utc::now().timestamp_millis(),
        };
        state.db.save_order(&order)?;
        Ok(OrderResult {
            accepted: true,
            order_id: Some(order_id),
            client_order_id: intent.client_order_id.clone(),
            state: "submitted".into(),
            message: "模拟限价单已进入撮合队列".into(),
            filled_quantity: Decimal::ZERO,
            average_price: None,
        })
    }
}

fn execute_paper_fill(
    state: &AppState,
    intent: &OrderIntent,
    fill_price: Decimal,
    order_id: &str,
) -> AppResult<TradeFill> {
    let routing: RoutingSettings = state
        .db
        .get_setting("routing_settings")?
        .unwrap_or_else(RoutingSettings::user_default);
    let profile = routing.effective_fees(intent.exchange, classify_symbol(&intent.symbol));
    let maker = matches!(intent.order_type, OrderType::PostOnly | OrderType::Limit);
    let fee_percent = if maker {
        profile.maker_percent
    } else {
        profile.taker_percent
    };
    let fee = (fill_price * intent.quantity * fee_percent / dec!(100)).round_dp(8);
    let mut realized = Decimal::ZERO;
    let mut positions = state.db.list_positions()?;
    if intent.action == "open" {
        if let Some(position) = positions.iter_mut().find(|position| {
            position.exchange == intent.exchange
                && position.symbol == intent.symbol
                && position.direction == intent.direction
                && position.margin_mode == intent.margin_mode
        }) {
            let total_quantity = position.quantity + intent.quantity;
            position.entry_price = (position.entry_price * position.quantity
                + fill_price * intent.quantity)
                / total_quantity;
            position.quantity = total_quantity;
            position.mark_price = fill_price;
            position.leverage = intent.leverage;
            position.stop_loss = intent.stop_loss;
            position.take_profit = intent.take_profit;
            position.liquidation_price = Some(estimated_liquidation(
                position.direction,
                position.entry_price,
                position.leverage,
            ));
            state.db.save_position(position)?;
        } else {
            state.db.save_position(&Position {
                id: uuid::Uuid::new_v4().to_string(),
                exchange: intent.exchange,
                symbol: intent.symbol.clone(),
                direction: intent.direction,
                quantity: intent.quantity,
                entry_price: fill_price,
                mark_price: fill_price,
                liquidation_price: Some(estimated_liquidation(
                    intent.direction,
                    fill_price,
                    intent.leverage,
                )),
                leverage: intent.leverage,
                margin_mode: intent.margin_mode,
                unrealized_pnl: Decimal::ZERO,
                realized_pnl: Decimal::ZERO,
                stop_loss: intent.stop_loss,
                take_profit: intent.take_profit,
            })?;
        }
    } else {
        let available = positions
            .iter()
            .filter(|position| {
                position.exchange == intent.exchange
                    && position.symbol == intent.symbol
                    && position.direction == intent.direction
            })
            .fold(Decimal::ZERO, |sum, position| sum + position.quantity);
        if available < intent.quantity {
            return Err(AppError::Risk(format!(
                "可平仓数量不足：可用 {}，请求 {}",
                available, intent.quantity
            )));
        }
        let mut remaining = intent.quantity;
        for position in positions.iter_mut().filter(|position| {
            position.exchange == intent.exchange
                && position.symbol == intent.symbol
                && position.direction == intent.direction
        }) {
            if remaining.is_zero() {
                break;
            }
            let closed = remaining.min(position.quantity);
            let pnl = match position.direction {
                Direction::Long => (fill_price - position.entry_price) * closed,
                Direction::Short => (position.entry_price - fill_price) * closed,
            };
            realized += pnl;
            position.realized_pnl += pnl;
            position.quantity -= closed;
            remaining -= closed;
            if position.quantity.is_zero() {
                state.db.delete_position(&position.id)?;
            } else {
                position.mark_price = fill_price;
                position.unrealized_pnl = match position.direction {
                    Direction::Long => (fill_price - position.entry_price) * position.quantity,
                    Direction::Short => (position.entry_price - fill_price) * position.quantity,
                };
                state.db.save_position(position)?;
            }
        }
    }

    let balance = state
        .db
        .get_setting::<Decimal>("paper_balance")?
        .unwrap_or(dec!(10000))
        + realized
        - fee;
    state.db.set_setting("paper_balance", &balance)?;
    let daily_key = daily_pnl_key();
    let daily = state
        .db
        .get_setting::<Decimal>(&daily_key)?
        .unwrap_or_default()
        + realized
        - fee;
    state.db.set_setting(&daily_key, &daily)?;
    if state.risk_settings()?.enforce_global_limits && daily <= -state.risk_settings()?.daily_loss_limit {
        state.lock_live("单日亏损上限已触发")?;
    }

    let trade = TradeFill {
        id: uuid::Uuid::new_v4().to_string(),
        exchange: intent.exchange,
        symbol: intent.symbol.clone(),
        mode: TradingMode::Paper,
        direction: intent.direction,
        action: intent.action.clone(),
        order_id: order_id.into(),
        client_order_id: intent.client_order_id.clone(),
        quantity: intent.quantity,
        price: fill_price,
        fee,
        realized_pnl: realized,
        created_at: Utc::now().timestamp_millis(),
    };
    state.db.save_fill(&trade)?;
    Ok(trade)
}

pub(crate) fn update_paper_market(state: &AppState, market: &MarketSnapshot) -> AppResult<()> {
    let price = market.ticker.last;
    let positions = state.db.list_positions()?;
    for mut position in positions.into_iter().filter(|position| {
        position.exchange == market.instrument.exchange
            && position.symbol == market.instrument.symbol
    }) {
        let stop_triggered = position
            .stop_loss
            .is_some_and(|stop| match position.direction {
                Direction::Long => price <= stop,
                Direction::Short => price >= stop,
            });
        let target_triggered =
            position
                .take_profit
                .is_some_and(|target| match position.direction {
                    Direction::Long => price >= target,
                    Direction::Short => price <= target,
                });
        if stop_triggered || target_triggered {
            let fill = if position.direction == Direction::Long {
                price * dec!(0.9995)
            } else {
                price * dec!(1.0005)
            };
            let intent = OrderIntent {
                client_order_id: format!("auto{}", uuid::Uuid::new_v4().simple()),
                exchange: position.exchange,
                symbol: position.symbol.clone(),
                mode: TradingMode::Paper,
                direction: position.direction,
                action: "close".into(),
                order_type: OrderType::Market,
                quantity: position.quantity,
                price: None,
                trigger_price: None,
                trailing_percent: None,
                leverage: position.leverage,
                margin_mode: position.margin_mode,
                position_mode: PositionMode::Hedge,
                reduce_only: true,
                take_profit: None,
                stop_loss: None,
                plan_id: None,
                check_mode: CheckMode::Off,
            };
            let order_id = format!("AUTO-{}", uuid::Uuid::new_v4().simple());
            let trade = execute_paper_fill(state, &intent, fill, &order_id)?;
            state.db.record_risk_event(
                if stop_triggered {
                    "paper_stop_loss"
                } else {
                    "paper_take_profit"
                },
                &format!(
                    "{} {} 自动{}，已实现盈亏 {} USDT",
                    position.symbol,
                    position.quantity,
                    if stop_triggered { "止损" } else { "止盈" },
                    trade.realized_pnl.round_dp(4)
                ),
            )?;
        } else {
            position.mark_price = price;
            position.unrealized_pnl = match position.direction {
                Direction::Long => (price - position.entry_price) * position.quantity,
                Direction::Short => (position.entry_price - price) * position.quantity,
            };
            state.db.save_position(&position)?;
        }
    }

    for order in state.db.list_orders()?.into_iter().filter(|order| {
        order.intent.mode == TradingMode::Paper
            && order.intent.exchange == market.instrument.exchange
            && order.intent.symbol == market.instrument.symbol
    }) {
        let Some(limit_price) = order.intent.price else {
            continue;
        };
        let is_buy = matches!(
            (order.intent.action.as_str(), order.intent.direction),
            ("open", Direction::Long) | ("close", Direction::Short)
        );
        if (is_buy && price <= limit_price) || (!is_buy && price >= limit_price) {
            execute_paper_fill(state, &order.intent, limit_price, &order.order_id)?;
            state.db.delete_order(&order.order_id)?;
        }
    }
    Ok(())
}

fn estimated_liquidation(direction: Direction, price: Decimal, leverage: u32) -> Decimal {
    match direction {
        Direction::Long => price * (Decimal::ONE - dec!(0.9) / Decimal::from(leverage.max(1))),
        Direction::Short => price * (Decimal::ONE + dec!(0.9) / Decimal::from(leverage.max(1))),
    }
}

fn daily_pnl_key() -> String {
    format!("daily_realized_pnl:{}", Utc::now().date_naive())
}

#[cfg(test)]
mod paper_tests {
    use super::*;

    fn intent(quantity: Decimal) -> OrderIntent {
        serde_json::from_value(serde_json::json!({
            "clientOrderId": uuid::Uuid::new_v4().simple().to_string(),
            "exchange":"ourbit","symbol":"BTC_USDT","mode":"paper","direction":"long","action":"open",
            "orderType":"market","quantity":quantity.to_string(),"leverage":5,"marginMode":"isolated",
            "positionMode":"hedge","reduceOnly":false,"stopLoss":"95","takeProfit":"140","checkMode":"off"
        })).unwrap()
    }

    #[test]
    fn paper_fill_averages_additions_and_partially_reduces() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::initialize(temp.path()).unwrap();
        execute_paper_fill(&state, &intent(dec!(2)), dec!(100), "open-1").unwrap();
        execute_paper_fill(&state, &intent(dec!(1)), dec!(110), "open-2").unwrap();
        let position = state.db.list_positions().unwrap().pop().unwrap();
        assert_eq!(position.quantity, dec!(3));
        assert_eq!(position.entry_price.round_dp(4), dec!(103.3333));

        let mut close = intent(dec!(1));
        close.action = "close".into();
        close.reduce_only = true;
        close.stop_loss = None;
        close.take_profit = None;
        let fill = execute_paper_fill(&state, &close, dec!(120), "close-1").unwrap();
        assert_eq!(fill.realized_pnl.round_dp(4), dec!(16.6667));
        assert_eq!(state.db.list_positions().unwrap()[0].quantity, dec!(2));
        assert_eq!(state.db.list_fills().unwrap().len(), 3);
    }

    #[test]
    fn paper_stop_loss_closes_position_and_records_risk_event() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::initialize(temp.path()).unwrap();
        execute_paper_fill(&state, &intent(dec!(1)), dec!(100), "open-stop").unwrap();
        let mut market = demo_market(ExchangeId::Ourbit, "BTC_USDT", "15m");
        market.ticker.last = dec!(94);
        update_paper_market(&state, &market).unwrap();
        assert!(state.db.list_positions().unwrap().is_empty());
        assert!(state
            .db
            .list_risk_events()
            .unwrap()
            .iter()
            .any(|event| event.event_type == "paper_stop_loss"));
    }
}

fn analytics(state: &State<'_, AppState>) -> AppResult<TradingAnalytics> {
    let reviews = state.db.list_reviews()?;
    let fills = state.db.list_fills()?;
    let closed: Vec<&TradeFill> = fills.iter().filter(|fill| fill.action == "close").collect();
    let total = closed.len() as u32;
    let followed = reviews.iter().filter(|value| value.followed_plan).count() as u32;
    let wins: Vec<Decimal> = closed
        .iter()
        .filter_map(|fill| (fill.realized_pnl > Decimal::ZERO).then_some(fill.realized_pnl))
        .collect();
    let losses: Vec<Decimal> = closed
        .iter()
        .filter_map(|fill| (fill.realized_pnl < Decimal::ZERO).then_some(fill.realized_pnl))
        .collect();
    let gross_profit: Decimal = wins.iter().copied().sum();
    let gross_loss: Decimal = losses.iter().map(|value| value.abs()).sum();
    let net_pnl: Decimal = fills.iter().map(|fill| fill.realized_pnl - fill.fee).sum();
    let average_win = if wins.is_empty() {
        Decimal::ZERO
    } else {
        gross_profit / Decimal::from(wins.len())
    };
    let average_loss = if losses.is_empty() {
        Decimal::ZERO
    } else {
        -gross_loss / Decimal::from(losses.len())
    };

    let fill_by_id: HashMap<&str, &TradeFill> =
        fills.iter().map(|fill| (fill.id.as_str(), fill)).collect();
    let mut tags: HashMap<String, (u32, Decimal)> = HashMap::new();
    for review in &reviews {
        let impact = fill_by_id
            .get(review.position_id.as_str())
            .map(|fill| fill.realized_pnl - fill.fee)
            .unwrap_or(Decimal::ZERO);
        for tag in &review.mistake_tags {
            let entry = tags.entry(tag.clone()).or_default();
            entry.0 += 1;
            entry.1 += impact;
        }
    }
    let mut top: Vec<MistakeStat> = tags
        .into_iter()
        .map(|(tag, (count, pnl))| MistakeStat { tag, count, pnl })
        .collect();
    top.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.tag.cmp(&right.tag))
    });

    let today = Utc::now().date_naive();
    let mut daily_pnl: Vec<DailyPnl> = (0..7)
        .rev()
        .map(|days_ago| DailyPnl {
            date: (today - Duration::days(days_ago))
                .format("%Y-%m-%d")
                .to_string(),
            pnl: Decimal::ZERO,
        })
        .collect();
    for fill in &fills {
        let Some(timestamp) = Utc.timestamp_millis_opt(fill.created_at).single() else {
            continue;
        };
        let date = timestamp.format("%Y-%m-%d").to_string();
        if let Some(point) = daily_pnl.iter_mut().find(|point| point.date == date) {
            point.pnl += fill.realized_pnl - fill.fee;
        }
    }

    let session_labels = ["亚洲早盘 08–12", "欧洲时段 12–20", "美盘时段 20–08"];
    let mut session_values = [(0u32, Decimal::ZERO, 0u32); 3];
    for fill in &closed {
        let Some(timestamp) = Utc.timestamp_millis_opt(fill.created_at).single() else {
            continue;
        };
        let local_hour = (timestamp.hour() + 8) % 24;
        let index = if (8..12).contains(&local_hour) {
            0
        } else if (12..20).contains(&local_hour) {
            1
        } else {
            2
        };
        session_values[index].0 += 1;
        session_values[index].1 += fill.realized_pnl - fill.fee;
        if fill.realized_pnl > Decimal::ZERO {
            session_values[index].2 += 1;
        }
    }
    let sessions = session_labels
        .into_iter()
        .enumerate()
        .map(|(index, label)| {
            let (trades, pnl, wins) = session_values[index];
            SessionStat {
                label: label.into(),
                trades,
                pnl,
                win_rate: if trades == 0 {
                    0.0
                } else {
                    wins as f64 * 100.0 / trades as f64
                },
            }
        })
        .collect();

    Ok(TradingAnalytics {
        total_trades: total,
        reviewed_trades: reviews.len() as u32,
        planned_trades: followed,
        win_rate: if total == 0 {
            0.0
        } else {
            wins.len() as f64 * 100.0 / total as f64
        },
        profit_factor: if gross_loss > Decimal::ZERO {
            (gross_profit / gross_loss).to_f64().unwrap_or(0.0)
        } else if gross_profit > Decimal::ZERO {
            999.99
        } else {
            0.0
        },
        net_pnl,
        average_win,
        average_loss,
        discipline_score: if reviews.is_empty() {
            0
        } else {
            followed * 100 / reviews.len() as u32
        },
        top_mistakes: top,
        daily_pnl,
        sessions,
    })
}
fn economic_events() -> Vec<EconomicEvent> {
    let at = |month, day, hour, minute| {
        Utc.with_ymd_and_hms(2026, month, day, hour, minute, 0)
            .single()
            .expect("valid risk calendar timestamp")
            .timestamp_millis()
    };
    let event = |id: &str,
                 title: &str,
                 country: &str,
                 impact: &str,
                 occurs_at: i64,
                 previous: Option<&str>,
                 forecast: Option<&str>,
                 source: &str,
                 category: &str,
                 assets: &[&str]| EconomicEvent {
        id: id.into(),
        title: title.into(),
        country: country.into(),
        impact: impact.into(),
        occurs_at,
        previous: previous.map(str::to_owned),
        forecast: forecast.map(str::to_owned),
        actual: None,
        source: source.into(),
        category: category.into(),
        affected_assets: assets.iter().map(|asset| (*asset).into()).collect(),
    };
    vec![
        event(
            "us-gdp-2q-second",
            "美国二季度实际 GDP（二次估算）",
            "US",
            "high",
            at(8, 26, 12, 30),
            Some("1.5%"),
            Some("待更新"),
            "美国商务部 BEA",
            "macro",
            &["crypto", "oil", "metals", "stocks"],
        ),
        event(
            "us-pce-jul",
            "美国 7 月核心 PCE 物价指数",
            "US",
            "high",
            at(8, 26, 12, 30),
            Some("待更新"),
            Some("待更新"),
            "美国商务部 BEA",
            "macro",
            &["crypto", "oil", "metals", "stocks"],
        ),
        event(
            "us-income-outlays",
            "美国 7 月个人收入与支出",
            "US",
            "high",
            at(8, 26, 12, 30),
            Some("待更新"),
            Some("待更新"),
            "美国商务部 BEA",
            "macro",
            &["crypto", "oil", "metals", "stocks"],
        ),
        event(
            "us-corporate-profits",
            "美国二季度企业利润初值",
            "US",
            "medium",
            at(8, 26, 12, 30),
            Some("—"),
            Some("—"),
            "美国商务部 BEA",
            "macro",
            &["stocks", "metals"],
        ),
        event(
            "bls-leave",
            "美国劳工休假使用情况",
            "US",
            "low",
            at(8, 26, 14, 0),
            Some("—"),
            Some("—"),
            "美国劳工统计局 BLS",
            "employment",
            &["stocks"],
        ),
        event(
            "eia-crude",
            "美国 EIA 原油库存",
            "US",
            "high",
            at(8, 26, 14, 30),
            Some("待更新"),
            Some("待更新"),
            "美国能源信息署 EIA",
            "energy",
            &["oil", "stocks"],
        ),
        event(
            "eia-gasoline",
            "美国 EIA 汽油库存",
            "US",
            "medium",
            at(8, 26, 14, 30),
            Some("待更新"),
            Some("待更新"),
            "美国能源信息署 EIA",
            "energy",
            &["oil"],
        ),
        event(
            "eia-cushing",
            "美国 EIA 库欣原油库存",
            "US",
            "medium",
            at(8, 26, 14, 30),
            Some("待更新"),
            Some("待更新"),
            "美国能源信息署 EIA",
            "energy",
            &["oil"],
        ),
        event(
            "us-jobless",
            "美国初请失业金人数",
            "US",
            "high",
            at(8, 27, 12, 30),
            Some("待更新"),
            Some("待更新"),
            "美国劳工部 DOL",
            "employment",
            &["crypto", "metals", "stocks"],
        ),
        event(
            "bls-employment-projection",
            "美国就业预测与职业展望",
            "US",
            "low",
            at(8, 27, 14, 0),
            Some("—"),
            Some("—"),
            "美国劳工统计局 BLS",
            "employment",
            &["stocks"],
        ),
        event(
            "fed-balance-sheet",
            "美联储资产负债表 H.4.1",
            "US",
            "medium",
            at(8, 28, 0, 30),
            Some("待更新"),
            Some("—"),
            "美联储",
            "central_bank",
            &["crypto", "metals", "stocks"],
        ),
        event(
            "crypto-monthly-expiry",
            "BTC / ETH 月度期权集中到期",
            "GLOBAL",
            "high",
            at(8, 28, 8, 0),
            Some("—"),
            Some("—"),
            "衍生品规则日历",
            "crypto",
            &["crypto"],
        ),
        event(
            "fed-jackson-hole",
            "美联储主席杰克逊霍尔主题讲话",
            "US",
            "high",
            at(8, 28, 14, 0),
            Some("—"),
            Some("—"),
            "美联储",
            "central_bank",
            &["crypto", "oil", "metals", "stocks"],
        ),
        event(
            "bls-ces-benchmark",
            "美国非农就业年度初步基准修订",
            "US",
            "medium",
            at(8, 28, 14, 0),
            Some("—"),
            Some("—"),
            "美国劳工统计局 BLS",
            "employment",
            &["metals", "stocks"],
        ),
        event(
            "baker-hughes",
            "美国 Baker Hughes 石油钻井总数",
            "US",
            "medium",
            at(8, 28, 17, 0),
            Some("待更新"),
            Some("—"),
            "Baker Hughes",
            "energy",
            &["oil"],
        ),
        event(
            "cftc-cot",
            "CFTC 原油与贵金属持仓周报",
            "US",
            "medium",
            at(8, 28, 19, 30),
            Some("—"),
            Some("—"),
            "美国 CFTC",
            "market",
            &["oil", "metals"],
        ),
        event(
            "crypto-weekend",
            "加密市场周末流动性收缩窗口",
            "GLOBAL",
            "medium",
            at(8, 29, 0, 0),
            Some("—"),
            Some("—"),
            "本地风险模板·交易前核实",
            "crypto",
            &["crypto"],
        ),
        event(
            "china-pmi",
            "中国 8 月官方制造业 PMI",
            "CN",
            "high",
            at(8, 31, 1, 30),
            Some("待更新"),
            Some("待更新"),
            "本地日程模板·待实时源确认",
            "macro",
            &["crypto", "oil", "metals", "stocks"],
        ),
        event(
            "eurozone-cpi",
            "欧元区 8 月 CPI 初值",
            "EU",
            "high",
            at(8, 31, 9, 0),
            Some("待更新"),
            Some("待更新"),
            "本地日程模板·待实时源确认",
            "macro",
            &["crypto", "oil", "metals", "stocks"],
        ),
        event(
            "month-end-rebalance",
            "全球指数与基金月末再平衡窗口",
            "GLOBAL",
            "high",
            at(8, 31, 15, 30),
            Some("—"),
            Some("—"),
            "市场日历",
            "market",
            &["crypto", "oil", "metals", "stocks"],
        ),
        event(
            "fed-h10",
            "美联储 H.10 外汇汇率周报",
            "US",
            "low",
            at(9, 1, 0, 15),
            Some("—"),
            Some("—"),
            "美联储",
            "central_bank",
            &["crypto", "metals", "stocks"],
        ),
    ]
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = AppState::initialize(&data_dir)
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            get_capabilities,
            get_market,
            get_klines,
            subscribe_market,
            unsubscribe_market,
            get_instruments,
            sync_live_account,
            set_exchange_leverage,
            set_exchange_margin_mode,
            save_credentials,
            remove_credentials,
            save_risk_settings,
            save_routing_settings,
            set_pin,
            unlock_live,
            lock_live,
            emergency_stop,
            clear_emergency_stop,
            list_plans,
            save_plan,
            arm_plan,
            trigger_plan,
            prepare_order,
            submit_order,
            cancel_order,
            cancel_all,
            list_orders,
            save_position_review,
            get_analytics,
            list_dca_plans,
            save_dca_plan,
            list_economic_events,
            save_chart_template,
            list_chart_templates
        ])
        .run(tauri::generate_context!())
        .expect("error while running Discipline Trader");
}
