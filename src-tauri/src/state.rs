use crate::{
    error::{AppError, AppResult},
    exchange::{ExchangeAdapter, MexcAdapter, OurbitAdapter},
    storage::{Database, SecretStore},
    types::*,
};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use chrono::Utc;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

pub struct RuntimeState {
    pub reviews: HashMap<String, OrderReview>,
    pub live_unlocked_until: Option<i64>,
    pub emergency_stopped: bool,
    pub lock_reasons: Vec<String>,
    pub used_client_order_ids: HashSet<String>,
    pub subscriptions: HashSet<String>,
    pub capabilities: HashMap<ExchangeId, ExchangeCapabilities>,
    pub markets: HashMap<String, MarketSnapshot>,
}

pub struct AppState {
    pub db: Database,
    pub secrets: SecretStore,
    pub adapters: HashMap<ExchangeId, Arc<dyn ExchangeAdapter>>,
    pub runtime: Mutex<RuntimeState>,
}

impl AppState {
    pub fn initialize(data_dir: &Path) -> AppResult<Self> {
        let db = Database::open(&data_dir.join("discipline-trader.db"))?;
        let emergency_stopped = db.get_setting("emergency_stopped")?.unwrap_or(false);
        let adapters: HashMap<ExchangeId, Arc<dyn ExchangeAdapter>> = HashMap::from([
            (
                ExchangeId::Mexc,
                Arc::new(MexcAdapter::new()) as Arc<dyn ExchangeAdapter>,
            ),
            (
                ExchangeId::Ourbit,
                Arc::new(OurbitAdapter::new()) as Arc<dyn ExchangeAdapter>,
            ),
        ]);
        Ok(Self {
            db,
            secrets: SecretStore::new(),
            adapters,
            runtime: Mutex::new(RuntimeState {
                reviews: HashMap::new(),
                live_unlocked_until: None,
                emergency_stopped,
                lock_reasons: if emergency_stopped {
                    vec!["已触发立即停止实盘".into()]
                } else {
                    Vec::new()
                },
                used_client_order_ids: HashSet::new(),
                subscriptions: HashSet::new(),
                capabilities: HashMap::new(),
                markets: HashMap::new(),
            }),
        })
    }
    pub fn runtime(&self) -> AppResult<MutexGuard<'_, RuntimeState>> {
        self.runtime
            .lock()
            .map_err(|_| AppError::System("运行状态锁异常".into()))
    }
    pub fn adapter(&self, exchange: ExchangeId) -> AppResult<Arc<dyn ExchangeAdapter>> {
        self.adapters
            .get(&exchange)
            .cloned()
            .ok_or_else(|| AppError::Validation("未知交易所".into()))
    }
    pub fn risk_settings(&self) -> AppResult<RiskSettings> {
        Ok(self
            .db
            .get_setting("risk_settings")?
            .unwrap_or_else(RiskSettings::safe_default))
    }
    pub fn set_pin(&self, pin: &str) -> AppResult<()> {
        if !(6..=12).contains(&pin.len()) || !pin.chars().all(|value| value.is_ascii_digit()) {
            return Err(AppError::Validation("PIN 必须为 6–12 位数字".into()));
        }
        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default()
            .hash_password(pin.as_bytes(), &salt)
            .map_err(|error| AppError::Security(error.to_string()))?
            .to_string();
        self.db.set_setting("pin_hash", &hash)?;
        self.db
            .audit("security", "pin_updated", serde_json::json!({}))?;
        Ok(())
    }
    pub fn verify_pin(&self, pin: &str) -> AppResult<()> {
        let encoded: String = self
            .db
            .get_setting("pin_hash")?
            .ok_or_else(|| AppError::Security("尚未设置本机 PIN".into()))?;
        let parsed = PasswordHash::new(&encoded)
            .map_err(|_| AppError::Security("PIN 存储格式异常".into()))?;
        Argon2::default()
            .verify_password(pin.as_bytes(), &parsed)
            .map_err(|_| AppError::Security("PIN 不正确".into()))
    }
    pub fn unlock_live(&self, pin: &str) -> AppResult<()> {
        self.verify_pin(pin)?;
        let mut runtime = self.runtime()?;
        if runtime.emergency_stopped {
            return Err(AppError::Risk(
                "立即停止实盘开关仍处于触发状态，请先单独解除".into(),
            ));
        }
        runtime.live_unlocked_until = Some(Utc::now().timestamp_millis() + 30 * 60_000);
        runtime.lock_reasons.clear();
        drop(runtime);
        self.db.audit(
            "security",
            "live_unlocked",
            serde_json::json!({"durationMinutes":30}),
        )
    }
    pub fn lock_live(&self, reason: &str) -> AppResult<()> {
        let mut runtime = self.runtime()?;
        let mut changed = runtime.live_unlocked_until.take().is_some();
        if !reason.is_empty() && !runtime.lock_reasons.contains(&reason.to_string()) {
            runtime.lock_reasons.push(reason.into());
            changed = true;
        }
        drop(runtime);
        if !changed {
            return Ok(());
        }
        self.db.record_risk_event("live_lock", reason)?;
        self.db
            .audit("risk", "live_locked", serde_json::json!({"reason":reason}))
    }
    pub fn is_live_unlocked(&self) -> AppResult<bool> {
        Ok(self
            .runtime()?
            .live_unlocked_until
            .map(|value| value > Utc::now().timestamp_millis())
            .unwrap_or(false))
    }
}
