import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from './bridge/types';
import { flushSettingsSave } from './settings';

/** Keep the WebView alive until the debounced and in-flight writes have landed. */
export async function installCloseGuard(notify: (message: string) => void): Promise<() => void> {
  if (!isTauri()) {
    const onUnload = () => { void flushSettingsSave().catch((error) => notify(String(error))); };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }
  const appWindow = getCurrentWindow();
  let closing = false;
  return appWindow.onCloseRequested((event) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    void flushSettingsSave().then(() => appWindow.destroy()).catch((error) => {
      closing = false;
      notify(`设置保存失败，窗口保持打开：${String(error)}`);
    });
  });
}
