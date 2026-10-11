use caixa_core::finance::{
    apply_payment_fees, calculate_item, calculate_payment_fees, calculate_split_payment_fees,
    payment_rate, summarize,
};
use caixa_core::model::{
    CardEntry, FinancialSale, Owner, PaymentMethod, Product, SaleItemInput, SalePaymentInput,
    SaleStatus,
};
use caixa_core::MAX_SAFE_INTEGER;

fn product() -> Product {
    Product {
        id: 1,
        name: "Produto fictício".into(),
        description: String::new(),
        owner_id: 1,
        owner_name: "Empresa fictícia".into(),
        price_cents: 2000,
        stock: None,
        active: true,
        version: 1,
    }
}

fn input() -> SaleItemInput {
    SaleItemInput {
        product_id: 1,
        quantity: 1,
        expected_price_cents: 2000,
        expected_name: None,
        expected_owner_id: None,
        expected_owner_name: None,
        discount_cents: 0,
        fee_cents: 0,
    }
}

fn sale(method: PaymentMethod, status: SaleStatus) -> FinancialSale {
    let item = calculate_item(&product(), &input(), method).unwrap();
    FinancialSale {
        date: "2026-10-10".into(),
        payment_date: (status == SaleStatus::Paid).then(|| "2026-10-11".into()),
        payment_method: method,
        payments: None,
        status,
        discount_cents: 0,
        fee_cents: 0,
        total_cents: item.total_cents,
        net_cents: item.net_cents,
        items: vec![item],
    }
}

fn payment(
    method: PaymentMethod,
    amount_cents: i64,
    card_entry: Option<CardEntry>,
) -> SalePaymentInput {
    SalePaymentInput {
        payment_method: method,
        amount_cents,
        card_entry,
    }
}

fn product_for(owner_id: i64, product_id: i64, name: &str, amount_cents: i64) -> Product {
    Product {
        id: product_id,
        name: name.into(),
        description: String::new(),
        owner_id,
        owner_name: format!("Participante {owner_id}"),
        price_cents: amount_cents,
        stock: None,
        active: true,
        version: 1,
    }
}

fn item_for(
    owner_id: i64,
    product_id: i64,
    name: &str,
    amount_cents: i64,
    discount_cents: i64,
) -> caixa_core::model::SaleItem {
    let product = product_for(owner_id, product_id, name, amount_cents);
    let sale_input = SaleItemInput {
        product_id,
        quantity: 1,
        expected_price_cents: amount_cents,
        expected_name: None,
        expected_owner_id: None,
        expected_owner_name: None,
        discount_cents,
        fee_cents: 0,
    };
    calculate_item(&product, &sale_input, PaymentMethod::Cash).unwrap()
}

#[test]
fn confirmed_rates_and_free_methods() {
    for (method, entry, rate, fee) in [
        (PaymentMethod::Debit, Some(CardEntry::Contactless), 89, 18),
        (PaymentMethod::Credit, Some(CardEntry::Contactless), 309, 62),
        (PaymentMethod::Debit, Some(CardEntry::Inserted), 199, 40),
        (PaymentMethod::Credit, Some(CardEntry::Inserted), 498, 100),
        (PaymentMethod::Cash, None, 0, 0),
        (PaymentMethod::Pix, None, 0, 0),
        (PaymentMethod::Barter, None, 0, 0),
        (PaymentMethod::Gift, None, 0, 0),
    ] {
        assert_eq!(payment_rate(method, entry), rate);
        assert_eq!(
            calculate_payment_fees(&[2000], method, entry).unwrap(),
            [fee]
        );
    }
    assert_eq!(payment_rate(PaymentMethod::Credit, None), 309);
}

#[test]
fn transaction_rounding_and_ties_preserve_order() {
    assert_eq!(
        calculate_payment_fees(&[999, 999, 999, 999], PaymentMethod::Credit, None).unwrap(),
        [31, 31, 31, 30]
    );
    assert_eq!(
        calculate_payment_fees(&[1, 1, 15], PaymentMethod::Credit, None).unwrap(),
        [0, 0, 1]
    );
    assert_eq!(
        calculate_payment_fees(&[5000], PaymentMethod::Debit, None).unwrap(),
        [45]
    );
    assert_eq!(
        calculate_payment_fees(&[0, 1000, 0], PaymentMethod::Credit, None).unwrap(),
        [0, 31, 0]
    );
    assert!(calculate_payment_fees(&[], PaymentMethod::Credit, None)
        .unwrap()
        .is_empty());
}

#[test]
fn wide_intermediates_and_exact_json_bounds() {
    assert_eq!(
        calculate_payment_fees(
            &[1_000_000_000_000],
            PaymentMethod::Credit,
            Some(CardEntry::Inserted)
        )
        .unwrap(),
        [49_800_000_000]
    );
    let amount = MAX_SAFE_INTEGER;
    let fee = calculate_payment_fees(&[amount], PaymentMethod::Credit, Some(CardEntry::Inserted))
        .unwrap();
    assert_eq!(fee, [448_558_522_886_101]);
    assert!(calculate_payment_fees(&[-1], PaymentMethod::Pix, None).is_err());
    assert!(calculate_payment_fees(&[amount + 1], PaymentMethod::Credit, None).is_err());
    assert!(calculate_payment_fees(
        &vec![amount; 21],
        PaymentMethod::Credit,
        Some(CardEntry::Inserted)
    )
    .is_err());
}

#[test]
fn discount_and_each_owners_share() {
    let mut discounted = input();
    discounted.discount_cents = 100;
    let mut other = product();
    other.id = 2;
    other.owner_id = 2;
    other.owner_name = "Outra participante".into();
    let mut other_input = input();
    other_input.product_id = 2;
    let items = vec![
        calculate_item(&product(), &discounted, PaymentMethod::Credit).unwrap(),
        calculate_item(&other, &other_input, PaymentMethod::Credit).unwrap(),
    ];
    let charged = apply_payment_fees(&items, PaymentMethod::Credit, None).unwrap();
    assert_eq!(
        charged
            .iter()
            .map(|item| (item.total_cents, item.input.fee_cents, item.net_cents))
            .collect::<Vec<_>>(),
        [(1900, 59, 1841), (2000, 62, 1938)]
    );
    assert_eq!(items[0].input.fee_cents, 0); // A aplicação não modifica a entrada.
    assert_eq!(charged[0].owner_name, "Empresa fictícia");
}

#[test]
fn split_payment_fees_are_transactional_and_proportional_by_owner_then_item() {
    let items = [
        item_for(2, 2, "Produto de outra participante", 5000, 0),
        item_for(1, 3, "Biscoito A", 2000, 0),
        item_for(1, 4, "Biscoito B", 1200, 0),
    ];
    let result = calculate_split_payment_fees(
        &items
            .iter()
            .map(|item| item.total_cents)
            .collect::<Vec<_>>(),
        &items.iter().map(|item| item.owner_id).collect::<Vec<_>>(),
        &[
            payment(PaymentMethod::Cash, 5000, None),
            payment(PaymentMethod::Credit, 3200, None),
        ],
    )
    .unwrap();
    assert_eq!(result.fees, [60, 24, 15]);
    assert_eq!(
        result
            .payments
            .iter()
            .map(|payment| payment.fee_cents)
            .collect::<Vec<_>>(),
        [0, 99]
    );
    assert_eq!(
        result
            .payments
            .iter()
            .map(|payment| payment.net_cents)
            .collect::<Vec<_>>(),
        [5000, 3101]
    );

    let mut paid = sale(PaymentMethod::Cash, SaleStatus::Paid);
    paid.items = items
        .into_iter()
        .zip(result.fees)
        .map(|(mut item, fee)| {
            item.input.fee_cents = fee;
            item.net_cents = item.total_cents - fee;
            item
        })
        .collect();
    paid.payment_method = PaymentMethod::Cash;
    paid.payments = Some(result.payments);
    paid.total_cents = 8200;
    paid.discount_cents = 0;
    paid.fee_cents = 99;
    paid.net_cents = 8101;
    let summary = summarize(
        &[paid],
        &[
            Owner {
                id: 1,
                name: "Con Affetto".into(),
            },
            Owner {
                id: 2,
                name: "Outra participante".into(),
            },
        ],
        None,
    )
    .unwrap();
    assert_eq!(
        (
            summary.paid_count,
            summary.received_cents,
            summary.fee_cents,
            summary.net_cents
        ),
        (1, 8200, 99, 8101)
    );
    assert_eq!(
        summary
            .by_payment
            .iter()
            .map(|payment| payment.total_cents)
            .collect::<Vec<_>>(),
        [5000, 0, 0, 3200]
    );
    assert_eq!(
        summary
            .by_owner
            .iter()
            .map(|owner| (owner.received_cents, owner.fee_cents, owner.net_cents))
            .collect::<Vec<_>>(),
        [(3200, 39, 3161), (5000, 60, 4940)]
    );
}

#[test]
fn split_payment_supports_discounts_zero_items_and_largest_remainder_ties() {
    // Valores recebidos já refletem o desconto. Os itens de mesmo participante
    // e os participantes com valores iguais resolvem empates pela ordem original.
    let result = calculate_split_payment_fees(
        &[200, 300, 500, 0],
        &[7, 7, 8, 9],
        &[
            payment(PaymentMethod::Cash, 500, None),
            payment(PaymentMethod::Credit, 500, Some(CardEntry::Contactless)),
        ],
    )
    .unwrap();
    assert_eq!(result.fees, [3, 5, 7, 0]);

    let discounted_items = [
        item_for(1, 1, "Produto com desconto", 2000, 100),
        item_for(2, 2, "Produto sem desconto", 2000, 0),
    ];
    assert_eq!(
        discounted_items
            .iter()
            .map(|item| item.total_cents)
            .collect::<Vec<_>>(),
        [1900, 2000]
    );
    let discounted = calculate_split_payment_fees(
        &discounted_items
            .iter()
            .map(|item| item.total_cents)
            .collect::<Vec<_>>(),
        &discounted_items
            .iter()
            .map(|item| item.owner_id)
            .collect::<Vec<_>>(),
        &[
            payment(PaymentMethod::Cash, 1900, None),
            payment(PaymentMethod::Debit, 2000, Some(CardEntry::Inserted)),
        ],
    )
    .unwrap();
    assert_eq!(discounted.fees, [19, 21]);
    assert_eq!(
        discounted
            .payments
            .iter()
            .map(|payment| payment.fee_cents)
            .collect::<Vec<_>>(),
        [0, 40]
    );

    let half_cent = calculate_split_payment_fees(
        &[50, 50],
        &[1, 2],
        &[
            payment(PaymentMethod::Cash, 50, None),
            payment(PaymentMethod::Credit, 50, None),
        ],
    )
    .unwrap();
    assert_eq!(
        half_cent
            .payments
            .iter()
            .map(|payment| payment.fee_cents)
            .collect::<Vec<_>>(),
        [0, 2]
    );

    let two_cards = calculate_split_payment_fees(
        &[5000, 5000],
        &[1, 2],
        &[
            payment(PaymentMethod::Debit, 5000, Some(CardEntry::Contactless)),
            payment(PaymentMethod::Debit, 5000, Some(CardEntry::Inserted)),
        ],
    )
    .unwrap();
    assert_eq!(
        two_cards
            .payments
            .iter()
            .map(|payment| payment.fee_cents)
            .collect::<Vec<_>>(),
        [45, 100]
    );
    assert_eq!(two_cards.fees, [73, 72]);
}

#[test]
fn split_payment_rejects_invalid_parts_totals_and_owner_inputs() {
    let valid = [
        payment(PaymentMethod::Cash, 1000, None),
        payment(PaymentMethod::Credit, 1000, None),
    ];
    for (amounts, owners, payments) in [
        (vec![1000, 1000], vec![1], valid.to_vec()),
        (vec![1000, 1000], vec![0, 1], valid.to_vec()),
        (vec![MAX_SAFE_INTEGER + 1, 0], vec![1, 1], valid.to_vec()),
        (
            vec![1000, 1000],
            vec![MAX_SAFE_INTEGER + 1, 1],
            valid.to_vec(),
        ),
        (vec![-1, 2001], vec![1, 1], valid.to_vec()),
        (vec![1000, 1000], vec![1, 1], vec![valid[0].clone()]),
        (
            vec![1000, 1000],
            vec![1, 1],
            vec![valid[0].clone(), valid[0].clone()],
        ),
        (
            vec![1000, 1000],
            vec![1, 1],
            vec![payment(PaymentMethod::Barter, 1000, None), valid[1].clone()],
        ),
        (
            vec![1000, 1000],
            vec![1, 1],
            vec![payment(PaymentMethod::Cash, 0, None), valid[1].clone()],
        ),
        (
            vec![1000, 1000],
            vec![1, 1],
            vec![
                payment(PaymentMethod::Cash, MAX_SAFE_INTEGER + 1, None),
                valid[1].clone(),
            ],
        ),
        (
            vec![1000, 1000],
            vec![1, 1],
            vec![
                payment(PaymentMethod::Cash, 1000, Some(CardEntry::Inserted)),
                valid[1].clone(),
            ],
        ),
        (
            vec![1000, 1000],
            vec![1, 1],
            vec![valid[0].clone(), payment(PaymentMethod::Credit, 999, None)],
        ),
        (
            vec![MAX_SAFE_INTEGER, 1],
            vec![1, 1],
            vec![
                payment(PaymentMethod::Cash, MAX_SAFE_INTEGER, None),
                payment(PaymentMethod::Credit, 1, None),
            ],
        ),
    ] {
        assert_eq!(
            calculate_split_payment_fees(&amounts, &owners, &payments)
                .unwrap_err()
                .status,
            400,
            "amounts={amounts:?}, owners={owners:?}, payments={payments:?}"
        );
    }
}

#[test]
fn inactive_and_stale_catalog_are_conflicts() {
    let mut inactive = product();
    inactive.active = false;
    assert_eq!(
        calculate_item(&inactive, &input(), PaymentMethod::Cash)
            .unwrap_err()
            .status,
        409
    );
    let mut changed = input();
    changed.expected_price_cents = 1999;
    assert!(calculate_item(&product(), &changed, PaymentMethod::Cash)
        .unwrap_err()
        .message
        .contains("preço"));
    for changed in [
        SaleItemInput {
            expected_name: Some("Outro nome".into()),
            ..input()
        },
        SaleItemInput {
            expected_owner_id: Some(2),
            ..input()
        },
        SaleItemInput {
            expected_owner_name: Some("Outro participante".into()),
            ..input()
        },
    ] {
        assert_eq!(
            calculate_item(&product(), &changed, PaymentMethod::Pix)
                .unwrap_err()
                .status,
            409
        );
    }
}

#[test]
fn invalid_adjustments_and_quantities_are_rejected() {
    for changed in [
        SaleItemInput {
            discount_cents: 2001,
            ..input()
        },
        SaleItemInput {
            discount_cents: 100,
            fee_cents: 1901,
            ..input()
        },
        SaleItemInput {
            quantity: 0,
            ..input()
        },
        SaleItemInput {
            quantity: 10_001,
            ..input()
        },
        SaleItemInput {
            fee_cents: -1,
            ..input()
        },
    ] {
        assert_eq!(
            calculate_item(&product(), &changed, PaymentMethod::Cash)
                .unwrap_err()
                .status,
            400
        );
    }
    let discounted = SaleItemInput {
        discount_cents: 1,
        ..input()
    };
    assert!(calculate_item(&product(), &discounted, PaymentMethod::Barter).is_err());
}

#[test]
fn barter_and_gift_keep_units_but_no_money() {
    let mut barter = sale(PaymentMethod::Barter, SaleStatus::Paid);
    barter.items[0].input.quantity = 3;
    let gift = sale(PaymentMethod::Gift, SaleStatus::Paid);
    let summary = summarize(&[barter, gift], &[], None).unwrap();
    assert_eq!(
        (summary.paid_count, summary.barter_units, summary.gift_units),
        (2, 3, 1)
    );
    assert_eq!(
        (summary.received_cents, summary.fee_cents, summary.net_cents),
        (0, 0, 0)
    );
    assert!(summary.by_owner.is_empty());
}

#[test]
fn pending_uses_order_date_and_received_uses_payment_date() {
    let sales = [
        sale(PaymentMethod::Cash, SaleStatus::Paid),
        sale(PaymentMethod::Credit, SaleStatus::Pending),
        sale(PaymentMethod::Pix, SaleStatus::Cancelled),
    ];
    let order_day = summarize(&sales, &[], Some("2026-10-10")).unwrap();
    assert_eq!(
        (
            order_day.pending_cents,
            order_day.received_cents,
            order_day.paid_count
        ),
        (2000, 0, 0)
    );
    let payment_day = summarize(&sales, &[], Some("2026-10-11")).unwrap();
    assert_eq!(
        (
            payment_day.pending_cents,
            payment_day.received_cents,
            payment_day.paid_count
        ),
        (0, 2000, 1)
    );
    let all = summarize(&sales, &[], None).unwrap();
    assert_eq!(
        (all.pending_cents, all.received_cents, all.paid_count),
        (2000, 2000, 1)
    );
}

#[test]
fn summary_uses_stored_fees_and_preserves_owner_order_and_names() {
    let mut paid = sale(PaymentMethod::Debit, SaleStatus::Paid);
    paid.fee_cents = 123;
    paid.net_cents = 1877;
    paid.items[0].input.fee_cents = 123;
    paid.items[0].net_cents = 1877;
    let owners = [
        Owner {
            id: 2,
            name: "Sem vendas".into(),
        },
        Owner {
            id: 1,
            name: "Nome atual".into(),
        },
    ];
    let summary = summarize(&[paid.clone()], &owners, None).unwrap();
    assert_eq!(
        (summary.received_cents, summary.fee_cents, summary.net_cents),
        (2000, 123, 1877)
    );
    assert_eq!(
        summary
            .by_owner
            .iter()
            .map(|owner| (owner.owner_id, owner.name.as_str(), owner.net_cents))
            .collect::<Vec<_>>(),
        [(2, "Sem vendas", 0), (1, "Nome atual", 1877)]
    );
    let historical_owner = summarize(&[paid], &owners[..1], None).unwrap();
    assert_eq!(historical_owner.by_owner[1].name, "Empresa fictícia");
}

#[test]
fn summaries_never_silently_overflow_the_angular_contract() {
    let mut pending = sale(PaymentMethod::Cash, SaleStatus::Pending);
    pending.total_cents = MAX_SAFE_INTEGER;
    let one_more = FinancialSale {
        total_cents: 1,
        ..pending.clone()
    };
    assert!(summarize(&[pending, one_more], &[], None).is_err());
}
