use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("参数错误：{0}")]
    Validation(String),
    #[error("安全检查未通过：{0}")]
    Security(String),
    #[error("风险控制阻止操作：{0}")]
    Risk(String),
    #[error("交易所返回错误：{0}")]
    Exchange(String),
    #[error("本地数据库错误：{0}")]
    Database(#[from] rusqlite::Error),
    #[error("安全凭据错误：{0}")]
    Keyring(#[from] keyring::Error),
    #[error("网络错误：{0}")]
    Network(#[from] reqwest::Error),
    #[error("序列化错误：{0}")]
    Serialization(#[from] serde_json::Error),
    #[error("系统错误：{0}")]
    System(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
