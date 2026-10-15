chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "download-cookies" && typeof msg.text === "string") {
    const blob = new Blob([msg.text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      { url, filename: "cookies.txt", saveAs: false, conflictAction: "overwrite" },
      () => {
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        sendResponse({ ok: true });
      },
    );
    return true;
  }
});
