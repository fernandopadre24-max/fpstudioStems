// Imprime um QR code no terminal para uma URL, usando os blocos Unicode.
// Uso: node scripts/print-qr.mjs "https://algo.trycloudflare.com"
//
// Usado pelo abrir-app.ps1 para o usuario escanear a URL com o celular.
import qrcode from "qrcode-generator";

const url = process.argv[2];
if (!url) {
  console.error("uso: node scripts/print-qr.mjs <url>");
  process.exit(1);
}

const qr = qrcode(0, "M");
qr.addData(url);
qr.make();

const size = qr.getModuleCount();
const quiet = 2;
const width = size + quiet * 2;

const isDark = (row, col) => {
  const r = row - quiet;
  const c = col - quiet;
  if (r < 0 || c < 0 || r >= size || c >= size) return false;
  return qr.isDark(r, c);
};

const lines = [];
for (let i = 0; i < quiet; i++) lines.push(" ".repeat(width));

// Dois modulos por linha, usando blocos de meia altura (▀ ▄ █).
for (let row = 0; row < size + quiet * 2; row += 2) {
  let line = "";
  for (let col = 0; col < width; col++) {
    const top = isDark(row, col);
    const bottom = isDark(row + 1, col);
    line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
  }
  lines.push(line);
}
for (let i = 0; i < quiet; i++) lines.push(" ".repeat(width));

process.stdout.write(lines.join("\n") + "\n");
