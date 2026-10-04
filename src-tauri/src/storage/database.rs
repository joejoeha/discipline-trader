use crate::error::{AppError, AppResult};
use crate::types::*;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    path::Path,
    sync::{Mutex, MutexGuard},
};

pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| AppError::System(error.to_string()))?;
        }
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.execute_batch(MIGRATIONS)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn conn(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| AppError::System("数据库锁异常".into()))
    }

    pub fn get_setting<T: DeserializeOwned>(&self, key: &str) -> AppResult<Option<T>> {
        let value: Option<String> = self
            .conn()?
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()?;
        value
            .map(|raw| serde_json::from_str(&raw).map_err(AppError::from))
            .transpose()
    }

    pub fn set_setting<T: Serialize>(&self, key: &str, value: &T) -> AppResult<()> {
        let encoded = serde_json::to_string(value)?;
        self.conn()?.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params![key, encoded, Utc::now().timestamp_millis()])?;
        Ok(())
    }

    pub fn remove_setting(&self, key: &str) -> AppResult<()> {
        self.conn()?
            .execute("DELETE FROM settings WHERE key=?1", [key])?;
        Ok(())
    }

    pub fn list_plans(&self) -> AppResult<Vec<TradingPlan>> {
        self.list_json("trading_plans")
    }
    pub fn save_plan(&self, plan: &TradingPlan) -> AppResult<()> {
        self.save_json("trading_plans", &plan.id, plan)
    }
    pub fn list_orders(&self) -> AppResult<Vec<OpenOrder>> {
        self.list_json("orders")
    }
    pub fn save_order(&self, order: &OpenOrder) -> AppResult<()> {
        self.save_json("orders", &order.order_id, order)
    }
    pub fn delete_order(&self, order_id: &str) -> AppResult<()> {
        self.delete_json("orders", order_id)
    }
    pub fn list_positions(&self) -> AppResult<Vec<Position>> {
        self.list_json("positions")
    }
    pub fn save_position(&self, position: &Position) -> AppResult<()> {
        self.save_json("positions", &position.id, position)
    }
    pub fn delete_position(&self, position_id: &str) -> AppResult<()> {
        self.delete_json("positions", position_id)
    }
    pub fn list_reviews(&self) -> AppResult<Vec<PositionReview>> {
        self.list_json("position_reviews")
    }
    pub fn save_review(&self, review: &PositionReview) -> AppResult<()> {
        self.save_json("position_reviews", &review.id, review)
    }
    pub fn list_dca_plans(&self) -> AppResult<Vec<DcaPlan>> {
        self.list_json("dca_plans")
    }
    pub fn save_dca_plan(&self, plan: &DcaPlan) -> AppResult<()> {
        self.save_json("dca_plans", &plan.id, plan)
    }
    pub fn save_chart_template(&self, template: &ChartTemplate) -> AppResult<()> {
        self.save_json("chart_templates", &template.id, template)
    }
    pub fn list_chart_templates(&self) -> AppResult<Vec<ChartTemplate>> {
        self.list_json("chart_templates")
    }
    pub fn save_fill(&self, fill: &TradeFill) -> AppResult<()> {
        self.save_json("trade_fills", &fill.id, fill)
    }
    pub fn list_fills(&self) -> AppResult<Vec<TradeFill>> {
        self.list_json("trade_fills")
    }
    pub fn record_risk_event(&self, event_type: &str, message: &str) -> AppResult<()> {
        self.conn()?.execute(
            "INSERT INTO risk_events(id,event_type,details,created_at) VALUES(?1,?2,?3,?4)",
            params![
                uuid::Uuid::new_v4().to_string(),
                event_type,
                serde_json::json!({"message":message}).to_string(),
                Utc::now().timestamp_millis()
            ],
        )?;
        Ok(())
    }
    pub fn list_risk_events(&self) -> AppResult<Vec<RiskEvent>> {
        let connection = self.conn()?;
        let mut statement = connection.prepare(
            "SELECT id,event_type,details,created_at FROM risk_events ORDER BY created_at DESC LIMIT 200",
        )?;
        let values = statement
            .query_map([], |row| {
                let details: String = row.get(2)?;
                let message = serde_json::from_str::<serde_json::Value>(&details)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("message")
                            .and_then(|item| item.as_str())
                            .map(str::to_owned)
                    })
                    .unwrap_or(details);
                Ok(RiskEvent {
                    id: row.get(0)?,
                    event_type: row.get(1)?,
                    message,
                    created_at: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(values)
    }
    pub fn save_live_order_map(
        &self,
        client_order_id: &str,
        exchange: ExchangeId,
        exchange_order_id: Option<&str>,
        state: &str,
    ) -> AppResult<()> {
        let now = Utc::now().timestamp_millis();
        self.conn()?.execute(
            "INSERT INTO live_order_map(client_order_id,exchange,exchange_order_id,state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5) ON CONFLICT(client_order_id) DO UPDATE SET exchange_order_id=excluded.exchange_order_id,state=excluded.state,updated_at=excluded.updated_at",
            params![client_order_id, exchange.as_str(), exchange_order_id, state, now],
        )?;
        Ok(())
    }

    pub fn save_credential_status(&self, status: &CredentialStatus) -> AppResult<()> {
        self.save_json("credential_metadata", status.exchange.as_str(), status)
    }

    pub fn credential_status(&self, exchange: ExchangeId) -> AppResult<Option<CredentialStatus>> {
        self.get_json("credential_metadata", exchange.as_str())
    }

    pub fn delete_credential_status(&self, exchange: ExchangeId) -> AppResult<()> {
        self.delete_json("credential_metadata", exchange.as_str())
    }

    pub fn audit(&self, category: &str, action: &str, details: serde_json::Value) -> AppResult<()> {
        let redacted = redact(details);
        self.conn()?.execute(
            "INSERT INTO audit_log(id,category,action,details,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                category,
                action,
                serde_json::to_string(&redacted)?,
                Utc::now().timestamp_millis()
            ],
        )?;
        Ok(())
    }

    fn list_json<T: DeserializeOwned>(&self, table: &str) -> AppResult<Vec<T>> {
        ensure_table(table)?;
        let sql = format!("SELECT data FROM {table} ORDER BY updated_at DESC");
        let connection = self.conn()?;
        let mut statement = connection.prepare(&sql)?;
        let values = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        values
            .into_iter()
            .map(|value| serde_json::from_str(&value).map_err(AppError::from))
            .collect()
    }

    fn get_json<T: DeserializeOwned>(&self, table: &str, id: &str) -> AppResult<Option<T>> {
        ensure_table(table)?;
        let sql = format!("SELECT data FROM {table} WHERE id=?1");
        let raw: Option<String> = self
            .conn()?
            .query_row(&sql, [id], |row| row.get(0))
            .optional()?;
        raw.map(|value| serde_json::from_str(&value).map_err(AppError::from))
            .transpose()
    }

    fn save_json<T: Serialize>(&self, table: &str, id: &str, value: &T) -> AppResult<()> {
        ensure_table(table)?;
        let sql = format!("INSERT INTO {table}(id,data,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at");
        self.conn()?.execute(
            &sql,
            params![
                id,
                serde_json::to_string(value)?,
                Utc::now().timestamp_millis()
            ],
        )?;
        Ok(())
    }

    fn delete_json(&self, table: &str, id: &str) -> AppResult<()> {
        ensure_table(table)?;
        let sql = format!("DELETE FROM {table} WHERE id=?1");
        self.conn()?.execute(&sql, [id])?;
        Ok(())
    }
}

fn ensure_table(table: &str) -> AppResult<()> {
    const ALLOWED: &[&str] = &[
        "trading_plans",
        "orders",
        "positions",
        "position_reviews",
        "dca_plans",
        "chart_templates",
        "trade_fills",
        "credential_metadata",
    ];
    if ALLOWED.contains(&table) {
        Ok(())
    } else {
        Err(AppError::System("非法数据表".into()))
    }
}

fn redact(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(object) = value.as_object_mut() {
        for (key, item) in object.iter_mut() {
            let lower = key.to_ascii_lowercase();
            if lower.contains("secret")
                || lower.contains("signature")
                || lower.contains("apikey")
                || lower.contains("api_key")
                || lower.contains("header")
            {
                *item = serde_json::Value::String("[REDACTED]".into());
            } else {
                *item = redact(item.take());
            }
        }
    } else if let Some(array) = value.as_array_mut() {
        for item in array.iter_mut() {
            *item = redact(item.take());
        }
    }
    value
}

const MIGRATIONS: &str = r#"
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS trading_plans (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS positions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS position_reviews (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dca_plans (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chart_templates (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS trade_fills (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS credential_metadata (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS live_order_map (client_order_id TEXT PRIMARY KEY, exchange TEXT NOT NULL, exchange_order_id TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS risk_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, category TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_round_trip() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::open(&temp.path().join("test.db")).unwrap();
        let settings = RiskSettings::safe_default();
        database.set_setting("risk", &settings).unwrap();
        let loaded: RiskSettings = database.get_setting("risk").unwrap().unwrap();
        assert_eq!(loaded.max_leverage, 10);
    }
}
