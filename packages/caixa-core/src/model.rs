use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PaymentMethod {
    #[serde(rename = "Dinheiro")]
    Cash,
    #[serde(rename = "Pix")]
    Pix,
    #[serde(rename = "Cartão débito")]
    Debit,
    #[serde(rename = "Cartão crédito")]
    Credit,
    #[serde(rename = "Permuta")]
    Barter,
    #[serde(rename = "Não cobrado")]
    Gift,
}

impl PaymentMethod {
    pub fn is_non_cash(self) -> bool {
        matches!(self, Self::Barter | Self::Gift)
    }

    pub(crate) fn payment_index(self) -> Option<usize> {
        match self {
            Self::Cash => Some(0),
            Self::Pix => Some(1),
            Self::Debit => Some(2),
            Self::Credit => Some(3),
            Self::Barter | Self::Gift => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardEntry {
    #[serde(rename = "Aproximação")]
    Contactless,
    #[serde(rename = "Inserido")]
    Inserted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SaleStatus {
    #[serde(rename = "Pago")]
    Paid,
    #[serde(rename = "Pendente")]
    Pending,
    #[serde(rename = "Cancelado")]
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub id: i64,
    pub name: String,
    pub description: String,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub owner_id: i64,
    pub owner_name: String,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub price_cents: i64,
    #[serde(default, deserialize_with = "crate::json_integer::optional")]
    pub stock: Option<i64>,
    pub active: bool,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub version: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleItemInput {
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub product_id: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub quantity: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub expected_price_cents: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::json_integer::optional"
    )]
    pub expected_owner_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_owner_name: Option<String>,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub discount_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub fee_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleItem {
    #[serde(flatten)]
    pub input: SaleItemInput,
    pub name: String,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub owner_id: i64,
    pub owner_name: String,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub price_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub gross_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub total_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub net_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalePaymentInput {
    pub payment_method: PaymentMethod,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub amount_cents: i64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_card_entry_option"
    )]
    pub card_entry: Option<CardEntry>,
}

fn deserialize_card_entry_option<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<CardEntry>, D::Error> {
    CardEntry::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalePayment {
    pub payment_method: PaymentMethod,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub amount_cents: i64,
    pub card_entry: Option<CardEntry>,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub fee_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub net_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitPaymentCalculation {
    #[serde(deserialize_with = "crate::json_integer::array")]
    pub fees: Vec<i64>,
    pub payments: Vec<SalePayment>,
}

/// Projeção financeira de Sale. Campos de transporte (ID, origem, horário,
/// feira e metadados de retificação) continuam sob responsabilidade do leitor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinancialSale {
    pub date: String,
    pub payment_date: Option<String>,
    pub payment_method: PaymentMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payments: Option<Vec<SalePayment>>,
    pub status: SaleStatus,
    pub items: Vec<SaleItem>,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub discount_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub fee_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub total_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub net_cents: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerSummary {
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub owner_id: i64,
    pub name: String,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub received_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub fee_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub net_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentSummary {
    pub method: PaymentMethod,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub total_cents: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub received_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub net_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub discount_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub fee_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub pending_cents: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub paid_count: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub barter_units: i64,
    #[serde(deserialize_with = "crate::json_integer::deserialize")]
    pub gift_units: i64,
    pub by_owner: Vec<OwnerSummary>,
    pub by_payment: Vec<PaymentSummary>,
}
