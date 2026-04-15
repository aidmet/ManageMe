// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron';

type UpdatePayload = {
    releaseName: string;
    releaseNotes: string;
};

contextBridge.exposeInMainWorld('manageMeDesktop', {
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
});
