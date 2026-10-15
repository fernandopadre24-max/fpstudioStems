const AUTH_RE =
  /^(SID|HSID|SSID|APISID|SAPISID|__Secure-1PSID|__Secure-3PSID|__Secure-1PAPISID|__Secure-3PAPISID|LOGIN_INFO)$/;

function toNetscape(cookies) {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# gerado pela extensao Exportar cookies do YouTube (yt-dlp)",
    "",
  ];
  for (const c of cookies) {
    const domain = c.domain || "";
    const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expiry = c.expirationDate ? Math.round(c.expirationDate) : 0;
    lines.push([domain, includeSub, c.path || "/", secure, expiry, c.name, c.value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

async function collect() {
  const all = await chrome.cookies.getAll({});
  return all.filter(
    (c) => /(^|\.)youtube\.com$/.test(c.domain) || /(^|\.)google\.com$/.test(c.domain),
  );
}

async function exportCookies(reason) {
  try {
    const cookies = await collect();
    const auth = cookies.filter((c) => AUTH_RE.test(c.name));
    if (cookies.length === 0) {
      console.warn("[cookies] nenhum cookie do YouTube/Google encontrado para exportar.");
      return;
    }
    const text = toNetscape(cookies);
    const b64 = btoa(unescape(encodeURIComponent(text)));
    await chrome.downloads.download({
      url: "data:text/plain;base64," + b64,
      filename: "cookies.txt",
      saveAs: false,
      conflictAction: "overwrite",
    });
    console.log(`[cookies] exportados ${cookies.length} cookies (${auth.length} de login) - motivo: ${reason}`);
  } catch (e) {
    console.error("[cookies] falha ao exportar:", e);
  }
}

chrome.runtime.onInstalled.addListener(() => exportCookies("onInstalled"));
chrome.runtime.onStartup.addListener(() => exportCookies("onStartup"));
