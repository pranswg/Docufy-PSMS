// The one export chooser behind every "Export" action in the app.
//
// A page hands it a ReportSpec (see utils/reportDocument) built from the arrays
// it already renders; this window names the report, repeats the filters the
// screen was narrowed by so the file explains itself, and offers the same two
// downloads everywhere: a CSV for spreadsheets and a printable A4 PDF. Both are
// produced from that one spec on the spot, in the browser, so the CSV and the
// PDF can never disagree with each other or with what is on screen.
//
// The PDF is rasterized, which takes a moment, so the button that was pressed
// shows the spinner and both downloads lock while either is working — the same
// contract the order receipt uses. A report with no rows explains itself instead
// of handing out an empty file or a dead button.
//
// "Download PDF" does not download straight away: it opens a page-orientation
// window first, because a report with many columns reads differently on a wide
// sheet than on an upright one, and that is the operator's call, not the app's.
// Cancel there returns to this window with nothing downloaded.

import React, { useState } from "react";
import {
  Check,
  FileSpreadsheet,
  FileText,
  Download,
  RectangleHorizontal,
  RectangleVertical,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { useLogo } from "../../hooks/useLogo";
import type { PdfOrientation } from "../../utils/documentExport";
import {
  downloadReportCsv,
  downloadReportPdf,
  type ReportSpec,
} from "../../utils/reportDocument";

const ORIENTATION_OPTIONS: {
  value: PdfOrientation;
  label: string;
  description: string;
  icon: typeof RectangleHorizontal;
}[] = [
  {
    value: "landscape",
    label: "Landscape",
    description: "Wide pages. Tables with many columns stay on one page.",
    icon: RectangleHorizontal,
  },
  {
    value: "portrait",
    label: "Portrait",
    description: "Upright pages, the usual printed sheet. Wide tables split.",
    icon: RectangleVertical,
  },
];

/** The page-size choice asked before a report PDF is written. */
function OrientationChooser({
  open,
  onOpenChange,
  value,
  onChange,
  onConfirm,
  busy,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: PdfOrientation;
  onChange: (value: PdfOrientation) => void;
  onConfirm: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50">
              <FileText className="h-4 w-4 text-[#2F6FD6]" />
            </span>
            Page orientation
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            How should the PDF pages be laid out?
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ORIENTATION_OPTIONS.map((option) => {
            const selected = option.value === value;
            const Icon = option.icon;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => onChange(option.value)}
                className={`flex flex-col gap-2 rounded-lg border-2 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2F6FD6] ${
                  selected
                    ? "border-[#9CBBEC] bg-[#F4F8FE]"
                    : "border-[#D5DCE6] bg-white hover:border-[#B7C3D4]"
                } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
              >
                <span className="flex items-center gap-2">
                  <Icon
                    className={`h-4 w-4 ${
                      selected ? "text-[#1F4E9C]" : "text-slate-500"
                    }`}
                  />
                  <span
                    className={`text-sm font-semibold ${
                      selected ? "text-[#1F4E9C]" : "text-slate-800"
                    }`}
                  >
                    {option.label}
                  </span>
                  {selected && (
                    <Check className="ml-auto h-4 w-4 text-[#1F4E9C]" />
                  )}
                </span>
                <span className="text-xs leading-relaxed text-slate-600">
                  {option.description}
                </span>
              </button>
            );
          })}
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            title="Close without downloading"
          >
            Cancel
          </Button>
          <Button
            data-primary-action
            size="sm"
            onClick={onConfirm}
            disabled={disabled || busy}
            loading={busy}
            loadingText="Preparing…"
            className="bg-[#2F6FD6] text-white hover:bg-[#2557b8]"
          >
            <Download className="mr-1.5 h-4 w-4" />
            Download PDF
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReportExportDialog({
  open,
  onOpenChange,
  spec,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spec: ReportSpec | null;
}) {
  const logo = useLogo();
  const [busy, setBusy] = useState<"csv" | "pdf" | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [orientation, setOrientation] = useState<PdfOrientation>("landscape");

  const tableCount = spec?.blocks.filter((block) => block.kind === "table").length ?? 0;

  const close = (next: boolean) => {
    if (!next) setChooserOpen(false);
    onOpenChange(next);
  };

  const run = async (format: "csv" | "pdf") => {
    if (!spec || busy) return;
    // The PDF waits for the orientation answer; the CSV has no pages to lay out.
    if (format === "pdf") {
      setChooserOpen(true);
      return;
    }
    setBusy("csv");
    try {
      downloadReportCsv(spec);
      toast.success("Report downloaded as CSV.");
    } catch {
      toast.error("Could not prepare the report file. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const runPdf = async () => {
    if (!spec || busy) return;
    setBusy("pdf");
    try {
      await downloadReportPdf(spec, logo, orientation);
      toast.success("Report downloaded as PDF.");
      setChooserOpen(false);
    } catch {
      toast.error("Could not prepare the report file. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const canExport = !!spec && spec.rowCount > 0;

  return (
    <>
      <Dialog open={open} onOpenChange={busy ? undefined : close}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50">
                <Download className="h-4 w-4 text-[#2F6FD6]" />
              </span>
              {spec?.title ?? "Export report"}
            </DialogTitle>
            <DialogDescription className="text-[13px]">
              {spec?.subtitle ?? "Download this report as a spreadsheet or a document."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {spec && spec.filters && spec.filters.length > 0 && (
              <dl className="grid grid-cols-1 gap-1.5 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5 sm:grid-cols-2">
                {spec.filters.map((filter) => (
                  <div
                    key={filter.label}
                    className="flex min-w-0 items-baseline justify-between gap-3 text-[13px]"
                  >
                    <dt className="text-slate-500">{filter.label}</dt>
                    <dd className="truncate font-semibold text-slate-800">{filter.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            <p className="text-[13px] text-slate-600">
              {spec ? (
                <>
                  <span className="font-semibold text-slate-800">
                    {spec.rowCount.toLocaleString()} {spec.unitLabel}
                    {spec.rowCount === 1 ? "" : "s"}
                  </span>
                  {tableCount > 1
                    ? ` across ${tableCount} sections`
                    : tableCount === 1
                      ? " in this report"
                      : ""}
                  . Both files carry the same figures the page shows.
                </>
              ) : (
                "Preparing the report…"
              )}
            </p>

            {!canExport && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
                This selection has no rows to export. Widen the date range or clear a
                filter, then open this window again.
              </p>
            )}
          </div>

          <DialogFooter className="flex-wrap gap-2 sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => run("csv")}
              disabled={!canExport || busy !== null}
              loading={busy === "csv"}
              title="Downloads a spreadsheet file (CSV) that opens in Excel"
            >
              <FileSpreadsheet className="mr-1.5 h-4 w-4" />
              Download CSV
            </Button>
            <Button
              data-primary-action
              size="sm"
              onClick={() => run("pdf")}
              disabled={!canExport || busy !== null}
              title="Downloads a printable A4 document (PDF) — asks for the page size first"
              className="bg-[#2F6FD6] text-white hover:bg-[#2557b8]"
            >
              <FileText className="mr-1.5 h-4 w-4" />
              Download PDF
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OrientationChooser
        open={chooserOpen}
        onOpenChange={setChooserOpen}
        value={orientation}
        onChange={setOrientation}
        onConfirm={runPdf}
        busy={busy === "pdf"}
        disabled={!canExport}
      />
    </>
  );
}

/**
 * The single-report convenience trigger: pages whose whole report is one
 * selection (Orders, Payment Verification, the dashboard sales report) render
 * this instead of wiring their own dialog state. `getSpec` runs on click, so the
 * spec is built from the filtered arrays exactly as the screen holds them.
 */
export function ReportExportButton({
  getSpec,
  className = "",
  size = "sm",
  disabled = false,
}: {
  getSpec: () => ReportSpec | null;
  className?: string;
  size?: "sm" | "default";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [spec, setSpec] = useState<ReportSpec | null>(null);

  return (
    <>
      <Button
        variant="outline"
        size={size}
        disabled={disabled}
        onClick={() => {
          setSpec(getSpec());
          setOpen(true);
        }}
        title="Download this view as a CSV or PDF report"
        className={className}
      >
        <Download className="mr-1.5 h-4 w-4" />
        Export
      </Button>
      <ReportExportDialog open={open} onOpenChange={setOpen} spec={spec} />
    </>
  );
}
