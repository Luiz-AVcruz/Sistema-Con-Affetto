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

def read_rows(table):
    rows = []
    for row in table.iter(f"{{{NS['table']}}}table-row"):
        cells = []
        for cell in row:
            text = " ".join("".join(paragraph.itertext()) for paragraph in cell.findall('text:p', NS))
            value = attribute(cell, "office", "value", attribute(cell, "office", "date-value", text))
            cells.extend([value] * min(int(attribute(cell, "table", "number-columns-repeated", "1")), 25-len(cells)))
            if len(cells) == 25: break
        cells += [''] * (25-len(cells))
        repeat = int(attribute(row, "table", "number-rows-repeated", "1"))
        if any(cells): rows.extend([cells] * min(repeat, 10000-len(rows)))
        if len(rows) >= 10000: raise ValueError("Mais de 10.000 linhas preenchidas; revise o extrator antes de importar.")
    return rows

def cents(value):
    return int((Decimal(value or '0') * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=Path('data'))
    args = parser.parse_args()
    content = args.source.read_bytes()
    with ZipFile(BytesIO(content)) as archive:
        root = ET.fromstring(archive.read('content.xml'))
    tables = {attribute(table, 'table', 'name'): read_rows(table) for table in root.findall('.//table:table', NS)}
    products = []
    for row in tables['Produtos']:
        if not row[2] or row[2] == 'Participante': continue
        price = cents(row[3])
        initial = None if row[4] in ('', 'A contar') else int(row[4])
        cached = None if row[6] in ('', 'A contar') else int(row[6])
        products.append({'name': row[0], 'description': row[1], 'ownerName': row[2], 'priceCents': price,
                         'initialStock': initial, 'stock': cached, 'active': True})
    catalog = {product['name']: product for product in products}
    if len(catalog) != len(products): raise ValueError('Nomes de produtos duplicados. Importação requer revisão.')
    sales = []
    consumed = {name: 0 for name in catalog}
    for row in tables['Vendas']:
        if row[0] not in catalog: continue
        quantity = int(row[1])
        if quantity <= 0: raise ValueError('Quantidade inválida na planilha')
        if row[4] not in ('OK', 'Pendente', 'Cancelado', 'Permuta', 'Não cobrado'): raise ValueError(f'Linha não conferida: {row[0]}')
        status = 'Cancelado' if row[4] == 'Cancelado' else ('Pendente' if row[4] == 'Pendente' else 'Pago')
        sale = {'date': row[6], 'paymentMethod': row[2], 'status': status, 'note': row[7],
                'items': [{'name': row[0], 'quantity': quantity, 'discountCents': cents(row[10]), 'feeCents': cents(row[11])}]}
        sales.append(sale)
        if status == 'Pago': consumed[row[0]] += quantity
    for product in products:
        expected = None if product['initialStock'] is None else product['initialStock'] - consumed[product['name']]
        if expected != product['stock']: raise ValueError(f"Estoque salvo divergente: {product['name']}. Recalcule/salve no Calc e extraia novamente.")
        if expected is not None and expected < 0: raise ValueError(f"Estoque negativo: {product['name']}")
    total_rows = {row[0]: row for row in tables['Total da feira']}
    expected = {'netCents': cents(total_rows['Total da feira'][3]),
                'byOwner': {name: cents(total_rows[name][3]) for name in sorted({product['ownerName'] for product in products})},
                'byPayment': {method: cents(total_rows[method][3]) for method in ('Dinheiro', 'Pix', 'Cartão débito', 'Cartão crédito')},
                'discountCents': cents(total_rows['Descontos'][3]), 'feeCents': cents(total_rows['Taxas'][3]),
                'pendingCents': cents(total_rows['Aguardando pagamento'][3]),
                'barterUnits': int(total_rows['Permuta (unidades)'][3]), 'giftUnits': int(total_rows['Não cobrado (unidades)'][3])}
    metadata = {'source': str(args.source.resolve()), 'sha256': hashlib.sha256(content).hexdigest(),
                'lockPresent': (args.source.parent / ('.~lock.'+args.source.name+'#')).exists()}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output/'catalogo-planilha.json').write_text(json.dumps({**metadata, 'products': [{key: value for key, value in product.items() if key != 'initialStock'} for product in products]}, ensure_ascii=False, indent=2)+'\n')
    (args.output/'referencia-planilha.json').write_text(json.dumps({**metadata, 'products': products, 'sales': sales, 'expected': expected}, ensure_ascii=False, indent=2)+'\n')
    print(f"Snapshot: {metadata['sha256']}. {len(products)} produtos; {len(sales)} linhas de venda para conferência.")
    if metadata['lockPresent']: print('A planilha está aberta: dados extraídos da última versão salva. Alterações não salvas não estão incluídas.')

if __name__ == '__main__': main()
