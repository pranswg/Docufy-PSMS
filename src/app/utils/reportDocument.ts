// The report document model behind every "Export" action (Inventory Reports,
// Dashboard sales, Orders, Payment Verification).
//
// A page builds a ReportSpec from the arrays it ALREADY renders and hands it to
// the shared dialog, which offers the same two files for every report: a CSV
// for spreadsheets and a printable PDF document. Because both come out of one
// spec, the CSV and the PDF can never disagree with each other or with the
// screen — the page formats each value once (money through formatCurrency,
// dates through the PHT helpers), so what the operator read is what the file
// holds. Nothing here computes a figure; it only lays out what it is given.

import { todayPHTKey, nowPHT, formatPHDateTime } from "./pht";
import { CsvValue, toCsvCell } from "./csvExport";
import {
  A4_LANDSCAPE_SHEET_WIDTH,
  A4_PORTRAIT_SHEET_WIDTH,
  downloadHtmlPdf,
  logoToDataUrl,
  saveBlob,
  type PdfOrientation,
} from "./documentExport";

const CSV_BOM = "\uFEFF";

export interface ReportSummaryBlock {
  kind: "summary";
  title?: string;
  items: { label: string; value: string }[];
}

export interface ReportTableBlock {
  kind: "table";
  title: string;
  subtitle?: string;
  columns: string[];
  rows: CsvValue[][];
  /** Per-column alignment; defaults to left, "right" for money and counts. */
  align?: ("left" | "right" | "center")[];
  /** Printed under the table when there are no rows. */
  emptyMessage?: string;
  /** Counts this table's own rows in its Total line; falls back to the report's. */
  unitLabel?: string;
}

export type ReportBlock = ReportSummaryBlock | ReportTableBlock;

export interface ReportSpec {
  /** Document title, e.g. "Inventory — Current Stock". */
  title: string;
  /** One line under the title: what the numbers cover. */
  subtitle?: string;
  /** The filters the screen was narrowed by, shown so the file explains itself. */
  filters?: { label: string; value: string }[];
  blocks: ReportBlock[];
  /** Filename stem, e.g. "inventory-current-stock". */
  fileStem: string;
  /** Singular noun for the row count, e.g. "item" → "24 items". */
  unitLabel: string;
  /** Rows in the export — the FULL array, not the page's capped view. */
  rowCount: number;
  /** Shown in the footer; usually the signed-in operator's name. */
  preparedBy?: string;
}

export function reportFileName(spec: ReportSpec, extension: "csv" | "pdf") {
  return `docufy-${spec.fileStem}-${todayPHTKey()}.${extension}`;
}

/** `7 item` → `7 items`; a label already ending in "s" is left alone. */
function countLabel(count: number, label: string): string {
  return `${count} ${label}${label.endsWith("s") ? "" : "s"}`;
}

function csvRow(values: CsvValue[]): string {
  return values.map(toCsvCell).join(",");
}

/**
 * The CSV form. Each block is written as its own titled section with a blank
 * line between them, so a multi-section report still reads cleanly in a
 * spreadsheet even though the sections have different column sets.
 */
export function reportCsvText(spec: ReportSpec): string {
  const sections: string[] = [];
  const head = [`Docufy PSMS — ${spec.title}`];
  if (spec.subtitle) head.push(spec.subtitle);
  if (spec.filters?.length) {
    head.push(
      csvRow(["Filter", "Value"]),
      ...spec.filters.map((f) => csvRow([f.label, f.value])),
    );
  }
  head.push(csvRow(["Generated (PHT)", formatPHDateTime(nowPHT())]));
  sections.push(head.join("\r\n"));

  for (const block of spec.blocks) {
    if (block.kind === "summary") {
      const lines = [block.title ?? "Summary", csvRow(["Measure", "Value"])];
      block.items.forEach((item) => lines.push(csvRow([item.label, item.value])));
      sections.push(lines.join("\r\n"));
      continue;
    }
    const lines = [block.title, csvRow(block.columns)];
    if (block.rows.length === 0) {
      lines.push(csvRow([block.emptyMessage ?? "No records in this selection."]));
    } else {
      block.rows.forEach((row) => lines.push(csvRow(row)));
      lines.push(csvRow(["Total", countLabel(block.rows.length, block.unitLabel ?? spec.unitLabel)]));
    }
    sections.push(lines.join("\r\n"));
  }

  return CSV_BOM + sections.join("\r\n\r\n\r\n");
}

export function downloadReportCsv(spec: ReportSpec) {
  saveBlob(
    new Blob([reportCsvText(spec)], { type: "text/csv;charset=utf-8;" }),
    reportFileName(spec, "csv"),
  );
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function blockHtml(block: ReportBlock, spec: ReportSpec): string {
  if (block.kind === "summary") {
    return `
  <section>
    ${block.title ? `<h2>${esc(block.title)}</h2>` : ""}
    <div class="tiles">
      ${block.items
        .map(
          (item) =>
            `<div class="tile"><div class="tl">${esc(item.label)}</div><div class="tv">${esc(item.value)}</div></div>`,
        )
        .join("\n      ")}
    </div>
  </section>`;
  }

  const widths = block.align ?? [];
  const headRow = block.columns
    .map(
      (column, index) =>
        `<th class="a-${widths[index] ?? "left"}">${esc(column)}</th>`,
    )
    .join("");

  const bodyRows =
    block.rows.length > 0
      ? block.rows
          .map(
            (row) =>
              `<tr>${row
                .map(
                  (cell, index) =>
                    `<td class="a-${widths[index] ?? "left"}">${esc(cell)}</td>`,
                )
                .join("")}</tr>`,
          )
          .join("\n      ")
      : `<tr><td class="empty" colspan="${block.columns.length}">${esc(
          block.emptyMessage ?? "No records in this selection.",
        )}</td></tr>`;

  const totalRow =
    block.rows.length > 0
      ? `<tr class="total"><td colspan="${block.columns.length}">Total: ${esc(
          countLabel(block.rows.length, block.unitLabel ?? spec.unitLabel),
        )}</td></tr>`
      : "";

  return `
  <section>
    <h2>${esc(block.title)}</h2>
    ${block.subtitle ? `<p class="sub">${esc(block.subtitle)}</p>` : ""}
    <table>
      <thead><tr>${headRow}</tr></thead>
      <tbody>${bodyRows}${totalRow}</tbody>
    </table>
  </section>`;
}

/**
 * A standalone, self-contained report document. Arial on purpose: the export is
 * rasterized in an off-screen frame, and a web font would not be available
 * there (the same reason the receipt uses Arial). Every resource is inline, so
 * nothing is fetched and the canvas is never tainted.
 *
 * The document lays out at the sheet width for the chosen page orientation —
 * landscape (1123px) keeps a wide table's columns on one page, portrait (794px)
 * is the upright printed page, where a many-column table wraps to a second page.
 */
export function buildReportHtml(
  spec: ReportSpec,
  logoDataUrl?: string,
  orientation: PdfOrientation = "landscape",
): string {
  const sheetWidth =
    orientation === "landscape" ? A4_LANDSCAPE_SHEET_WIDTH : A4_PORTRAIT_SHEET_WIDTH;
  const generated = formatPHDateTime(nowPHT());
  const filterLine =
    spec.filters && spec.filters.length > 0
      ? `<div class="filters">${spec.filters
          .map(
            (filter) =>
              `<span><b>${esc(filter.label)}:</b> ${esc(filter.value)}</span>`,
          )
          .join("")}</div>`
      : "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(spec.title)}</title>
<style>
  @page { size: A4 ${orientation}; margin: 14mm; }
  * { box-sizing: border-box; }
  /* A document is always light, even when the exporting browser is in dark mode. */
  html { color-scheme: only light; background: #e9edf3; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1c1f26; background: #fff;
         margin: 0 auto; padding: 26px 28px; max-width: ${sheetWidth}px;
         font-size: 12px; }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
         border-bottom: 3px solid #2F6FD6; padding-bottom: 12px; }
  .brand { display: flex; gap: 11px; align-items: center; }
  .brand img { width: 42px; height: 42px; object-fit: contain; }
  .word { font-size: 21px; font-weight: 800; color: #2F6FD6; letter-spacing: -0.5px; line-height: 1; }
  .tag { font-size: 10.5px; color: #4b5563; margin-top: 3px; }
  .doc { text-align: right; }
  .doc h1 { margin: 0; font-size: 17px; color: #1c1f26; }
  .doc p { margin: 3px 0 0; font-size: 11px; color: #4b5563; }
  .filters { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 12px; font-size: 11px; color: #4b5563; }
  .filters b { color: #1c1f26; }
  h2 { font-size: 12.5px; margin: 20px 0 2px; color: #1c1f26; }
  .sub { margin: 0 0 7px; font-size: 10.5px; color: #6b7280; }
  .tiles { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
  .tile { border: 1px solid #dbe2ea; border-radius: 8px; padding: 8px 12px; min-width: 150px; background: #f8fbff; }
  .tl { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.4px; }
  .tv { font-size: 15px; font-weight: 700; color: #1c1f26; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; table-layout: fixed; }
  /* Portrait has less horizontal room per column, so the cells are packed
     tighter — that is the difference between "Document" fitting on one line and
     breaking as "Docume nt" all the way down the page. */
  th, td { border-bottom: 1px solid #e5e7eb; padding: 5px ${orientation === "landscape" ? "8px" : "4px"};
           font-size: 11px;
           text-align: left; vertical-align: top; word-break: break-word; }
  th { background: #eef4ff; color: #1f4e9c; font-weight: 700; border-bottom: 1px solid #c9d9f2; }
  tr:nth-child(even) td { background: #fbfcfe; }
  .a-right { text-align: right; }
  .a-center { text-align: center; }
  .empty { text-align: center; color: #6b7280; padding: 14px 8px; }
  .total td { background: #f4f8fe; font-weight: 700; color: #1f4e9c; border-top: 1px solid #c9d9f2; }
  .foot { margin-top: 22px; padding-top: 10px; border-top: 1px solid #e5e7eb;
          display: flex; justify-content: space-between; gap: 16px; font-size: 10px; color: #6b7280; }
  /* Only matters if the HTML itself is printed; the PDF export rasterizes instead. */
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
</style>
</head>
<body>
  <div class="hdr">
    <div class="brand">
      ${logoDataUrl ? `<img src="${esc(logoDataUrl)}" alt="">` : ""}
      <div>
        <div class="word">Docufy</div>
        <div class="tag">Print Shop Management System</div>
      </div>
    </div>
    <div class="doc">
      <h1>${esc(spec.title)}</h1>
      ${spec.subtitle ? `<p>${esc(spec.subtitle)}</p>` : ""}
      <p>Generated ${esc(generated)} (PHT)</p>
    </div>
  </div>
  ${filterLine}
  ${spec.blocks.map((block) => blockHtml(block, spec)).join("\n")}
  <div class="foot">
    <div>
      <div>Docufy PSMS — ${esc(spec.title)}</div>
      <div>Generated ${esc(generated)} (Philippine time)${
        spec.preparedBy ? ` · Prepared by ${esc(spec.preparedBy)}` : ""
      }</div>
    </div>
    <div>${esc(countLabel(spec.rowCount, spec.unitLabel))} in this report</div>
  </div>
</body>
</html>`;
}

export async function downloadReportPdf(
  spec: ReportSpec,
  logoSrc: string,
  orientation: PdfOrientation = "landscape",
) {
  const logoDataUrl = await logoToDataUrl(logoSrc);
  await downloadHtmlPdf({
    html: buildReportHtml(spec, logoDataUrl, orientation),
    filename: reportFileName(spec, "pdf"),
    orientation,
    sheetWidthPx:
      orientation === "landscape" ? A4_LANDSCAPE_SHEET_WIDTH : A4_PORTRAIT_SHEET_WIDTH,
  });
}
