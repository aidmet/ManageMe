// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron';

type UpdatePayload = {
    releaseName: string;
    releaseNotes: string;
};

contextBridge.exposeInMainWorld('manageMeDesktop', {
    setWindowBackgroundColor: (hex: string) => {
        ipcRenderer.send('set-window-background', hex);
    },
    onUpdateReady: (callback: (payload: UpdatePayload) => void) => {
        const handler = (_event: unknown, payload: UpdatePayload) =>
            callback(payload);
        ipcRenderer.on('app-update-ready', handler);
        return () => {
            ipcRenderer.removeListener('app-update-ready', handler);
        };
    },
    installUpdate: () => {
        ipcRenderer.send('app-install-update');
    },
    checkForUpdates: (): Promise<
        | { ok: true; kind: 'no_update' }
        | { ok: true; kind: 'update_available' }
        | { ok: false; kind: 'not_packaged' }
        | { ok: false; kind: 'error'; message: string }
    > => ipcRenderer.invoke('app-check-for-updates'),
    showNativeNotification: (opts: { title: string; body: string }) => {
        void ipcRenderer.invoke('show-native-notification', opts);
    },
});
