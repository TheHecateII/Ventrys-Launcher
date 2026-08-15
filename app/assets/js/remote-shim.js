/**
 * Minimal replacement for @electron/remote, which stopped tracking Electron's
 * breaking changes and no longer works with modern Electron majors (ipcMain
 * is undefined during its main-process init on Electron 39). This shim only
 * implements the exact subset of the remote API this launcher actually uses
 * (getCurrentWindow().setProgressBar/toggleDevTools/close, app.getVersion,
 * dialog.showOpenDialog), backed by plain IPC to index.js.
 *
 * Declared as a top-level `const` in a classic (non-module) script, loaded
 * before uicore.js/uibinder.js/landing.js/settings.js in app.ejs - those
 * files reference `remote` without importing it themselves, relying on the
 * shared global lexical scope classic scripts get in the same document.
 */
const remote = (function() {
    const { ipcRenderer } = require('electron')

    const currentWindow = {
        setProgressBar: (value) => ipcRenderer.send('window:setProgressBar', value),
        toggleDevTools: () => ipcRenderer.send('window:toggleDevTools'),
        close: () => ipcRenderer.send('window:close')
    }

    return {
        getCurrentWindow: () => currentWindow,
        app: {
            getVersion: () => ipcRenderer.sendSync('app:getVersion')
        },
        dialog: {
            // Support both showOpenDialog(options) and the legacy
            // showOpenDialog(window, options) call shape - the window is
            // resolved on the main side from the IPC sender either way.
            showOpenDialog: (...args) => {
                const options = args.length > 1 ? args[1] : args[0]
                return ipcRenderer.invoke('dialog:showOpenDialog', options)
            }
        }
    }
})()
