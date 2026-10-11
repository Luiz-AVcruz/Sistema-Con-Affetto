use crate::model::{
    CardEntry, FinancialSale, Owner, OwnerSummary, PaymentMethod, PaymentSummary, Product,
    SaleItem, SaleItemInput, SalePayment, SalePaymentInput, SaleStatus, SplitPaymentCalculation,
    Summary,
};
use crate::{add, exact_non_negative, require, Result, MAX_SAFE_INTEGER};
use std::collections::HashMap;

// Centésimos de porcentagem confirmados para esta feira. Não recalcular taxas
// históricas ao resumir: o leitor deve fornecer os valores gravados/retificados.
pub fn payment_rate(method: PaymentMethod, entry: Option<CardEntry>) -> i64 {
    match (method, entry) {
        (PaymentMethod::Debit, Some(CardEntry::Inserted)) => 199,
        (PaymentMethod::Credit, Some(CardEntry::Inserted)) => 498,
        (PaymentMethod::Debit, _) => 89,
        (PaymentMethod::Credit, _) => 309,
        _ => 0,
    }
}

/// Arredonda a taxa uma vez por pedido (meio centavo sobe). Distribui o restante
/// pelos maiores restos e, em empate, pela ordem original dos itens.
pub fn calculate_payment_fees(
    amounts: &[i64],
    method: PaymentMethod,
    entry: Option<CardEntry>,
) -> Result<Vec<i64>> {
    require(
        amounts
            .iter()
            .all(|amount| (0..=MAX_SAFE_INTEGER).contains(amount)),
        400,
        "Valor inválido para calcular a taxa.",
    )?;
    let rate = i128::from(payment_rate(method, entry));
    let mut total = 0_i128;
    let mut floor_total = 0_i128;
    let mut fees = Vec::with_capacity(amounts.len());
    let mut priority = Vec::with_capacity(amounts.len());
    for (index, &amount) in amounts.iter().enumerate() {
        let numerator = i128::from(amount) * rate;
        let floor = numerator / 10_000;
        total = total
            .checked_add(i128::from(amount))
            .ok_or_else(|| crate::BusinessError::new(400, "Total fora do limite de cálculo."))?;
        floor_total += floor;
        fees.push(exact_non_negative(floor)?);
        priority.push((index, numerator % 10_000));
    }
    let numerator = total
        .checked_mul(rate)
        .and_then(|value| value.checked_add(5_000))
        .ok_or_else(|| crate::BusinessError::new(400, "Total fora do limite de cálculo."))?;
    let rounded_fee = exact_non_negative(numerator / 10_000)?;
    let remaining = usize::try_from(i128::from(rounded_fee) - floor_total)
        .map_err(|_| crate::BusinessError::new(400, "Distribuição de taxa inválida."))?;
    require(
        remaining <= amounts.len(),
        400,
        "Distribuição de taxa inválida.",
    )?;
    priority.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    for &(index, _) in priority.iter().take(remaining) {
        fees[index] += 1;
    }
    Ok(fees)
}

/// Distribui a taxa das duas transações entre participantes e depois entre
/// seus itens. Em cada etapa, os centavos indivisíveis vão para os maiores
/// restos; empates mantêm a ordem original.
pub fn calculate_split_payment_fees(
    amounts: &[i64],
    owner_ids: &[i64],
    inputs: &[SalePaymentInput],
) -> Result<SplitPaymentCalculation> {
    require(
        amounts
            .iter()
            .all(|amount| (0..=MAX_SAFE_INTEGER).contains(amount))
            && owner_ids.len() == amounts.len()
            && owner_ids
                .iter()
                .all(|owner_id| (1..=MAX_SAFE_INTEGER).contains(owner_id)),
        400,
        "Itens inválidos para dividir o pagamento.",
    )?;
    require(
        inputs.len() == 2,
        400,
        "Informe exatamente duas formas de pagamento.",
    )?;

    let mut payments = Vec::with_capacity(inputs.len());
    for input in inputs {
        require(
            matches!(
                input.payment_method,
                PaymentMethod::Cash
                    | PaymentMethod::Pix
                    | PaymentMethod::Debit
                    | PaymentMethod::Credit
            ) && (1..=MAX_SAFE_INTEGER).contains(&input.amount_cents),
            400,
            "Cada pagamento deve ter uma forma válida e um valor maior que zero.",
        )?;
        require(
            input.card_entry.is_none()
                || matches!(
                    input.payment_method,
                    PaymentMethod::Debit | PaymentMethod::Credit
                ),
            400,
            "A leitura do cartão só pode ser informada em pagamentos de cartão.",
        )?;
        let card_entry = if matches!(
            input.payment_method,
            PaymentMethod::Debit | PaymentMethod::Credit
        ) {
            Some(input.card_entry.unwrap_or(CardEntry::Contactless))
        } else {
            None
        };
        let fee_cents =
            calculate_payment_fees(&[input.amount_cents], input.payment_method, card_entry)?[0];
        payments.push(SalePayment {
            payment_method: input.payment_method,
            amount_cents: input.amount_cents,
            card_entry,
            fee_cents,
            net_cents: input.amount_cents - fee_cents,
        });
    }
    require(
        payments[0].payment_method != payments[1].payment_method
            || payments[0].card_entry != payments[1].card_entry,
        400,
        "Escolha duas formas de pagamento diferentes.",
    )?;

    let item_total = amounts
        .iter()
        .map(|amount| i128::from(*amount))
        .sum::<i128>();
    let payment_total = payments
        .iter()
        .map(|payment| i128::from(payment.amount_cents))
        .sum::<i128>();
    require(
        item_total <= i128::from(MAX_SAFE_INTEGER) && item_total == payment_total,
        400,
        "A soma dos dois pagamentos deve ser igual ao total do pedido.",
    )?;

    let mut group_indices = HashMap::new();
    let mut groups: Vec<(Vec<usize>, Vec<i64>, i64)> = Vec::new();
    for (index, (&amount, &owner_id)) in amounts.iter().zip(owner_ids).enumerate() {
        let group_index = *group_indices.entry(owner_id).or_insert_with(|| {
            groups.push((Vec::new(), Vec::new(), 0));
            groups.len() - 1
        });
        let group = &mut groups[group_index];
        group.0.push(index);
        group.1.push(amount);
        group.2 += amount;
    }

    let total_fee = payments
        .iter()
        .map(|payment| i128::from(payment.fee_cents))
        .sum::<i128>();
    let total_fee = exact_non_negative(total_fee)?;
    let owner_fees = allocate_cents(
        total_fee,
        &groups.iter().map(|group| group.2).collect::<Vec<_>>(),
    )?;
    let mut fees = vec![0; amounts.len()];
    for (group_index, (indices, weights, _)) in groups.iter().enumerate() {
        for (item_index, fee) in allocate_cents(owner_fees[group_index], weights)?
            .into_iter()
            .enumerate()
        {
            fees[indices[item_index]] = fee;
        }
    }

    Ok(SplitPaymentCalculation { fees, payments })
}

fn allocate_cents(total: i64, weights: &[i64]) -> Result<Vec<i64>> {
    let denominator = weights
        .iter()
        .map(|weight| i128::from(*weight))
        .sum::<i128>();
    if denominator == 0 {
        require(
            total == 0,
            400,
            "Não é possível ratear uma taxa sem valor recebido.",
        )?;
        return Ok(vec![0; weights.len()]);
    }

    let mut allocated = Vec::with_capacity(weights.len());
    let mut priority = Vec::with_capacity(weights.len());
    let mut floor_total = 0_i128;
    for (index, &weight) in weights.iter().enumerate() {
        let numerator = i128::from(total) * i128::from(weight);
        let floor = numerator / denominator;
        floor_total += floor;
        allocated.push(exact_non_negative(floor)?);
        priority.push((index, numerator % denominator));
    }
    let remaining = usize::try_from(i128::from(total) - floor_total)
        .map_err(|_| crate::BusinessError::new(400, "Distribuição de taxa inválida."))?;
    require(
        remaining <= weights.len(),
        400,
        "Distribuição de taxa inválida.",
    )?;
    priority.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    for &(index, _) in priority.iter().take(remaining) {
        allocated[index] += 1;
    }
    Ok(allocated)
}

pub fn calculate_item(
    product: &Product,
    input: &SaleItemInput,
    method: PaymentMethod,
) -> Result<SaleItem> {
    require(
        (1..=10_000).contains(&input.quantity)
            && [
                product.price_cents,
                input.expected_price_cents,
                input.discount_cents,
                input.fee_cents,
            ]
            .iter()
            .all(|value| (0..=100_000_000).contains(value))
            && (1..=MAX_SAFE_INTEGER).contains(&product.id)
            && (1..=MAX_SAFE_INTEGER).contains(&product.owner_id)
            && (1..=MAX_SAFE_INTEGER).contains(&input.product_id),
        400,
        "Item inválido para cálculo.",
    )?;
    require(
        product.active,
        409,
        format!("Produto inativo: {}", product.name),
    )?;
    require(
        product.price_cents == input.expected_price_cents,
        409,
        format!("O preço de {} mudou. Atualize o pedido.", product.name),
    )?;
    require(
        input
            .expected_name
            .as_ref()
            .is_none_or(|name| name == &product.name)
            && input
                .expected_owner_id
                .is_none_or(|id| id == product.owner_id)
            && input
                .expected_owner_name
                .as_ref()
                .is_none_or(|name| name == &product.owner_name),
        409,
        format!(
            "O cadastro de {} mudou. Confira nome e participante antes de atualizar o pedido.",
            product.name
        ),
    )?;
    let gross_cents =
        exact_non_negative(i128::from(product.price_cents) * i128::from(input.quantity))?;
    require(
        input.discount_cents <= gross_cents,
        400,
        format!("Desconto maior que o valor de {}.", product.name),
    )?;
    let charged_cents = gross_cents - input.discount_cents;
    require(
        input.fee_cents <= charged_cents,
        400,
        format!("Taxa maior que o valor de {}.", product.name),
    )?;
    require(
        !method.is_non_cash() || input.discount_cents == 0 && input.fee_cents == 0,
        400,
        "Permutas e brindes não recebem desconto ou taxa.",
    )?;
    let total_cents = if method.is_non_cash() {
        0
    } else {
        charged_cents
    };
    Ok(SaleItem {
        input: input.clone(),
        name: product.name.clone(),
        owner_id: product.owner_id,
        owner_name: product.owner_name.clone(),
        price_cents: product.price_cents,
        gross_cents,
        total_cents,
        net_cents: total_cents - input.fee_cents,
    })
}

pub fn apply_payment_fees(
    items: &[SaleItem],
    method: PaymentMethod,
    entry: Option<CardEntry>,
) -> Result<Vec<SaleItem>> {
    let amounts: Vec<_> = items.iter().map(|item| item.total_cents).collect();
    let fees = calculate_payment_fees(&amounts, method, entry)?;
    Ok(items
        .iter()
        .zip(fees)
        .map(|(item, fee)| {
            let mut corrected = item.clone();
            corrected.input.fee_cents = fee;
            corrected.net_cents = item.total_cents - fee;
            corrected
        })
        .collect())
}

pub fn summarize(sales: &[FinancialSale], owners: &[Owner], date: Option<&str>) -> Result<Summary> {
    let mut summary = Summary {
        by_owner: owners
            .iter()
            .map(|owner| OwnerSummary {
                owner_id: owner.id,
                name: owner.name.clone(),
                ..OwnerSummary::default()
            })
            .collect(),
        by_payment: [
            PaymentMethod::Cash,
            PaymentMethod::Pix,
            PaymentMethod::Debit,
            PaymentMethod::Credit,
        ]
        .into_iter()
        .map(|method| PaymentSummary {
            method,
            total_cents: 0,
        })
        .collect(),
        ..Summary::default()
    };
    let mut owner_indices = HashMap::new();
    for (index, owner) in owners.iter().enumerate() {
        owner_indices.entry(owner.id).or_insert(index);
    }
    let date = date.filter(|date| !date.is_empty());
    for sale in sales {
        if sale.status == SaleStatus::Pending && date.is_none_or(|date| sale.date == date) {
            add(&mut summary.pending_cents, sale.total_cents)?;
        }
        if sale.status != SaleStatus::Paid
            || date.is_some_and(|date| sale.payment_date.as_deref() != Some(date))
        {
            continue;
        }
        add(&mut summary.paid_count, 1)?;
        if sale.payment_method.is_non_cash() {
            let target = if sale.payment_method == PaymentMethod::Barter {
                &mut summary.barter_units
            } else {
                &mut summary.gift_units
            };
            for item in &sale.items {
                add(target, item.input.quantity)?;
            }
            continue;
        }
        add(&mut summary.received_cents, sale.total_cents)?;
        add(&mut summary.net_cents, sale.net_cents)?;
        add(&mut summary.discount_cents, sale.discount_cents)?;
        add(&mut summary.fee_cents, sale.fee_cents)?;
        if let Some(payments) = &sale.payments {
            for payment in payments {
                let index = payment.payment_method.payment_index().ok_or_else(|| {
                    crate::BusinessError::new(400, "Pagamento financeiro inválido.")
                })?;
                add(
                    &mut summary.by_payment[index].total_cents,
                    payment.amount_cents,
                )?;
            }
        } else {
            let index = sale
                .payment_method
                .payment_index()
                .expect("pagamento financeiro");
            add(&mut summary.by_payment[index].total_cents, sale.total_cents)?;
        }
        for item in &sale.items {
            let index = *owner_indices.entry(item.owner_id).or_insert_with(|| {
                summary.by_owner.push(OwnerSummary {
                    owner_id: item.owner_id,
                    name: item.owner_name.clone(),
                    ..OwnerSummary::default()
                });
                summary.by_owner.len() - 1
            });
            let owner = &mut summary.by_owner[index];
            add(&mut owner.received_cents, item.total_cents)?;
            add(&mut owner.fee_cents, item.input.fee_cents)?;
            add(&mut owner.net_cents, item.net_cents)?;
        }
    }
    Ok(summary)
}
