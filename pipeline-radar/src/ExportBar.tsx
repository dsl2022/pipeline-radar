import { useEffect, useState } from 'react';

// Milestone 5 toolbar: export the landscape report (.md / .html / .pdf) + save
// the watchlist. Report content is built lazily at click time so it always
// reflects the current enrichment maps — export is never blocked on pending
// badges, the pending count is just surfaced next to the buttons.
//
// Builders return content AND filename together, derived from one meta (one
// clock per click) — so the date stamped in the filename can never disagree
// with the "Generated" line inside the document.

export interface ExportDoc {
  content: string;
  filename: string;
}

function downloadBlob(doc: ExportDoc, type: string) {
  const blob = new Blob([doc.content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportBar({
  buildMarkdown,
  buildHtml,
  exportPdf,
  onSaveWatchlist,
  pendingCount = 0,
}: {
  buildMarkdown: () => ExportDoc;
  buildHtml: () => ExportDoc;
  exportPdf: () => Promise<void>; // async: jspdf is dynamically imported on first click
  onSaveWatchlist?: () => void; // drugs view only — the trials view has no watchlist
  pendingCount?: number;
}) {
  const [copied, setCopied] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfFailed, setPdfFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(buildMarkdown().content);
      setCopied(true);
    } catch {
      /* clipboard permission denied — button simply stays unchanged */
    }
  }

  async function pdf() {
    if (pdfBusy) return;
    setPdfBusy(true);
    setPdfFailed(false);
    try {
      await exportPdf();
    } catch {
      // The dynamic jspdf import rejects offline or after a redeploy staled the
      // chunk URL — a silent reset here would look like the button just doesn't
      // work, so the failure gets said out loud.
      setPdfFailed(true);
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="export-bar">
      <button type="button" onClick={() => downloadBlob(buildMarkdown(), 'text/markdown')}>
        Export .md
      </button>
      <button type="button" onClick={() => downloadBlob(buildHtml(), 'text/html')}>
        .html
      </button>
      <button type="button" onClick={pdf} disabled={pdfBusy}>
        {pdfBusy ? 'Generating…' : '.pdf'}
      </button>
      <button type="button" onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
      <button type="button" onClick={() => window.print()}>
        Print
      </button>
      {onSaveWatchlist && (
        <button type="button" className="save-watchlist" onClick={onSaveWatchlist}>
          Save watchlist
        </button>
      )}
      {pdfFailed && <span className="export-error">PDF export failed — check your connection and retry.</span>}
      {pendingCount > 0 && (
        <span className="export-pending">
          {pendingCount} FDA badges still loading — exports show “—”, a watchlist saved now records them as unresolved
        </span>
      )}
    </div>
  );
}
