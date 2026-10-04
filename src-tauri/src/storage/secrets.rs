use crate::{
    error::{AppError, AppResult},
    types::ExchangeId,
};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSecret {
    pub api_key: String,
    pub secret: String,
    pub passphrase: Option<String>,
}

pub struct SecretStore {
    service: String,
}

impl SecretStore {
    pub fn new() -> Self {
        Self {
            service: "DisciplineTrader.ExchangeCredentials".into(),
        }
    }

    pub fn save(&self, exchange: ExchangeId, secret: &CredentialSecret) -> AppResult<()> {
        if secret.api_key.trim().is_empty() || secret.secret.trim().is_empty() {
            return Err(AppError::Validation("API Key 与 Secret 均不能为空".into()));
        }
        let encoded = serde_json::to_string(secret)?;
        keyring::Entry::new(&self.service, exchange.as_str())?.set_password(&encoded)?;
        Ok(())
    }

    pub fn load(&self, exchange: ExchangeId) -> AppResult<Option<CredentialSecret>> {
        match keyring::Entry::new(&self.service, exchange.as_str())?.get_password() {
            Ok(raw) => Ok(Some(serde_json::from_str(&raw)?)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn delete(&self, exchange: ExchangeId) -> AppResult<()> {
        match keyring::Entry::new(&self.service, exchange.as_str())?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}
