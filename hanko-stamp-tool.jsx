import { useState, useRef, useEffect, useCallback } from "react";

const STORAGE_KEY = "hanko_stamp_settings";

export default function HankoStampTool() {
  const [pdfFile, setPdfFile] = useState(null);
  const [pdfBytes, setPdfBytes] = useState(null);
  const [hankoFile, setHankoFile] = useState(null);
  const [hankoDataUrl, setHankoDataUrl] = useState(null);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [stamping, setStamping] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState("setup"); // setup | position | ready
  const [stampPos, setStampPos] = useState(null); // {xRatio, yRatio} 0-1 relative
  const STAMP_SIZE_PT = 70.6; // 実寸固定: A4 PDFから抽出した実寸(pt) ≈ 24.9mm
  const [dragging, setDragging] = useState(false);
  const [savedSettings, setSavedSettings] = useState(null);
  const [applyToPages, setApplyToPages] = useState("all"); // "all" | "first" | "last" | "current"

  const canvasRef = useRef(null);
  const pdfDocRef = useRef(null);
  const viewportRef = useRef(null);
  const canvasScaleRef = useRef(1);

  // Load saved settings on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setSavedSettings(JSON.parse(saved));
    } catch {}
  }, []);

  const saveSettings = (pos) => {
    const settings = { stampPos: pos };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
    setSavedSettings(settings);
  };

  // Load pdf.js
  const getPdfJs = useCallback(async () => {
    if (window.pdfjsLib) return window.pdfjsLib;
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }, []);

  // Load pdf-lib
  const getPdfLib = useCallback(async () => {
    if (window.PDFLib) return window.PDFLib;
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
      s.onload = () => resolve(window.PDFLib);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }, []);

  const renderPage = useCallback(async (pageNum) => {
    if (!pdfDocRef.current || !canvasRef.current) return;
    const page = await pdfDocRef.current.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });
    viewportRef.current = viewport;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvasScaleRef.current = viewport.scale;
    await page.render({ canvasContext: ctx, viewport }).promise;
  }, []);

  const loadPdf = useCallback(async (bytes) => {
    try {
      const pdfjsLib = await getPdfJs();
      const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() });
      const pdf = await loadingTask.promise;
      pdfDocRef.current = pdf;
      setPdfPageCount(pdf.numPages);
      setCurrentPage(1);
      await renderPage(1);
      setMode("position");
    } catch (e) {
      setError("PDFの読み込みに失敗しました: " + e.message);
    }
  }, [getPdfJs, renderPage]);

  useEffect(() => {
    if (pdfBytes) loadPdf(pdfBytes);
  }, [pdfBytes, loadPdf]);

  useEffect(() => {
    if (pdfDocRef.current && mode === "position") renderPage(currentPage);
  }, [currentPage, mode, renderPage]);

  const handlePdfUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setPdfFile(file.name);
    setDone(false);
    setError(null);
    const reader = new FileReader();
    reader.onload = (ev) => setPdfBytes(new Uint8Array(ev.target.result));
    reader.readAsArrayBuffer(file);
  };

  const handleHankoUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setHankoFile(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setHankoDataUrl(ev.target.result);
    reader.readAsDataURL(file);
  };

  const getCanvasRelPos = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return { xRatio: Math.max(0, Math.min(1, x)), yRatio: Math.max(0, Math.min(1, y)) };
  };

  const handleCanvasClick = (e) => {
    if (mode !== "position") return;
    const pos = getCanvasRelPos(e);
    if (pos) setStampPos(pos);
  };

  const handleCanvasDrag = (e) => {
    if (dragging) {
      const pos = getCanvasRelPos(e);
      if (pos) setStampPos(pos);
    }
  };

  const getTargetPages = () => {
    if (!pdfPageCount) return [];
    if (applyToPages === "all") return Array.from({ length: pdfPageCount }, (_, i) => i);
    if (applyToPages === "first") return [0];
    if (applyToPages === "last") return [pdfPageCount - 1];
    if (applyToPages === "current") return [currentPage - 1];
    return [0];
  };

  const applyStamp = useCallback(async () => {
    if (!pdfBytes || !hankoDataUrl || !stampPos || !viewportRef.current) return;
    setStamping(true);
    setError(null);
    try {
      const PDFLib = await getPdfLib();
      const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();
      const viewport = viewportRef.current;

      // Convert hanko data URL to bytes
      const hankoBase64 = hankoDataUrl.split(",")[1];
      const hankoMime = hankoDataUrl.split(";")[0].split(":")[1];
      const hankoBytes = Uint8Array.from(atob(hankoBase64), c => c.charCodeAt(0));

      let hankoImage;
      if (hankoMime === "image/png") {
        hankoImage = await pdfDoc.embedPng(hankoBytes);
      } else {
        hankoImage = await pdfDoc.embedJpg(hankoBytes);
      }

      const targetPageIndices = getTargetPages();

      for (const idx of targetPageIndices) {
        const page = pages[idx];
        const { width: pdfW, height: pdfH } = page.getSize();

        // Scale: canvas viewport px → PDF pt
        const scaleX = pdfW / viewport.width;
        const scaleY = pdfH / viewport.height;

        // stampPos is ratio of canvas display size
        const canvasEl = canvasRef.current;
        const displayW = canvasEl ? canvasEl.getBoundingClientRect().width : viewport.width;
        const displayH = canvasEl ? canvasEl.getBoundingClientRect().height : viewport.height;

        // Center of stamp in PDF coords
        const centerXPdf = stampPos.xRatio * pdfW;
        const centerYPdf = (1 - stampPos.yRatio) * pdfH; // PDF Y is bottom-up

        // サイズはPDFポイント固定（実寸 ≈ 24.9mm）
        const stampSizePdf = STAMP_SIZE_PT;

        hankoImage.scale(1);
        const imgDims = hankoImage.scale(stampSizePdf / Math.max(hankoImage.width, hankoImage.height));

        page.drawImage(hankoImage, {
          x: centerXPdf - imgDims.width / 2,
          y: centerYPdf - imgDims.height / 2,
          width: imgDims.width,
          height: imgDims.height,
          opacity: 0.88,
        });
      }

      const outputBytes = await pdfDoc.save();
      const blob = new Blob([outputBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const baseName = (pdfFile || "invoice").replace(/\.pdf$/i, "");
      a.download = `${baseName}_stamped.pdf`;
      a.click();
      URL.revokeObjectURL(url);

      saveSettings(stampPos);
      setDone(true);
    } catch (e) {
      setError("押印処理に失敗しました: " + e.message);
    } finally {
      setStamping(false);
    }
  }, [pdfBytes, hankoDataUrl, stampPos, getPdfLib, pdfFile, applyToPages, pdfPageCount, currentPage]);

  const loadSavedSettings = () => {
    if (!savedSettings) return;
    setStampPos(savedSettings.stampPos);
  };

  // Canvas overlay for stamp preview
  const StampOverlay = () => {
    if (!stampPos || !hankoDataUrl) return null;
    // プレビュー上での印影サイズ = STAMP_SIZE_PT / PDFのpt幅 × canvas表示px幅
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    const displayW = canvas ? canvas.getBoundingClientRect().width : 0;
    const pdfWPt = viewport ? viewport.width / (viewport.scale) : 595;
    const previewSizePx = displayW > 0 ? STAMP_SIZE_PT / pdfWPt * displayW : 60;
    return (
      <img
        src={hankoDataUrl}
        alt="印影プレビュー"
        style={{
          position: "absolute",
          left: `calc(${stampPos.xRatio * 100}% - ${previewSizePx / 2}px)`,
          top: `calc(${stampPos.yRatio * 100}% - ${previewSizePx / 2}px)`,
          width: previewSizePx,
          height: previewSizePx,
          objectFit: "contain",
          opacity: 0.82,
          pointerEvents: "none",
          filter: "drop-shadow(0 0 2px rgba(180,0,0,0.4))",
        }}
      />
    );
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#1a1a1a",
      color: "#e8e0d5",
      fontFamily: "'Noto Serif JP', 'Georgia', serif",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Header */}
      <div style={{
        borderBottom: "1px solid #3a3330",
        padding: "16px 24px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "#141414",
      }}>
        <span style={{ fontSize: 28, letterSpacing: 2 }}>判</span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: 3, color: "#c9a87c" }}>自動押印ツール</div>
          <div style={{ fontSize: 11, color: "#888", letterSpacing: 1 }}>請求書PDF × 実印 自動合成</div>
        </div>
        {savedSettings && (
          <button
            onClick={loadSavedSettings}
            style={{
              marginLeft: "auto", fontSize: 12, padding: "5px 14px",
              background: "#2a2520", border: "1px solid #5a4a3a", borderRadius: 4,
              color: "#c9a87c", cursor: "pointer", letterSpacing: 1,
            }}
          >
            前回の位置を読み込む
          </button>
        )}
      </div>

      <div style={{ display: "flex", flex: 1, gap: 0 }}>
        {/* Left panel */}
        <div style={{
          width: 260, minWidth: 220, background: "#111",
          borderRight: "1px solid #2a2520", padding: "20px 18px",
          display: "flex", flexDirection: "column", gap: 18,
        }}>
          {/* Step 1: PDF */}
          <Section num="1" title="請求書PDF" done={!!pdfBytes}>
            <UploadButton label={pdfFile || "PDFを選択"} accept=".pdf" onChange={handlePdfUpload} />
          </Section>

          {/* Step 2: Hanko */}
          <Section num="2" title="印影画像" done={!!hankoDataUrl}>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>PNG（透過）推奨</div>
            <UploadButton label={hankoFile || "画像を選択"} accept="image/png,image/jpeg" onChange={handleHankoUpload} />
            {hankoDataUrl && (
              <img src={hankoDataUrl} alt="印影" style={{
                marginTop: 8, width: 56, height: 56, objectFit: "contain",
                border: "1px solid #3a3330", borderRadius: 4, padding: 4,
                background: "#1e1a17",
              }} />
            )}
          </Section>

          {/* Step 3: Position */}
          {mode === "position" && (
            <Section num="3" title="押印位置" done={!!stampPos}>
              <div style={{ fontSize: 11, color: "#aaa", marginBottom: 8, lineHeight: 1.6 }}>
                右のプレビューをクリックして<br />押印位置を指定してください
              </div>
              <div style={{ fontSize: 11, color: "#666", marginBottom: 10 }}>
                サイズ: 約25mm（実寸固定）
              </div>
              <label style={{ fontSize: 12, color: "#c9a87c", display: "block", marginTop: 4, marginBottom: 4 }}>
                押印ページ
              </label>
              <select value={applyToPages} onChange={e => setApplyToPages(e.target.value)}
                style={{
                  width: "100%", padding: "5px 8px", background: "#1e1a17",
                  border: "1px solid #3a3330", borderRadius: 4, color: "#e8e0d5",
                  fontSize: 12,
                }}>
                <option value="all">全ページ</option>
                <option value="first">1ページ目のみ</option>
                <option value="last">最終ページのみ</option>
                <option value="current">表示中のページのみ</option>
              </select>
            </Section>
          )}

          {/* Stamp button */}
          {pdfBytes && hankoDataUrl && stampPos && (
            <button
              onClick={applyStamp}
              disabled={stamping}
              style={{
                marginTop: "auto", padding: "12px 0",
                background: stamping ? "#333" : "linear-gradient(135deg, #8b2020, #c9372c)",
                border: "none", borderRadius: 6,
                color: "#fff", fontSize: 14, fontWeight: 700,
                letterSpacing: 3, cursor: stamping ? "not-allowed" : "pointer",
                boxShadow: stamping ? "none" : "0 4px 16px rgba(180,40,40,0.35)",
                transition: "all 0.2s",
              }}
            >
              {stamping ? "処理中..." : "押印して保存"}
            </button>
          )}

          {done && (
            <div style={{
              padding: "8px 12px", background: "#1a2a1a", border: "1px solid #3a6a3a",
              borderRadius: 6, fontSize: 12, color: "#7dbf7d", textAlign: "center",
            }}>
              ✓ 保存完了 — 位置を記憶しました
            </div>
          )}

          {error && (
            <div style={{
              padding: "8px 12px", background: "#2a1515", border: "1px solid #6a3a3a",
              borderRadius: 6, fontSize: 11, color: "#e07070",
            }}>{error}</div>
          )}
        </div>

        {/* Main: PDF Preview */}
        <div style={{ flex: 1, overflow: "auto", padding: 24, display: "flex", flexDirection: "column", alignItems: "center" }}>
          {!pdfBytes && (
            <div style={{
              marginTop: 80, textAlign: "center", color: "#555",
              fontSize: 14, lineHeight: 2, letterSpacing: 1,
            }}>
              <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>📄</div>
              左のパネルからPDFと印影画像を<br />アップロードしてください
            </div>
          )}

          {pdfBytes && (
            <>
              {pdfPageCount > 1 && (
                <div style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
                  <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    style={navBtnStyle}>◀</button>
                  <span style={{ fontSize: 13, color: "#aaa" }}>{currentPage} / {pdfPageCount}</span>
                  <button onClick={() => setCurrentPage(p => Math.min(pdfPageCount, p + 1))}
                    disabled={currentPage === pdfPageCount}
                    style={navBtnStyle}>▶</button>
                </div>
              )}

              <div style={{ position: "relative", cursor: mode === "position" ? "crosshair" : "default", maxWidth: "100%" }}>
                <canvas
                  ref={canvasRef}
                  style={{ display: "block", maxWidth: "100%", border: "1px solid #333", borderRadius: 4 }}
                  onClick={handleCanvasClick}
                  onMouseMove={handleCanvasDrag}
                  onMouseDown={() => setDragging(true)}
                  onMouseUp={() => setDragging(false)}
                  onTouchStart={() => setDragging(true)}
                  onTouchMove={handleCanvasDrag}
                  onTouchEnd={() => setDragging(false)}
                />
                <StampOverlay />
              </div>

              {mode === "position" && !stampPos && (
                <div style={{ marginTop: 12, fontSize: 12, color: "#c9a87c", letterSpacing: 1 }}>
                  ← クリックして押印位置を指定
                </div>
              )}
              {stampPos && (
                <div style={{ marginTop: 8, fontSize: 11, color: "#666" }}>
                  位置: X {(stampPos.xRatio * 100).toFixed(1)}% / Y {(stampPos.yRatio * 100).toFixed(1)}%
                  　<span style={{ color: "#5a9a5a", cursor: "pointer" }} onClick={() => setStampPos(null)}>✕ リセット</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ num, title, done, children }) {
  return (
    <div style={{ borderLeft: `2px solid ${done ? "#c9a87c" : "#333"}`, paddingLeft: 12 }}>
      <div style={{ fontSize: 12, color: done ? "#c9a87c" : "#777", marginBottom: 8, letterSpacing: 1 }}>
        STEP {num}　{title}
      </div>
      {children}
    </div>
  );
}

function UploadButton({ label, accept, onChange }) {
  const ref = useRef();
  return (
    <>
      <button
        onClick={() => ref.current.click()}
        style={{
          width: "100%", padding: "8px 0", background: "#1e1a17",
          border: "1px solid #3a3330", borderRadius: 4,
          color: "#c9a87c", fontSize: 12, cursor: "pointer", letterSpacing: 1,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}
      >
        {label}
      </button>
      <input ref={ref} type="file" accept={accept} onChange={onChange} style={{ display: "none" }} />
    </>
  );
}

const navBtnStyle = {
  padding: "4px 12px", background: "#1e1a17", border: "1px solid #333",
  borderRadius: 4, color: "#aaa", cursor: "pointer", fontSize: 13,
};
