import { useEffect, useRef } from "react";

interface ScoreViewProps {
  abc: string;
  scale?: number;
  /** Largura fixa do pentagrama (px). Sem isso, usa 100% do container. */
  staffWidth?: number;
  /** Cor do desenho (pentagrama, notas, cifra). */
  color?: string;
}

// abcjs e carregado sob demanda (dynamic import) para nao pesar no bundle
// inicial; so baixa quando a primeira partitura for desenhada.
export function ScoreView({ abc, scale = 1.15, staffWidth, color = "#e7ecf7" }: ScoreViewProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
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
          responsive: staffWidth ? undefined : "resize",
          staffwidth: staffWidth,
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
  }, [abc, scale, staffWidth, color]);

  return <div className="score-view" ref={ref} />;
}
