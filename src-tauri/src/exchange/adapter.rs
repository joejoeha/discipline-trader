use crate::{error::AppResult, storage::CredentialSecret, types::*};
use async_trait::async_trait;

#[async_trait]
pub trait ExchangeAdapter: Send + Sync {
    fn id(&self) -> ExchangeId;
    async fn get_capabilities(
        &self,
        credentials: Option<&CredentialSecret>,
    ) -> AppResult<ExchangeCapabilities>;
    async fn get_instruments(&self) -> AppResult<Vec<Instrument>>;
    async fn get_klines(
        &self,
        symbol: &str,
        timeframe: &str,
        limit: usize,
    ) -> AppResult<Vec<Candle>>;
    async fn get_balances(&self, credentials: &CredentialSecret) -> AppResult<Vec<Balance>>;
    async fn get_positions(&self, credentials: &CredentialSecret) -> AppResult<Vec<Position>>;
    async fn get_orders(
        &self,
        credentials: &CredentialSecret,
        symbol: Option<&str>,
    ) -> AppResult<Vec<OpenOrder>>;
    async fn place_order(
        &self,
        credentials: &CredentialSecret,
        intent: &OrderIntent,
    ) -> AppResult<OrderResult>;
    async fn cancel_order(
        &self,
        credentials: &CredentialSecret,
        order_id: &str,
    ) -> AppResult<OrderResult>;
    async fn cancel_all(
        &self,
        credentials: &CredentialSecret,
        symbol: Option<&str>,
    ) -> AppResult<u32>;
    async fn set_leverage(
        &self,
        credentials: &CredentialSecret,
        symbol: &str,
        leverage: u32,
        direction: Direction,
    ) -> AppResult<()>;
    async fn set_margin_mode(
        &self,
        credentials: &CredentialSecret,
        symbol: &str,
        mode: MarginMode,
    ) -> AppResult<()>;
}
