import { useEffect, useRef, useState } from "react";

interface ScoreViewProps {
  abc: string;
  scale?: number;
  /** Largura fixa do pentagrama (px). Sem isso, usa a largura do container. */
  staffWidth?: number;
  /** Cor do desenho (pentagrama, notas, cifra). */
  color?: string;
}

// Margem que o abcjs soma a largura do pentagrama ao calcular o SVG.
const ABC_MARGIN = 30;

// abcjs e carregado sob demanda (dynamic import) para nao pesar no bundle
// inicial; so baixa quando a primeira partitura for desenhada.
export function ScoreView({ abc, scale = 1.15, staffWidth, color = "#e7ecf7" }: ScoreViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // O abcjs so quebra a pauta em varias linhas (com varios compassos cada)
  // quando recebe `staffwidth` + `wrap`. Sem isso, ele respeita as quebras de
  // linha do ABC e cada compasso acaba num pentagrama proprio.
  useEffect(() => {
    const element = ref.current;
    if (!element || staffWidth) return;
    const measure = () => setContainerWidth(Math.round(element.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [staffWidth]);

  const width = staffWidth ?? containerWidth;

  useEffect(() => {
    const element = ref.current;
    if (!element || width <= 0) return;
    let cancelled = false;
    element.innerHTML = "";

    import("abcjs")
      .then((mod) => {
        if (cancelled || !ref.current) return;
        const abcjs = ((mod as { default?: unknown }).default ?? mod) as {
          renderAbc: (
            target: HTMLElement,
            code: string,
            params?: Record<string, unknown>,
          ) => unknown;
        };
        abcjs.renderAbc(ref.current, abc, {
          staffwidth: Math.max(200, width - ABC_MARGIN),
          wrap: { minSpacing: 1.8, maxSpacing: 2.6 },
          scale,
          add_classes: true,
          foregroundColor: color,
          paddingtop: 4,
          paddingbottom: 4,
          paddingleft: 0,
          paddingright: 0,
        });
      })
      .catch((error) => {
        if (ref.current) ref.current.textContent = "Não foi possível desenhar a partitura.";
        console.error(error);
      });

    return () => {
      cancelled = true;
    };
  }, [abc, scale, width, color]);

  return <div className="score-view" ref={ref} />;
}
