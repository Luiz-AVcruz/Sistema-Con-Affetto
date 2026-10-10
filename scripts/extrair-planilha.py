#!/usr/bin/env python3
"""Lê um snapshot ODS. Não abre, recalcula, salva ou altera a planilha."""
import argparse
from decimal import Decimal, ROUND_HALF_UP
import hashlib
from io import BytesIO
import json
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

NS = {"table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0", "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0", "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0"}

def attribute(element, group, name, default=None):
    return element.get(f"{{{NS[group]}}}{name}", default)

def read_indexed_rows(table):
    rows = []
    physical_row = 1
    for row in table.iter(f"{{{NS['table']}}}table-row"):
        cells = []
        for cell in row:
            text = " ".join("".join(paragraph.itertext()) for paragraph in cell.findall('text:p', NS))
            value = attribute(cell, "office", "value", attribute(cell, "office", "date-value", text))
            cells.extend([value] * min(int(attribute(cell, "table", "number-columns-repeated", "1")), 25-len(cells)))
            if len(cells) == 25: break
        cells += [''] * (25-len(cells))
        repeat = int(attribute(row, "table", "number-rows-repeated", "1"))
        if any(cells):
            if len(rows) + repeat > 10000: raise ValueError("Mais de 10.000 linhas preenchidas; revise o extrator antes de importar.")
            rows.extend((physical_row + offset, cells) for offset in range(repeat))
        physical_row += repeat
    return rows

def read_rows(table):
    return [cells for _, cells in read_indexed_rows(table)]

def cents(value):
    return int((Decimal(value or '0') * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))

def integer(value):
    number = Decimal(value)
    if number != number.to_integral_value(): raise ValueError(f'Quantidade fracionária: {value}')
    return int(number)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=Path('data'))
    args = parser.parse_args()
    content = args.source.read_bytes()
    with ZipFile(BytesIO(content)) as archive:
        root = ET.fromstring(archive.read('content.xml'))
    indexed_tables = {attribute(table, 'table', 'name'): read_indexed_rows(table) for table in root.findall('.//table:table', NS)}
    tables = {name: [cells for _, cells in rows] for name, rows in indexed_tables.items()}
    products = []
    for row in tables['Produtos']:
        if not row[2] or row[2] == 'Participante': continue
        price = cents(row[3])
        initial = None if row[4] in ('', 'A contar') else integer(row[4])
        cached = None if row[6] in ('', 'A contar') else integer(row[6])
        products.append({'name': row[0], 'description': row[1], 'ownerName': row[2], 'priceCents': price,
                         'initialStock': initial, 'stock': cached, 'active': True})
    catalog = {product['name']: product for product in products}
    if len(catalog) != len(products): raise ValueError('Nomes de produtos duplicados. Importação requer revisão.')
    sales = []
    historical_rows = []
    consumed = {name: 0 for name in catalog}
    found_header = False
    for row_number, row in indexed_tables['Vendas']:
        if not found_header:
            found_header = row[0] == 'Produto' and row[1] == 'Qtd.'
            continue
        if not row[0]: continue
        if row[0] not in catalog: raise ValueError(f'Vendas, linha {row_number}: produto não encontrado: {row[0]}')
        quantity = integer(row[1])
        if quantity <= 0: raise ValueError('Quantidade inválida na planilha')
        if row[4] not in ('OK', 'Pendente', 'Cancelado', 'Permuta', 'Não cobrado'): raise ValueError(f'Linha não conferida: {row[0]}')
        status = 'Cancelado' if row[4] == 'Cancelado' else ('Pendente' if row[4] == 'Pendente' else 'Pago')
        if not row[9] or row[8] == '': raise ValueError(f'Vendas, linha {row_number}: preço/participante não salvo.')
        sale = {'date': row[6], 'paymentMethod': row[2], 'status': status, 'note': row[13],
                'items': [{'name': row[0], 'quantity': quantity, 'discountCents': cents(row[10]), 'feeCents': cents(row[11])}]}
        sales.append(sale)
        historical_rows.append({'rowNumber': row_number, 'orderRef': str(row[7]), 'date': row[6],
                                'paymentMethod': row[2], 'status': status, 'note': row[13],
                                'name': row[0], 'ownerName': row[9], 'quantity': quantity,
                                'priceCents': cents(row[8]), 'discountCents': cents(row[10]), 'feeCents': cents(row[11]),
                                'totalCents': cents(row[3]), 'netCents': cents(row[12])})
        if status == 'Pago': consumed[row[0]] += quantity
    if not found_header: raise ValueError('Cabeçalho da aba Vendas não encontrado.')
    for product in products:
        expected = None if product['initialStock'] is None else product['initialStock'] - consumed[product['name']]
        if expected != product['stock']: raise ValueError(f"Estoque salvo divergente: {product['name']}. Recalcule/salve no Calc e extraia novamente.")
        if expected is not None and expected < 0: raise ValueError(f"Estoque negativo: {product['name']}")
    total_rows = {row[0]: row for row in tables['Total da feira']}
    owner_names = sorted({product['ownerName'] for product in products} | {row['ownerName'] for row in historical_rows})
    expected = {'netCents': cents(total_rows['Total da feira'][3]),
                'byOwner': {name: cents(total_rows[name][3]) for name in owner_names},
                'byPayment': {method: cents(total_rows[method][3]) for method in ('Dinheiro', 'Pix', 'Cartão débito', 'Cartão crédito')},
                'discountCents': cents(total_rows['Descontos'][3]), 'feeCents': cents(total_rows['Taxas'][3]),
                'pendingCents': cents(total_rows['Aguardando pagamento'][3]),
                'barterUnits': integer(total_rows['Permuta (unidades)'][3]), 'giftUnits': integer(total_rows['Não cobrado (unidades)'][3])}
    expected['receivedCents'] = expected['netCents'] + expected['feeCents']
    closed_days = []
    found_header = False
    for row_number, row in indexed_tables['Histórico']:
        if not found_header:
            if row[0] == 'Dia' and row[4] == 'Total líquido':
                found_header = True
                closing_owners = row[1:4]
            continue
        if not row[0]: continue
        if row[5] not in ('Fechado', 'Fechado sem contagem') or row[23] != 'OK':
            raise ValueError(f'Histórico, linha {row_number}: fechamento não conferido.')
        counted = None if row[18] == '' else cents(row[18])
        if (row[5] == 'Fechado sem contagem') != (counted is None):
            raise ValueError(f'Histórico, linha {row_number}: situação e contagem divergentes.')
        closed_days.append({'date': row[0], 'cash': {'openingCents': cents(row[14]), 'extraCents': cents(row[15]),
                            'withdrawalCents': cents(row[16]), 'countedCents': counted, 'note': row[6]},
                            'expectedCents': None if row[17] == '' else cents(row[17]),
                            'differenceCents': None if row[19] == '' else cents(row[19]),
                            'expected': {'receivedCents': cents(row[7]), 'netCents': cents(row[4]),
                            'discountCents': cents(row[8]), 'feeCents': cents(row[9]), 'pendingCents': cents(row[20]),
                            'barterUnits': integer(row[21] or '0'), 'giftUnits': integer(row[22] or '0'),
                            'byOwner': {name: cents(row[index + 1]) for index, name in enumerate(closing_owners)},
                            'byPayment': dict(zip(('Dinheiro', 'Pix', 'Cartão débito', 'Cartão crédito'), map(cents, row[10:14])))}})
    if not found_header: raise ValueError('Cabeçalho da aba Histórico não encontrado.')
    metadata = {'source': str(args.source.resolve()), 'sha256': hashlib.sha256(content).hexdigest(),
                'lockPresent': (args.source.parent / ('.~lock.'+args.source.name+'#')).exists()}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output/'catalogo-planilha.json').write_text(json.dumps({**metadata, 'products': [{key: value for key, value in product.items() if key != 'initialStock'} for product in products]}, ensure_ascii=False, indent=2)+'\n')
    (args.output/'referencia-planilha.json').write_text(json.dumps({**metadata, 'products': products, 'sales': sales, 'expected': expected}, ensure_ascii=False, indent=2)+'\n')
    (args.output/'historico-planilha.json').write_text(json.dumps({**metadata, 'formatVersion': 1, 'sourceKey': 'caixa-da-feira-ods',
        'products': [{'name': product['name'], 'stock': product['stock']} for product in products],
        'rows': historical_rows, 'expected': expected, 'closedDays': closed_days}, ensure_ascii=False, indent=2)+'\n')
    print(f"Snapshot: {metadata['sha256']}. {len(products)} produtos; {len(sales)} linhas de venda; {len(closed_days)} fechamentos.")
    if metadata['lockPresent']: print('A planilha está aberta: dados extraídos da última versão salva. Alterações não salvas não estão incluídas.')

if __name__ == '__main__': main()
