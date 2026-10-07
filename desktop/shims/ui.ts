/**
 * 桌面版 ui shim。
 *
 * 由 esbuild plugin 將 web-src 內部所有 `from './ui'` 的 import 指向呢個檔
 * （web-src 本體一字不改）。
 *
 * 全部 re-export 自真正的 web-src/ui，唯獨 `openDownloadPopup` 換成
 * 可經 `window.__tgNativeDownload` 攔截的版本——桌面版唔彈 OS browser
 * 新視窗，改行 Tauri dialog＋fs 直接落檔（行為同舊 surgical 版一致）。
 */
export * from '../../web-src/ui';
import { openDownloadPopup as webOpenDownloadPopup } from '../../web-src/ui';

export type NativeDownloadResult =
  | { desktopSaved?: string; desktopCancelled?: boolean }
  | null;
export type NativeDownloadFn = (
  blob: Blob,
  filename: string,
  title: string,
) => Promise<NativeDownloadResult>;

declare global {
  interface Window {
    __tgNativeDownload?: NativeDownloadFn;
  }
}

function downloadHint(opened: unknown): string | null {
  const o = opened as
    | { desktopSaved?: string; desktopCancelled?: boolean }
    | null
    | undefined;
  if (o && o.desktopSaved) return '已儲存：' + o.desktopSaved;
  if (o && o.desktopCancelled) return '已取消儲存';
  return null;
}

/** 與 web 版同簽名；有 native hook 時回傳 sentinel（truthy），等 app 照舊顯示「已開新視窗…」，之後非同步換成 hint。 */
export const openDownloadPopup = (
  blob: Blob,
  filename: string,
  title: string,
): unknown => {
  const hook = window.__tgNativeDownload;
  if (hook) {
    const sentinel = { __desktopPending: true };
    Promise.resolve(hook(blob, filename, title))
      .then((res) => {
        const hint = downloadHint(res);
        if (!hint) return;
        for (const id of ['exportStatus', 'backupStatus']) {
          const el = document.getElementById(id);
          if (
            el &&
            el.textContent &&
            el.textContent.indexOf('已開新視窗') === 0
          ) {
            el.textContent = hint;
          }
        }
      })
      .catch((e) => console.error('[desktop] native download failed:', e));
    return sentinel;
  }
  return webOpenDownloadPopup(blob, filename, title);
};
