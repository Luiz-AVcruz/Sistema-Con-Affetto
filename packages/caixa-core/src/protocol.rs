//! Fronteira JSON para comparar o núcleo com Node sem HTTP nem banco.
use crate::finance::{
    apply_payment_fees, calculate_item, calculate_payment_fees, calculate_split_payment_fees,
    summarize,
};
use crate::model::{
    CardEntry, FinancialSale, Owner, PaymentMethod, Product, SaleItem, SaleItemInput,
    SalePaymentInput,
};
use crate::{BusinessError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    #[serde(rename = "calculatePaymentFees")]
    CalculatePaymentFees {
        #[serde(deserialize_with = "crate::json_integer::array")]
        amounts: Vec<i64>,
        method: PaymentMethod,
        #[serde(default)]
        entry: Option<CardEntry>,
    },
    #[serde(rename = "calculateSplitPaymentFees")]
    CalculateSplitPaymentFees {
        #[serde(deserialize_with = "crate::json_integer::array")]
        amounts: Vec<i64>,
        #[serde(deserialize_with = "crate::json_integer::array")]
        owner_ids: Vec<i64>,
        payments: Vec<SalePaymentInput>,
    },
    #[serde(rename = "calculateItem")]
    CalculateItem {
        product: Product,
        input: SaleItemInput,
        method: PaymentMethod,
    },
    #[serde(rename = "applyPaymentFees")]
    ApplyPaymentFees {
        items: Vec<SaleItem>,
        method: PaymentMethod,
        #[serde(default)]
        entry: Option<CardEntry>,
    },
    #[serde(rename = "summarize")]
    Summarize {
        sales: Vec<FinancialSale>,
        owners: Vec<Owner>,
        #[serde(default)]
        date: Option<String>,
    },
}

impl Command {
    pub fn execute(self) -> Result<Value> {
        fn json(value: impl Serialize) -> Result<Value> {
            serde_json::to_value(value).map_err(|error| BusinessError::new(500, error.to_string()))
        }
        match self {
            Self::CalculatePaymentFees {
                amounts,
                method,
                entry,
            } => json(calculate_payment_fees(&amounts, method, entry)?),
            Self::CalculateSplitPaymentFees {
                amounts,
                owner_ids,
                payments,
            } => json(calculate_split_payment_fees(
                &amounts, &owner_ids, &payments,
            )?),
            Self::CalculateItem {
                product,
                input,
                method,
            } => json(calculate_item(&product, &input, method)?),
            Self::ApplyPaymentFees {
                items,
                method,
                entry,
            } => json(apply_payment_fees(&items, method, entry)?),
            Self::Summarize {
                sales,
                owners,
                date,
            } => json(summarize(&sales, &owners, date.as_deref())?),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Success { ok: bool, result: Value },
    Failure { ok: bool, error: BusinessError },
}

pub fn evaluate(line: &str) -> Response {
    let result = serde_json::from_str::<Command>(line)
        .map_err(|error| BusinessError::new(400, format!("Comando JSON inválido: {error}")))
        .and_then(Command::execute);
    match result {
        Ok(result) => Response::Success { ok: true, result },
        Err(error) => Response::Failure { ok: false, error },
    }
}
