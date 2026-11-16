// The one path every "turn a generated HTML document into a downloadable file"
// feature in the app shares: the order receipt (PDF / PNG) and the report
// exports (PDF). No dependency beyond the already-installed pdf-lib, and no
// server.
//
// How it works: the HTML is laid out in an off-screen iframe at its own sheet
// width so it can be measured, serialized as XHTML and wrapped in a single SVG
// <foreignObject> loaded as a data URL, then drawn onto a canvas. That is the
// only way to rasterize markup without a library. Because every resource inside
// the document must be inline, the canvas is never tainted by a cross-origin
// image — callers pass data URLs (see logoToDataUrl). The PDF then tiles the
// canvas onto A4 pages, slicing at page boundaries so nothing is dropped or
// repeated.

/** A4 at 96dpi — the width a portrait document lays out at. */
export const A4_PORTRAIT_SHEET_WIDTH = 794;
/** A4 landscape at 96dpi — wide tabular documents lay out at this width. */
export const A4_LANDSCAPE_SHEET_WIDTH = 1123;

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const A4_MARGIN_PT = 39.685;

export type PdfOrientation = "portrait" | "landscape";

function pageSize(orientation: PdfOrientation) {
  return orientation === "landscape"
    ? { width: A4_HEIGHT_PT, height: A4_WIDTH_PT }
    : { width: A4_WIDTH_PT, height: A4_HEIGHT_PT };
}

/**
 * Turn an image source into a data URL so a generated document can embed it.
 * A custom (admin-uploaded) logo is already a data URL; the bundled default is
 * fetched and converted. Returns undefined when it cannot be read, so the
 * document falls back to its text wordmark instead of an empty box.
 */
export async function logoToDataUrl(src: string): Promise<string | undefined> {
  if (!src) return undefined;
  if (src.startsWith("data:")) return src;
  try {
    const res = await fetch(src);
    if (!res.ok) return undefined;
    const blob = await res.blob();
    return await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(typeof reader.result === "string" ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

export function saveBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Released late, like every other download in the app: revoking a blob URL
  // while the browser is still reading it can cancel the save.
  setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
}

/**
 * Lay `html` out at `widthPx` and draw it onto a canvas at `scale`×.
 *
 * The document must be self-contained (inline styles, inline images) — nothing
 * is fetched while it renders.
 */
export async function renderHtmlToCanvas(
  html: string,
  widthPx: number,
  scale: number,
): Promise<HTMLCanvasElement> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthPx}px;height:600px;border:0;visibility:hidden`;
  document.body.appendChild(frame);

  try {
    const doc = await new Promise<Document>((resolve, reject) => {
      const settle = () => {
        const parsed = frame.contentDocument;
        if (parsed?.body) resolve(parsed);
        else reject(new Error("The document could not be prepared."));
      };
      frame.onload = settle;
      frame.srcdoc = html;
      // A srcdoc frame that never fires load must not hang the button.
      window.setTimeout(settle, 4000);
    });

    // Images are local data URLs; wait for them so they paint rather than
    // leaving empty boxes in the file.
    await Promise.all(
      Array.from(doc.images).map(
        (img) =>
          new Promise<void>((resolve) => {
            if (img.complete) {
              resolve();
              return;
            }
            img.onload = () => resolve();
            img.onerror = () => resolve();
          }),
      ),
    );

    const sheet = doc.body;
    const width = widthPx;
    const height = Math.max(
      1,
      Math.ceil(Math.max(sheet.scrollHeight, sheet.offsetHeight)),
    );

    // XMLSerializer closes void tags (<br>, <img>) the way XML requires; the
    // stylesheet is escaped because it is emitted as character data.
    const css = Array.from(doc.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;");
    const markup = Array.from(sheet.childNodes)
      .map((node) => new XMLSerializer().serializeToString(node))
      .join("");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">` +
      `<body xmlns="http://www.w3.org/1999/xhtml" style="margin:0;background:#ffffff">` +
      `<style>${css}</style>${markup}` +
      `</body></foreignObject></svg>`;

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("The document could not be rendered."));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("The document could not be rendered.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    document.body.removeChild(frame);
  }
}

export function canvasToPngBytes(
  canvas: HTMLCanvasElement,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("The document could not be rendered."));
        return;
      }
      resolve(await blob.arrayBuffer());
    }, "image/png");
  });
}

/**
 * Tile a canvas onto A4 pages.
 *
 * A document that fits is drawn once at full content width; a longer one spills
 * onto further pages, sliced at page boundaries (floor on both sides so nothing
 * is dropped or repeated, drawn height clamped to the printable box).
 */
export async function canvasToPdfBytes(
  canvas: HTMLCanvasElement,
  orientation: PdfOrientation = "portrait",
): Promise<Uint8Array> {
  // Imported here so the PDF library stays out of the main bundle.
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const page = pageSize(orientation);

  const contentWidth = page.width - A4_MARGIN_PT * 2;
  const contentHeight = page.height - A4_MARGIN_PT * 2;
  const ptPerPx = contentWidth / canvas.width;
  const pagePx = contentHeight / ptPerPx;
  const pageCount = Math.max(1, Math.ceil(canvas.height / pagePx));

  for (let index = 0; index < pageCount; index += 1) {
    const top = Math.floor(index * pagePx);
    const bottom =
      index === pageCount - 1 ? canvas.height : Math.floor((index + 1) * pagePx);
    const sliceHeight = bottom - top;
    if (sliceHeight <= 0) break;

    let source: HTMLCanvasElement = canvas;
    if (pageCount > 1) {
      const slice = document.createElement("canvas");
      slice.width = canvas.width;
      slice.height = sliceHeight;
      const sliceCtx = slice.getContext("2d");
      if (!sliceCtx) throw new Error("The document could not be rendered.");
      sliceCtx.fillStyle = "#ffffff";
      sliceCtx.fillRect(0, 0, slice.width, slice.height);
      sliceCtx.drawImage(
        canvas,
        0,
        top,
        slice.width,
        sliceHeight,
        0,
        0,
        slice.width,
        slice.height,
      );
      source = slice;
    }

    const embedded = await pdf.embedPng(
      new Uint8Array(await canvasToPngBytes(source)),
    );
    const drawWidth = contentWidth;
    // Clamped so a slice that rounded a fraction of a pixel tall can never
    // spill past the page's bottom margin.
    const drawHeight = Math.min(
      contentHeight,
      drawWidth * (embedded.height / embedded.width),
    );
    pdf
      .addPage([page.width, page.height])
      .drawImage(embedded, {
        x: A4_MARGIN_PT,
        y: page.height - A4_MARGIN_PT - drawHeight,
        width: drawWidth,
        height: drawHeight,
      });
  }

  return pdf.save();
}

/** Render a self-contained HTML document straight to a downloaded PDF. */
export async function downloadHtmlPdf(options: {
  html: string;
  filename: string;
  sheetWidthPx?: number;
  orientation?: PdfOrientation;
  /** 3 keeps text crisp at print size; the receipt's own setting. */
  scale?: number;
}) {
  const canvas = await renderHtmlToCanvas(
    options.html,
    options.sheetWidthPx ??
      (options.orientation === "landscape"
        ? A4_LANDSCAPE_SHEET_WIDTH
        : A4_PORTRAIT_SHEET_WIDTH),
    options.scale ?? 3,
  );
  const bytes = await canvasToPdfBytes(canvas, options.orientation);
  saveBlob(
    new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
    options.filename,
  );
}
