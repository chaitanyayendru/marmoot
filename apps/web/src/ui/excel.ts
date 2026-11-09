/**
 * The bill sheet as an Excel file: items down the side, people across, each cell the
 * amount that person pays for that item (blank when they're out), then tax and tip,
 * then totals as SUM formulas so the file still adds up if someone edits it.
 * exceljs loads only when someone downloads.
 */
import type { SheetResult } from '@marmoot/core';
import type { SheetData } from '../api.ts';
import { eventText, responseStatus } from '../sheet.ts';

export async function downloadSheet(d: SheetData, totals: SheetResult): Promise<void> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Marmoot';
  const ws = wb.addWorksheet('Bill', { views: [{ state: 'frozen', xSplit: 2, ySplit: 2 }] });
  const money = '"$"#,##0.00';
  const people = d.people;
  const lastCol = 2 + people.length;

  ws.addRow([d.sheet.title, '', ...people.map((p) => responseStatus(p).label)]);
  ws.addRow(['Item', 'Price', ...people.map((p) => p.name)]);
  ws.getRow(1).font = { italic: true, color: { argb: 'FF696E69' } };
  ws.getRow(1).getCell(1).font = { bold: true, size: 14 };
  ws.getRow(2).font = { bold: true };

  const firstItemRow = 3;
  for (const it of d.items) {
    const cells = totals.cells.get(it.id);
    ws.addRow([it.name, Number(it.price_cents) / 100, ...people.map((p) => (cells?.has(p.id) ? cells.get(p.id)! / 100 : null))]);
  }
  const lastItemRow = firstItemRow + d.items.length - 1;
  ws.addRow(['Tax and tip', (Number(d.sheet.tax_cents) + Number(d.sheet.tip_cents)) / 100, ...people.map((p) => (totals.totals.get(p.id)?.extras ?? 0) / 100)]);
  const extrasRow = lastItemRow + 1;
  const col = (n: number) => ws.getColumn(n).letter;
  const totalRow = ws.addRow([
    'Total',
    ...Array.from({ length: lastCol - 1 }, (_, i) => ({
      formula: `SUM(${col(i + 2)}${firstItemRow}:${col(i + 2)}${extrasRow})`,
      result: i === 0 ? totals.total / 100 : (totals.totals.get(people[i - 1]!.id)?.total ?? 0) / 100,
    })),
  ]);
  totalRow.font = { bold: true };
  for (let c = 2; c <= lastCol; c++) ws.getColumn(c).numFmt = money;
  ws.getColumn(1).width = 28;
  for (let c = 2; c <= lastCol; c++) ws.getColumn(c).width = 13;
  for (let r = firstItemRow; r <= lastItemRow; r++) {
    for (let c = 3; c <= lastCol; c++) {
      const cell = ws.getRow(r).getCell(c);
      if (cell.value === null) cell.value = 'out';
      if (cell.value === 'out') cell.font = { color: { argb: 'FF9BA19B' } };
    }
  }

  if (d.events.length) {
    const log = wb.addWorksheet('Changes');
    log.addRow(['When', 'What']).font = { bold: true };
    for (const e of [...d.events].reverse()) {
      const text = eventText(e, d);
      // Excel has no time zones: write the local clock time the owner would expect.
      if (text) log.addRow([new Date(Date.parse(e.at) - new Date(e.at).getTimezoneOffset() * 60_000), text]);
    }
    log.getColumn(1).numFmt = 'mmm d, h:mm AM/PM';
    log.getColumn(1).width = 20;
    log.getColumn(2).width = 60;
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${d.sheet.title.replace(/[^\w\- ]+/g, '').trim() || 'bill'}.xlsx`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
