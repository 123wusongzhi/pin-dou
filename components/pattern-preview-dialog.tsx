/* eslint-disable @next/next/no-img-element -- generated preview uses an in-memory data URL */

import { Check, Clipboard, Download, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type ZoomSize = { width: number; height: number };
type PreviewMode = "mobile" | "construction";

function imageZoomSize(viewport: HTMLElement, image: HTMLImageElement): ZoomSize | null {
  if (!image.naturalWidth || !image.naturalHeight) return null;
  const style = getComputedStyle(viewport);
  const width = Math.max(1, viewport.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight));
  const height = Math.max(1, viewport.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom));
  const fitScale = Math.min(1, width / image.naturalWidth, height / image.naturalHeight);
  const zoomScale = Math.max(1, fitScale * 2.5);
  return {
    width: Math.round(image.naturalWidth * zoomScale),
    height: Math.round(image.naturalHeight * zoomScale),
  };
}

export function PatternPreviewDialog({
  src,
  mobileSrc,
  name,
  onClose,
  onCopy,
  onDownload,
  onDownloadMobile,
}: {
  src: string;
  mobileSrc: string;
  name: string;
  onClose: () => void;
  onCopy: () => Promise<boolean>;
  onDownload: () => void;
  onDownloadMobile: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    returnFocus = useRef<HTMLElement | null>(null),
    copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    viewport = useRef<HTMLDivElement>(null),
    image = useRef<HTMLImageElement>(null);
  const [copying, setCopying] = useState(false),
    [copied, setCopied] = useState(false),
    [zoomSize, setZoomSize] = useState<ZoomSize | null>(null),
    [mode, setMode] = useState<PreviewMode>("mobile");
  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      element?.close();
      requestAnimationFrame(() => returnFocus.current?.focus());
    };
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setZoomSize((current) => {
        if (!current || !image.current) return current;
        const next = imageZoomSize(element, image.current);
        return next && (next.width !== current.width || next.height !== current.height)
          ? next
          : current;
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!zoomSize) return;
    const frame = requestAnimationFrame(() => {
      const element = viewport.current;
      if (!element) return;
      element.scrollTo({
        left: (element.scrollWidth - element.clientWidth) / 2,
        top: (element.scrollHeight - element.clientHeight) / 2,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [zoomSize]);

  function toggleZoom() {
    if (zoomSize) {
      setZoomSize(null);
      viewport.current?.scrollTo(0, 0);
      return;
    }
    if (!viewport.current || !image.current) return;
    setZoomSize(imageZoomSize(viewport.current, image.current));
  }

  function showMode(next: PreviewMode) {
    setMode(next);
    setZoomSize(null);
    viewport.current?.scrollTo(0, 0);
  }

  return (
    <dialog
      ref={dialog}
      className="pattern-preview-dialog pattern-download-preview-dialog"
      aria-labelledby="pattern-preview-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={event => event.target === event.currentTarget && onClose()}
    >
      <div className="pattern-preview-card">
        <div className="pattern-preview-heading">
          <div>
            <h2 id="pattern-preview-title">图纸预览</h2>
            <p>
              {name}
              {" "}
              ·
              {mode === "mobile" ? "手机预览图，适合相册查看" : "施工图，方格、色号和用量齐全"}
            </p>
          </div>
          <div className="pattern-preview-actions">
            <Button
              className="pattern-preview-zoom"
              variant="outline"
              aria-label={zoomSize ? "还原完整图纸" : "放大图纸查看细节"}
              aria-pressed={Boolean(zoomSize)}
              onClick={toggleZoom}
            >
              {zoomSize ? <ZoomOut /> : <ZoomIn />}
              {zoomSize ? "还原" : "放大"}
            </Button>
            <Button
              className="pattern-preview-copy"
              variant="outline"
              aria-disabled={copying || copied}
              aria-label={copying ? "正在复制" : copied ? "复制成功" : "复制施工图"}
              onClick={() => {
                if (copying || copied) return;
                setCopying(true);
                void onCopy().then((success) => {
                  setCopied(success);
                  setCopying(false);
                  if (success) {
                    if (copiedTimer.current) clearTimeout(copiedTimer.current);
                    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
                  }
                });
              }}
            >
              <span
                className="pattern-preview-copy-label"
                aria-hidden="true"
              >
                {copied
                  ? (
                      <>
                        <Check />
                        复制成功
                      </>
                    )
                  : (
                      <>
                        <Clipboard />
                        复制施工图
                      </>
                    )}
              </span>
            </Button>
            <Button
              aria-label={mode === "mobile" ? "下载手机预览图 PNG" : "下载完整施工图 PNG"}
              onClick={mode === "mobile" ? onDownloadMobile : onDownload}
            >
              <Download />
              {mode === "mobile" ? "下载预览图" : "下载施工图"}
            </Button>
          </div>
          <Button
            className="pattern-preview-close"
            variant="outline"
            size="icon"
            aria-label="关闭预览"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        <div
          className="pattern-preview-modes"
          role="group"
          aria-label="选择下载图片版本"
        >
          <button
            type="button"
            aria-pressed={mode === "mobile"}
            onClick={() => showMode("mobile")}
          >
            手机预览图
          </button>
          <button
            type="button"
            aria-pressed={mode === "construction"}
            onClick={() => showMode("construction")}
          >
            完整施工图
          </button>
        </div>
        <div
          ref={viewport}
          className={`pattern-preview-scroll${zoomSize ? " pattern-preview-zoomed" : ""}`}
        >
          <img
            ref={image}
            src={mode === "mobile" ? mobileSrc : src}
            alt={`${name}${mode === "mobile" ? "手机预览图" : "完整施工图"}`}
            style={zoomSize ?? undefined}
          />
        </div>
      </div>
    </dialog>
  );
}
