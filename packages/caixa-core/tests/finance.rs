use caixa_core::finance::{
    apply_payment_fees, calculate_item, calculate_payment_fees, payment_rate, summarize,
};
use caixa_core::model::{
    CardEntry, FinancialSale, Owner, PaymentMethod, Product, SaleItemInput, SaleStatus,
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
        status,
        discount_cents: 0,
        fee_cents: 0,
        total_cents: item.total_cents,
        net_cents: item.net_cents,
        items: vec![item],
    }
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
