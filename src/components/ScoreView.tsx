import { useCallback, useEffect, useRef, useState } from "react";

interface ScoreViewProps {
  abc: string;
  scale?: number;
  /** Largura fixa do pentagrama (px). Sem isso, usa a largura do container. */
  staffWidth?: number;
  /** Cor do desenho (pentagrama, notas, cifra). */
  color?: string;
  /** Posicao da reproducao (s) para a linha do compasso. `null` esconde a linha. */
  playhead?: number | null;
  /** Instante (s) em que comeca o compasso 1. */
  playheadOffset?: number;
  /** Duracao de um compasso (s). */
  measureSeconds?: number;
}

// Margem que o abcjs soma a largura do pentagrama ao calcular o SVG.
const ABC_MARGIN = 30;

const SVG_NS = "http://www.w3.org/2000/svg";

function lineIndexOf(element: Element): number {
  const match = /abcjs-l(\d+)/.exec(element.getAttribute("class") ?? "");
  return match ? Number(match[1]) : 0;
}

// abcjs e carregado sob demanda (dynamic import) para nao pesar no bundle
// inicial; so baixa quando a primeira partitura for desenhada.
export function ScoreView({
  abc,
  scale = 1.15,
  staffWidth,
  color = "#e7ecf7",
  playhead = null,
  playheadOffset = 0,
  measureSeconds = 0,
}: ScoreViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const cursorRef = useRef<SVGLineElement | null>(null);
  const shadeRef = useRef<SVGRectElement | null>(null);
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

  // Posiciona a linha do compasso atual dentro do SVG. Usa as caixas dos
  // elementos `.abcjs-m<N>` (notas + barra) e converte de pixels de tela para
  // coordenadas do SVG, o que funciona mesmo com o layout escalado.
  const updateCursor = useCallback(() => {
    const svg = svgRef.current;
    const line = cursorRef.current;
    const shade = shadeRef.current;
    if (!svg || !line || !shade) return;

    const hide = () => {
      line.style.display = "none";
      shade.style.display = "none";
    };

    if (playhead === null || playhead === undefined || !(measureSeconds > 0)) {
      hide();
      return;
    }

    const position = (playhead - playheadOffset) / measureSeconds;
    const index = Math.floor(position);
    if (index < 0) {
      hide();
      return;
    }

    // `abcjs-m<N>` e o compasso dentro da linha (recomeca a contar em cada
    // sistema); `abcjs-mm<N>` e o compasso absoluto, que e o que corresponde ao
    // tempo. Com `m` a agulha so andava no primeiro sistema e parava depois.
    const parts = svg.querySelectorAll(`.abcjs-mm${index}`);
    const matrix = svg.getScreenCTM();
    if (parts.length === 0 || !matrix) {
      hide();
      return;
    }
    const inverse = matrix.inverse();
    const toLocal = (x: number, y: number) => {
      const point = svg.createSVGPoint();
      point.x = x;
      point.y = y;
      return point.matrixTransform(inverse);
    };

    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    let lineIndex = 0;
    parts.forEach((part, partIndex) => {
      const box = part.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return;
      const start = toLocal(box.left, box.top);
      const end = toLocal(box.right, box.bottom);
      left = Math.min(left, start.x);
      right = Math.max(right, end.x);
      if (partIndex === 0) lineIndex = lineIndexOf(part);
    });
    if (!Number.isFinite(left) || right <= left) {
      hide();
      return;
    }

    // A altura vem do pentagrama da mesma linha (sistema) do compasso.
    const staff = svg.querySelector(`.abcjs-staff.abcjs-l${lineIndex}`);
    if (staff) {
      const box = staff.getBoundingClientRect();
      top = toLocal(box.left, box.top).y;
      bottom = toLocal(box.right, box.bottom).y;
    } else {
      top = 0;
      bottom = 0;
    }

    const fraction = position - index;
    const x = left + fraction * (right - left);
    line.setAttribute("x1", String(x));
    line.setAttribute("x2", String(x));
    line.setAttribute("y1", String(top - 3));
    line.setAttribute("y2", String(bottom + 3));
    line.style.display = "";

    shade.setAttribute("x", String(left));
    shade.setAttribute("y", String(top - 3));
    shade.setAttribute("width", String(right - left));
    shade.setAttribute("height", String(Math.max(0, bottom - top + 6)));
    shade.style.display = "";
  }, [measureSeconds, playhead, playheadOffset]);

  // O efeito de desenho nao pode depender do cursor (que muda a cada quadro),
  // senao o abcjs redesenha a partitura inteira 60x por segundo.
  const updateRef = useRef(updateCursor);
  updateRef.current = updateCursor;

  useEffect(() => {
    updateCursor();
  }, [updateCursor]);

  useEffect(() => {
    const element = ref.current;
    if (!element || width <= 0) return;
    let cancelled = false;
    element.innerHTML = "";
    svgRef.current = null;
    cursorRef.current = null;
    shadeRef.current = null;

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
          // O abcjs desenha com `scale` (transform) e usa `staffwidth` como a
          // largura do proprio SVG; dividir pela escala faz a pauta caber
          // exatamente na largura disponivel, sem rolagem horizontal.
          staffwidth: Math.max(200, width / scale - ABC_MARGIN),
          // Espacamento entre notas. Com valores altos o abcjs coloca poucos
          // compassos por linha (2 no celular); assim ficam 3-4, como numa
          // edicao normal.
          wrap: { minSpacing: 1.2, maxSpacing: 2.2 },
          scale,
          add_classes: true,
          foregroundColor: color,
          paddingtop: 4,
          paddingbottom: 4,
          paddingleft: 0,
          paddingright: 0,
        });
        const svg = ref.current.querySelector("svg");
        if (!svg) return;
        svgRef.current = svg;
        // O realce fica atras do desenho e a linha, na frente.
        const shade = document.createElementNS(SVG_NS, "rect") as SVGRectElement;
        shade.setAttribute("class", "score-measure-shade");
        shade.setAttribute("rx", "3");
        shade.style.display = "none";
        svg.insertBefore(shade, svg.firstChild);
        const line = document.createElementNS(SVG_NS, "line") as SVGLineElement;
        line.setAttribute("class", "score-playhead");
        line.style.display = "none";
        svg.appendChild(line);
        shadeRef.current = shade;
        cursorRef.current = line;
        updateRef.current();
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
