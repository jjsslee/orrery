/** Only the app's own main frame may write to the clipboard. */
export function allowClipboardWrite(permission: string, appOrigin: string, currentUrl: string | undefined, requestingUrl: string | undefined, isMainFrame: boolean): boolean {
  if (permission !== 'clipboard-sanitized-write' || !isMainFrame || !currentUrl || !requestingUrl) return false;
  try {
    return new URL(currentUrl).origin === appOrigin && new URL(requestingUrl).origin === appOrigin;
  } catch { return false; }
}
