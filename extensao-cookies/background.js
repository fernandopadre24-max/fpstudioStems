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

const BASE_URLS = [
  "https://www.youtube.com/",
  "https://youtube.com/",
  "https://m.youtube.com/",
  "https://www.google.com/",
  "https://google.com/",
  "https://accounts.google.com/",
  "https://ogs.google.com/",
];

async function collect() {
  const map = new Map();
  for (const url of BASE_URLS) {
    try {
      for (const c of await chrome.cookies.getAll({ url })) {
        map.set(`${c.domain}|${c.path}|${c.name}`, c);
      }
    } catch (_) {}
  }
  try {
    for (const c of await chrome.cookies.getAll({})) map.set(`${c.domain}|${c.path}|${c.name}`, c);
  } catch (_) {}
  return [...map.values()].filter(
    (c) => /(^|\.)youtube\.com$/.test(c.domain) || /(^|\.)google\.com$/.test(c.domain),
  );
}

async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Gerar o arquivo cookies.txt a partir dos cookies lidos.",
    });
  } catch (e) {
    console.warn("[cookies] offscreen:", e && e.message);
  }
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
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: "download-cookies", text });
    console.log(
      `[cookies] exportados ${cookies.length} cookies (${auth.length} de login: ${auth
        .map((c) => c.name)
        .join(",")}) - motivo: ${reason}`,
    );
  } catch (e) {
    console.error("[cookies] falha ao exportar:", e);
  }
}

chrome.runtime.onInstalled.addListener(() => exportCookies("onInstalled"));
chrome.runtime.onStartup.addListener(() => exportCookies("onStartup"));
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "export-now") {
    exportCookies("manual").then(() => sendResponse({ ok: true }));
    return true;
  }
});
