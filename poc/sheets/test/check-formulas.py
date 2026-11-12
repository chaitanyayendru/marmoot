"""Recalculate a Marmoot bill sheet's formulas in LibreOffice and compare with Logic.gs.

    node --experimental-strip-types poc/sheets/test/formulas.ts /tmp/bill.json
    python3 poc/sheets/test/check-formulas.py /tmp/bill.json

The sheet shows exact fractions (each pays price / people in); Marmoot sends whole
cents to Splitwise. They must agree to within a cent per person, and the sheet's
member totals must add up to the bill.
"""
import json, os, subprocess, sys, tempfile
from openpyxl import Workbook, load_workbook
from openpyxl.utils import get_column_letter

data = json.load(open(sys.argv[1]))
bill = next(s for s in data['sheet']['sheets'] if s['name'] == 'Bill')
wb = Workbook()
ws = wb.active
ws.title = 'Bill'
for c in bill['cells']:
    ref = f"{get_column_letter(c['c'])}{c['r']}"
    ws[ref] = c['f'] if c.get('f') else c['v']
tmp = tempfile.mkdtemp()
src = os.path.join(tmp, 'bill.xlsx')
wb.save(src)
out = os.path.join(tmp, 'out')
subprocess.run(['soffice', '--headless', '--calc', '--convert-to', 'xlsx', '--outdir', out, src], check=True, capture_output=True)
calc = load_workbook(os.path.join(out, 'bill.xlsx'), data_only=True)['Bill']

header_row = 3
names = []
col = 3
while calc.cell(header_row, col).value not in (None, 'People in'):
    names.append(calc.cell(header_row, col).value)
    col += 1
total_row = next(r for r in range(1, 200) if calc.cell(r, 1).value == 'Total')
sheet_totals = [calc.cell(total_row, 3 + j).value for j in range(len(names))]
bill_total = calc.cell(total_row, 2).value

ok = True
for name, got, want in zip(names, sheet_totals, data['expected']):
    diff = abs(round(got * 100) - want['total'])
    print(f"{name:10s} sheet {got:9.4f}  Marmoot {want['total'] / 100:8.2f}  diff {diff}c")
    ok &= diff <= 1
print(f"bill total: sheet {bill_total:.2f}, Marmoot {data['total'] / 100:.2f}; sheet members add to {sum(sheet_totals):.4f}")
ok &= abs(bill_total * 100 - data['total']) < 0.5 and abs(sum(sheet_totals) * 100 - data['total']) < 0.01
print('OK' if ok else 'MISMATCH')
sys.exit(0 if ok else 1)
