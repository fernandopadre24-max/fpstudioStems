import qrcode from "qrcode-generator";

// Dados do recebedor usados para montar o "PIX Copia e Cola" (BR Code) e o QR.
export const PIX_RECEIVER = "Jose Fernando A. Sena";
export const PIX_CITY = "SALVADOR";
export const PIX_BANK = "Nubank";
export const PIX_KEY = "36790486534"; // chave PIX do tipo CPF
export const PIX_KEY_LABEL = "367.904.865-34";

function sanitize(text: string, max: number): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .trim()
    .slice(0, max)
    .toUpperCase();
}

function tlv(id: string, value: string): string {
  return `${id}${value.length.toString().padStart(2, "0")}${value}`;
}

// CRC16-CCITT (polinomio 0x1021, inicial 0xFFFF) exigido pelo BR Code.
function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

// Monta o payload EMV do PIX estatico, sem valor definido (qualquer valor).
export function buildPixPayload(): string {
  const merchantAccount = tlv("00", "br.gov.bcb.pix") + tlv("01", PIX_KEY);
  const body =
    tlv("00", "01") +
    tlv("26", merchantAccount) +
    tlv("52", "0000") +
    tlv("53", "986") +
    tlv("58", "BR") +
    tlv("59", sanitize(PIX_RECEIVER, 25)) +
    tlv("60", sanitize(PIX_CITY, 15)) +
    tlv("62", tlv("05", "***"));
  const withCrcId = `${body}6304`;
  return withCrcId + crc16(withCrcId);
}

export interface QrMatrix {
  size: number;
  path: string;
}

// Gera a matriz do QR como um unico <path> SVG (modulos escuros), pronto para
// renderizar sem canvas.
export function buildPixQr(): QrMatrix {
  const qr = qrcode(0, "M");
  qr.addData(buildPixPayload());
  qr.make();
  const size = qr.getModuleCount();
  let path = "";
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }
  return { size, path };
}
