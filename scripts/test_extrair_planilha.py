"""Regressões do leitor ODS, sem tocar em uma planilha do comércio."""
import importlib.util
from pathlib import Path
import unittest
from xml.etree import ElementTree as ET

spec = importlib.util.spec_from_file_location('extractor', Path(__file__).with_name('extrair-planilha.py'))
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


class OdsReaderTest(unittest.TestCase):
    def test_physical_rows_and_covered_cells_preserve_positions(self):
        table = ET.fromstring('''<table:table xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
            xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
            <table:table-row table:number-rows-repeated="3"><table:table-cell/></table:table-row>
            <table:table-row><table:table-cell><text:p>Produto A</text:p></table:table-cell>
                <table:covered-table-cell/><table:table-cell><text:p>Participante A</text:p></table:table-cell></table:table-row>
            <table:table-row><table:table-cell/></table:table-row>
            <table:table-row table:number-rows-repeated="2"><table:table-cell><text:p>Produto B</text:p></table:table-cell></table:table-row>
        </table:table>''')
        rows = extractor.read_indexed_rows(table)
        self.assertEqual([number for number, _ in rows], [4, 6, 7])
        self.assertEqual(rows[0][1][:3], ['Produto A', '', 'Participante A'])

    def test_integral_decimal_quantity_is_accepted_but_fraction_is_rejected(self):
        self.assertEqual(extractor.integer('2.0'), 2)
        with self.assertRaisesRegex(ValueError, 'fracionária'):
            extractor.integer('2.5')


if __name__ == '__main__':
    unittest.main()
