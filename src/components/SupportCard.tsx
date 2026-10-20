import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildPixPayload,
  buildPixQr,
  PIX_BANK,
  PIX_CITY,
  PIX_KEY,
  PIX_RECEIVER,
} from "../lib/pix";

interface SupportCardProps {
  onClose: () => void;
}

function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value);
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } catch {
    /* copia indisponivel */
  }
  document.body.removeChild(area);
  return Promise.resolve();
}

export function SupportCard({ onClose }: SupportCardProps) {
  const payload = useMemo(() => buildPixPayload(), []);
  const qr = useMemo(() => buildPixQr(), []);
  const [copied, setCopied] = useState<"key" | "payload" | null>(null);

  const maskedKey = useMemo(() => {
    const v = PIX_KEY.replace(/\D/g, "");
    if (v.length === 11) {
      return `***.***.${v.slice(6, 9)}-${v.slice(9, 11)}`;
    }
    if (v.length >= 4) {
      return `***${v.slice(-4)}`;
    }
    return v;
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = useCallback((value: string, which: "key" | "payload") => {
    void copyText(value);
    setCopied(which);
    window.setTimeout(() => {
      setCopied((current) => (current === which ? null : current));
    }, 1800);
  }, []);

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Apoie o projeto"
      onClick={onClose}
    >
      <div className="support-card" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="support-close"
          onClick={onClose}
          aria-label="Fechar"
          title="Fechar"
        >
          ×
        </button>

        <div className="support-head">
          <span className="support-heart" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 21s-7.5-4.6-10-9.3C.4 8.3 2 5 5.4 5c2 0 3.3 1.1 4.1 2.3l.5.8.5-.8C11.3 6.1 12.6 5 14.6 5 18 5 19.6 8.3 22 11.7 19.5 16.4 12 21 12 21z" />
            </svg>
          </span>
          <div>
            <h2>Apoie o FPStudio - Stems</h2>
            <p>
              Se o app te ajudou, considere apoiar o desenvolvimento. Qualquer valor e bem-vindo —
              obrigado!
            </p>
          </div>
        </div>

        <div className="support-body">
          <div className="support-info">
            <h3>Sobre o sistema</h3>
            <ul>
              <li>
                <b>FPStudio - Stems v.0.1 - 2027</b> (Beta)
              </li>
              <li>Separa a musica em trilhas: voz, bateria, baixo e outros.</li>
              <li>Processamento 100% no seu navegador — nada e enviado a servidores.</li>
              <li>Tambem busca no YouTube, letra, cifra (Cifra Club) e harmonia.</li>
              <li>Editor de trilhas com corte A/B e exportacao em WAV/MP3.</li>
            </ul>
            <p className="support-dev">
              Fernando Sena Desenvolvimento em Geral — FPStudio Gravaçoes.
            </p>
          </div>

          <div className="support-pix">
            <div className="support-qr">
              <svg
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                shapeRendering="crispEdges"
                role="img"
                aria-label="QR Code para doacao via PIX"
              >
                <rect width={qr.size} height={qr.size} fill="#ffffff" />
                <path d={qr.path} fill="#000000" />
              </svg>
            </div>

            <div className="support-pix-data">
              <span className="support-label">Chave PIX (CPF)</span>
              <code title="A chave completa é copiada ao usar os botões abaixo">
                {maskedKey}
              </code>
              <span className="support-label">Recebedor</span>
              <code>{PIX_RECEIVER}</code>
              <span className="support-label">Banco</span>
              <code>{PIX_BANK}</code>
              <span className="support-label">Agência</span>
              <code>0001</code>
              <span className="support-label">Conta</span>
              <code>4685093-0</code>
              <span className="support-label">Cidade</span>
              <code>{PIX_CITY}</code>

              <p className="support-hint">
                Abra o app do seu banco, aponte a camera para o QR — ou copie a chave / o codigo
                abaixo.
              </p>

              <div className="support-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => copy(PIX_KEY, "key")}
                >
                  {copied === "key" ? "Chave copiada!" : "Copiar chave PIX"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => copy(payload, "payload")}
                >
                  {copied === "payload" ? "Codigo copiado!" : "PIX copia e cola"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
