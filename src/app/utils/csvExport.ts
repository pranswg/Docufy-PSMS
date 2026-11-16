// One CSV writer for the whole app. Every tabular download the shop takes —
// audit trail, inventory, sales, orders, payments — shares this so the files
// open identically in Excel no matter which page produced them: a UTF-8 BOM so
// ₱ and dashes render instead of mojibake, CRLF line endings, and every cell
// quoted so an embedded comma, newline or quote stays inside its own cell.

import { todayPHTKey } from "./pht";
import { saveBlob } from "./documentExport";

export type CsvValue = string | number | boolean | null | undefined;

export function toCsvCell(value: CsvValue): string {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

// The BOM is U+FEFF, written as an escape so it is visible in the source: it is
// what makes Excel read the file as UTF-8 rather than a legacy codepage, which
// is why ₱ and the em dashes arrive intact.
const CSV_BOM = "\uFEFF";

export function buildCsv(header: CsvValue[], rows: CsvValue[][]): string {
  const lines = rows.map((row) => row.map(toCsvCell).join(","));
  return CSV_BOM + [header.map(toCsvCell).join(","), ...lines].join("\r\n");
}

/**
 * `docufy-<stem>-<YYYY-MM-DD>.csv`, the date being the Philippine business day
 * the file was produced on, so a folder full of exports sorts correctly.
 */
export function csvFileName(stem: string, suffix?: string): string {
  const parts = ["docufy", stem.replace(/^docufy-/, "")];
  if (suffix) parts.push(suffix.replace(/^docufy-/, ""));
  return `${parts.join("-")}-${todayPHTKey()}.csv`;
}

export function downloadCsv(options: {
  stem: string;
  suffix?: string;
  header: CsvValue[];
  rows: CsvValue[][];
  filename?: string;
}) {
  const csv = buildCsv(options.header, options.rows);
  saveBlob(
    new Blob([csv], { type: "text/csv;charset=utf-8;" }),
    options.filename ?? csvFileName(options.stem, options.suffix),
  );
}
