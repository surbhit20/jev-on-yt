// Classic content script. The app is an ES module inside the extension package.
import(chrome.runtime.getURL('src/app.js'))
  .then((m) => m.start())
  .catch((e) => console.error('[jev-yt] failed to start', e));
