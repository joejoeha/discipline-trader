use crate::{
    error::{AppError, AppResult},
    types::*,
};
use rust_decimal::Decimal;
use std::collections::HashMap;

const QUESTIONS: &[(&str, &str)] = &[
    ("emotion", "当前没有情绪化交易或冲动下单？"),
    ("revenge", "这不是为了急于回本的报复性交易？"),
    ("frequency", "近期交易频率仍在计划范围内？"),
    ("losses", "连续亏损尚未触发暂停规则？"),
    ("size", "仓位与止损后的最大亏损可接受？"),
    ("analysis", "已完成多周期行情分析并写出依据？"),
    ("trend", "交易方向与所选周期趋势不冲突？"),
    ("liquidity", "盘口流动性足够，滑点风险可接受？"),
    ("intent", "已考虑主力诱多/诱空与流动性位置？"),
    ("stop", "止损价格明确且不会随意扩大？"),
    ("accept", "即使止损，仍会认可这次决策过程？"),
];

pub fn validate_risk_settings(settings: &RiskSettings) -> AppResult<()> {
    if settings.enforce_global_limits && (settings.max_leverage == 0 || settings.max_leverage > 200) {
        return Err(AppError::Validation("最高杠杆必须在 1–200 之间".into()));
    }
    if settings.enforce_global_limits && (settings.max_notional <= Decimal::ZERO
        || settings.max_risk_percent <= Decimal::ZERO
        || settings.max_risk_percent > Decimal::new(100, 0)
        || settings.daily_loss_limit <= Decimal::ZERO)
    {
        return Err(AppError::Validation(
            "名义价值、风险比例与日亏上限必须为有限正数".into(),
        ));
    }
    if settings.restrict_allowed_symbols && settings.allowed_symbols.is_empty() {
        return Err(AppError::Validation("至少选择一个允许交易的合约".into()));
    }
    if settings.market_data_timeout_seconds == 0 || settings.max_clock_skew_seconds == 0 {
        return Err(AppError::Validation(
            "行情超时与时间偏差阈值不能为零".into(),
        ));
    }
    Ok(())
}

pub fn evaluate_checklist(mode: CheckMode, answers: &[ChecklistAnswer]) -> ChecklistResult {
    evaluate_checklist_with_questions(mode, answers, &[])
}

pub fn evaluate_checklist_with_questions(
    mode: CheckMode,
    answers: &[ChecklistAnswer],
    custom_questions: &[ChecklistQuestion],
) -> ChecklistResult {
    if mode == CheckMode::Off {
        return ChecklistResult {
            passed: true,
            mode,
            failed: vec![],
            unanswered: vec![],
        };
    }
    let values: HashMap<&str, Option<bool>> = answers
        .iter()
        .map(|answer| (answer.question_id.as_str(), answer.value))
        .collect();
    let mut questions = QUESTIONS
        .iter()
        .map(|(id, prompt)| ((*id).to_owned(), (*prompt).to_owned(), true))
        .collect::<Vec<_>>();
    questions.extend(custom_questions.iter().map(|question| {
        (
            question.id.clone(),
            question.prompt.clone(),
            question.expected,
        )
    }));
    let failed = questions
        .iter()
        .filter(|(id, _, expected)| {
            values
                .get(id.as_str())
                .copied()
                .flatten()
                .is_some_and(|value| value != *expected)
        })
        .map(|(_, prompt, _)| prompt.clone())
        .collect::<Vec<_>>();
    let unanswered = questions
        .iter()
        .filter(|(id, _, _)| values.get(id.as_str()).copied().flatten().is_none())
        .map(|(_, prompt, _)| prompt.clone())
        .collect::<Vec<_>>();
    let clear = failed.is_empty() && unanswered.is_empty();
    ChecklistResult {
        passed: mode == CheckMode::Warn || clear,
        mode,
        failed,
        unanswered,
    }
}

pub fn prepare_review(
    intent: OrderIntent,
    plan: Option<&TradingPlan>,
    settings: &RiskSettings,
    balance: Decimal,
    daily_realized: Decimal,
    emergency_stopped: bool,
    live_unlocked: bool,
    capability: &ExchangeCapabilities,
    price: Decimal,
) -> OrderReview {
    let mut blocked_reasons = Vec::new();
    let mut warnings = Vec::new();
    let notional = price * intent.quantity;
    let margin_required = if intent.leverage == 0 {
        Decimal::ZERO
    } else {
        notional / Decimal::from(intent.leverage)
    };
    let checklist = plan.map_or_else(
        || evaluate_checklist(intent.check_mode, &[]),
        |value| {
            evaluate_checklist_with_questions(
                intent.check_mode,
                &value.answers,
                &value.custom_questions,
            )
        },
    );
    let is_open = intent.action == "open";
    if is_open {
        match plan {
            None => blocked_reasons.push("开仓必须关联已创建的交易计划".into()),
            Some(value) => {
                if value.exchange != intent.exchange
                    || value.symbol != intent.symbol
                    || value.direction != intent.direction
                {
                    blocked_reasons.push("订单的交易所、合约或方向与交易计划不一致".into());
                }
                if value.status != "triggered" {
                    blocked_reasons.push("交易计划尚未触发".into());
                }
                if value
                    .expires_at
                    .is_some_and(|time| chrono::Utc::now().timestamp_millis() >= time)
                {
                    blocked_reasons.push("交易计划已过期".into());
                }
                if value
                    .earliest_entry_at
                    .map(|time| chrono::Utc::now().timestamp_millis() < time)
                    .unwrap_or(true)
                {
                    blocked_reasons.push("交易计划冷静期尚未结束".into());
                }
                if !value.allowed_order_types.contains(&intent.order_type) {
                    blocked_reasons.push("该订单类型不在交易计划允许范围内".into());
                }
                if intent.stop_loss != Some(value.stop_loss) {
                    blocked_reasons.push("订单止损必须与已确认的交易计划一致".into());
                }
                if intent
                    .take_profit
                    .is_some_and(|target| !value.targets.contains(&target))
                {
                    blocked_reasons.push("订单止盈不在交易计划目标位中".into());
                }
            }
        }
        if intent.stop_loss.is_none() {
            blocked_reasons.push("开仓必须设置止损".into());
        }
        if intent.check_mode == CheckMode::Block && !checklist.passed {
            blocked_reasons.push("纪律问题未全部通过".into());
        }
    }
    if intent.leverage == 0 {
        blocked_reasons.push("杠杆必须大于 0x".into());
    } else if settings.enforce_global_limits && intent.leverage > settings.max_leverage {
        blocked_reasons.push(format!("杠杆超过全局上限 {}x", settings.max_leverage));
    }
    if settings.enforce_global_limits && notional > settings.max_notional {
        blocked_reasons.push(format!(
            "名义价值超过全局上限 {} USDT",
            settings.max_notional
        ));
    }
    if is_open && margin_required > balance {
        blocked_reasons.push("预估保证金超过账户可用余额".into());
    }
    if settings.restrict_allowed_symbols && !settings.allowed_symbols.contains(&intent.symbol) {
        blocked_reasons.push("该合约不在全局允许列表".into());
    }
    let stop_loss_amount = intent
        .stop_loss
        .map(|stop| (price - stop).abs() * intent.quantity);
    if let Some(amount) = stop_loss_amount {
        if settings.enforce_global_limits && amount > balance * settings.max_risk_percent / Decimal::new(100, 0) {
            blocked_reasons.push("止损最大亏损超过单笔风险比例".into());
        }
        if price > Decimal::ZERO
            && (price - intent.stop_loss.unwrap()).abs() / price > Decimal::new(5, 2)
        {
            blocked_reasons.push("止损幅度超过内置 5% 硬上限".into());
        }
    }
    if is_open && settings.enforce_global_limits && daily_realized <= -settings.daily_loss_limit {
        blocked_reasons.push("今日亏损额度已用尽；只允许撤单、减仓或平仓".into());
    }
    if intent.check_mode == CheckMode::Warn
        && (!checklist.failed.is_empty() || !checklist.unanswered.is_empty())
    {
        warnings.push("纪律清单存在未通过或未回答项，需要额外确认".into());
    }
    if intent.mode == TradingMode::Live {
        if is_open {
            if emergency_stopped {
                blocked_reasons.push("全局立即停止实盘已触发".into());
            }
            if !live_unlocked {
                blocked_reasons.push("实盘尚未通过本机 PIN 解锁".into());
            }
        }
        if !capability.live_trading {
            blocked_reasons.push(
                capability
                    .reason
                    .clone()
                    .unwrap_or_else(|| "交易所实盘能力不可用".into()),
            );
        }
    }
    let estimated_liquidation_price = match intent.direction {
        Direction::Long => {
            price * (Decimal::ONE - Decimal::new(90, 2) / Decimal::from(intent.leverage.max(1)))
        }
        Direction::Short => {
            price * (Decimal::ONE + Decimal::new(90, 2) / Decimal::from(intent.leverage.max(1)))
        }
    };
    let asset_class = crate::exchange::classify_symbol(&intent.symbol);
    let intent_exchange = intent.exchange;
    OrderReview {
        token: uuid::Uuid::new_v4().to_string(),
        expires_at: chrono::Utc::now().timestamp_millis() + 60_000,
        intent,
        notional,
        margin_required,
        max_stop_loss: stop_loss_amount,
        estimated_liquidation_price,
        asset_class,
        recommended_exchange: intent_exchange,
        route_reason: "尚未应用账户路由设置".into(),
        estimated_maker_fee: Decimal::ZERO,
        estimated_taker_fee: Decimal::ZERO,
        funding_rate_percent: Decimal::ZERO,
        estimated_funding_fee: Decimal::ZERO,
        fee_profile_verified: false,
        checklist,
        warnings,
        blocked_reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;
    fn intent() -> OrderIntent {
        serde_json::from_value(serde_json::json!({"clientOrderId":"safe","exchange":"ourbit","symbol":"BTC_USDT","mode":"paper","direction":"long","action":"open","orderType":"limit","quantity":"0.01","price":"100000","leverage":5,"marginMode":"isolated","positionMode":"hedge","reduceOnly":false,"stopLoss":"99000","planId":"p","checkMode":"off"})).unwrap()
    }
    fn plan() -> TradingPlan {
        serde_json::from_value(serde_json::json!({"id":"p","name":"p","exchange":"ourbit","symbol":"BTC_USDT","direction":"long","triggerCondition":"x","plannedPrice":"100000","stopLoss":"99000","targets":["102000"],"allowedOrderTypes":["limit"],"checkMode":"off","answers":[],"status":"triggered","triggeredAt":1,"earliestEntryAt":1,"cooldownMinutes":1,"createdAt":1,"updatedAt":1})).unwrap()
    }
    fn cap() -> ExchangeCapabilities {
        ExchangeCapabilities {
            exchange: ExchangeId::Ourbit,
            market_data: true,
            account_read: true,
            live_trading: true,
            order_types: HashMap::new(),
            supports_reduce_only: true,
            supports_tp_sl: true,
            supports_trailing_stop: false,
            supports_hedge_mode: true,
            supports_cross_margin: true,
            reason: None,
            checked_at: 1,
        }
    }
    #[test]
    fn off_mode_does_not_bypass_global_notional() {
        let mut settings = RiskSettings::safe_default();
        settings.max_notional = dec!(100);
        let review = prepare_review(
            intent(),
            Some(&plan()),
            &settings,
            dec!(10000),
            Decimal::ZERO,
            false,
            true,
            &cap(),
            dec!(100000),
        );
        assert!(review
            .blocked_reasons
            .iter()
            .any(|v| v.contains("名义价值")));
    }

    #[test]
    fn unrestricted_modes_do_not_apply_saved_global_limits_or_symbol_list() {
        let mut settings = RiskSettings::safe_default();
        settings.enforce_global_limits = false;
        settings.restrict_allowed_symbols = false;
        settings.max_notional = dec!(100);
        settings.allowed_symbols = vec!["ETH_USDT".into()];
        let review = prepare_review(
            intent(),
            Some(&plan()),
            &settings,
            dec!(10000),
            dec!(-500),
            false,
            true,
            &cap(),
            dec!(100000),
        );
        assert!(!review
            .blocked_reasons
            .iter()
            .any(|reason| reason.contains("名义价值") || reason.contains("允许列表") || reason.contains("今日亏损")));
    }

    #[test]
    fn custom_plan_question_is_enforced() {
        let question = ChecklistQuestion {
            id: "custom-patience".into(),
            prompt: "是否等待确认？".into(),
            expected: true,
            critical: true,
        };
        let result = evaluate_checklist_with_questions(CheckMode::Block, &[], &[question]);
        assert!(!result.passed);
        assert!(result
            .unanswered
            .iter()
            .any(|value| value == "是否等待确认？"));
    }
    #[test]
    fn close_is_allowed_after_daily_loss_limit() {
        let mut value = intent();
        value.action = "close".into();
        value.reduce_only = true;
        value.plan_id = None;
        value.mode = TradingMode::Live;
        let review = prepare_review(
            value,
            None,
            &RiskSettings::safe_default(),
            dec!(10000),
            dec!(-500),
            true,
            false,
            &cap(),
            dec!(100000),
        );
        assert!(!review
            .blocked_reasons
            .iter()
            .any(|v| v.contains("今日亏损")));
        assert!(!review
            .blocked_reasons
            .iter()
            .any(|v| v.contains("立即停止") || v.contains("PIN")));
    }

    #[test]
    fn plan_identity_and_stop_loss_cannot_be_substituted() {
        let mut value = intent();
        value.direction = Direction::Short;
        value.stop_loss = Some(dec!(98000));
        let review = prepare_review(
            value,
            Some(&plan()),
            &RiskSettings::safe_default(),
            dec!(10000),
            Decimal::ZERO,
            false,
            true,
            &cap(),
            dec!(100000),
        );
        assert!(review
            .blocked_reasons
            .iter()
            .any(|reason| reason.contains("方向")));
        assert!(review
            .blocked_reasons
            .iter()
            .any(|reason| reason.contains("止损")));
    }
}
