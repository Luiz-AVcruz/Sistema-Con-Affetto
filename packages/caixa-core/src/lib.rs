//! Núcleo financeiro reutilizável pelo futuro backend e pelo Tauri.
//!
//! Não abre bancos, não altera estoque e não reinterpreta snapshots fechados.

pub mod finance;
mod json_integer;
pub mod model;
pub mod protocol;

use serde::Serialize;
use std::fmt;

/// Mesmo limite de inteiros exatos do contrato consumido pelo Angular.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BusinessError {
    pub status: u16,
    pub message: String,
}

impl BusinessError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl fmt::Display for BusinessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for BusinessError {}

pub type Result<T> = std::result::Result<T, BusinessError>;

pub(crate) fn require(condition: bool, status: u16, message: impl Into<String>) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(BusinessError::new(status, message))
    }
}

pub(crate) fn exact_non_negative(value: i128) -> Result<i64> {
    require(
        (0..=i128::from(MAX_SAFE_INTEGER)).contains(&value),
        400,
        "Valor fora do limite exato do contrato JSON.",
    )?;
    Ok(value as i64)
}

pub(crate) fn add(target: &mut i64, value: i64) -> Result<()> {
    require(
        (0..=MAX_SAFE_INTEGER).contains(&value),
        400,
        "Valor financeiro inválido.",
    )?;
    *target = exact_non_negative(i128::from(*target) + i128::from(value))?;
    Ok(())
}
