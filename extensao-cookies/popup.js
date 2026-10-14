const statusEl = document.getElementById("status");

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
}

function toNetscape(cookies) {
  const lines = ["# Netscape HTTP Cookie File", "# gerado pela extensao Exportar cookies do YouTube", ""];
  for (const c of cookies) {
    const domain = c.domain || "";
    const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expiry = c.expirationDate ? Math.round(c.expirationDate) : 0;
    lines.push([domain, includeSub, c.path || "/", secure, expiry, c.name, c.value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

document.getElementById("go").addEventListener("click", async () => {
  try {
    setStatus("Lendo cookies...");
    const all = await chrome.cookies.getAll({});
    const cookies = all.filter(
      (c) => /(^|\.)youtube\.com$/.test(c.domain) || /(^|\.)google\.com$/.test(c.domain),
    );
    if (cookies.length === 0) {
      setStatus(
        "Nenhum cookie do YouTube/Google encontrado. Abra o youtube.com logado e tente de novo.",
        "err",
      );
      return;
    }
    const auth = cookies.filter((c) =>
      /^(SID|HSID|SSID|APISID|SAPISID|__Secure-1PSID|__Secure-3PSID|__Secure-1PAPISID|__Secure-3PAPISID|LOGIN_INFO)$/.test(
        c.name,
      ),
    );
    const blob = new Blob([toNetscape(cookies)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cookies.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(
      `${cookies.length} cookies exportados (${auth.length} de login).\nArquivo salvo como cookies.txt na pasta Downloads.`,
      "ok",
    );
  } catch (e) {
    setStatus("Erro: " + (e && e.message ? e.message : String(e)), "err");
  }
});
