//! JSON representa um número inteiro também como 2000.0, 2e3 e -0.
//! A conversão termina aqui: o domínio recebe somente i64 exatos para JS.
use crate::MAX_SAFE_INTEGER;
use serde::de::{self, Unexpected, Visitor};
use serde::{Deserialize, Deserializer};
use std::fmt;

struct JsonInteger(i64);
struct IntegerVisitor;

impl Visitor<'_> for IntegerVisitor {
    type Value = JsonInteger;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("um número inteiro no intervalo exato do JavaScript")
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
        if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value) {
            Ok(JsonInteger(value))
        } else {
            Err(E::invalid_value(Unexpected::Signed(value), &self))
        }
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        if value <= MAX_SAFE_INTEGER as u64 {
            Ok(JsonInteger(value as i64))
        } else {
            Err(E::invalid_value(Unexpected::Unsigned(value), &self))
        }
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
        // Aceita as mesmas representações integrais de JSON.parse e rejeita
        // frações/valores inseguros antes de converter, sem truncamento.
        if value.is_finite()
            && value.fract() == 0.0
            && (-MAX_SAFE_INTEGER as f64..=MAX_SAFE_INTEGER as f64).contains(&value)
        {
            Ok(JsonInteger(value as i64))
        } else {
            Err(E::invalid_value(Unexpected::Float(value), &self))
        }
    }
}

impl<'de> Deserialize<'de> for JsonInteger {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(IntegerVisitor)
    }
}

pub(crate) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    JsonInteger::deserialize(deserializer).map(|integer| integer.0)
}

pub(crate) fn optional<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    Option::<JsonInteger>::deserialize(deserializer).map(|integer| integer.map(|value| value.0))
}

pub(crate) fn array<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<i64>, D::Error> {
    Vec::<JsonInteger>::deserialize(deserializer)
        .map(|values| values.into_iter().map(|value| value.0).collect())
}
