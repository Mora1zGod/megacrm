import { useCallback, useEffect, useState } from 'react';
import { Download, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';

// Visualizador de imagem em tela cheia.
//
// Motivo de existir: os contatos mandam documento fotografado (contrato de
// passaporte, comprovante, RG). Na miniatura de 256px é impossível LER — e ler
// é justamente o que o operador precisa fazer para conferir o cadastro.
//
// Rotação importa tanto quanto o zoom: foto de documento chega deitada com
// frequência, e girar a cabeça não é opção.
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);

  const maisZoom = useCallback(() => setZoom((z) => Math.min(z + 0.5, 5)), []);
  const menosZoom = useCallback(() => setZoom((z) => Math.max(z - 0.5, 0.5)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') maisZoom();
      if (e.key === '-') menosZoom();
      if (e.key.toLowerCase() === 'r') setRot((r) => (r + 90) % 360);
    };
    window.addEventListener('keydown', onKey);
    // Trava o scroll do fundo enquanto o visualizador está aberto.
    const overflowAnterior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflowAnterior;
    };
  }, [onClose, maisZoom, menosZoom]);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/90"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <div
        className="flex items-center justify-end gap-1 p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <BotaoBarra onClick={menosZoom} label="Diminuir zoom"><ZoomOut className="h-4 w-4" /></BotaoBarra>
        <span className="min-w-[3rem] text-center text-xs text-white/70">{Math.round(zoom * 100)}%</span>
        <BotaoBarra onClick={maisZoom} label="Aumentar zoom"><ZoomIn className="h-4 w-4" /></BotaoBarra>
        <BotaoBarra onClick={() => setRot((r) => (r + 90) % 360)} label="Girar"><RotateCw className="h-4 w-4" /></BotaoBarra>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          download
          onClick={(e) => e.stopPropagation()}
          aria-label="Baixar imagem"
          className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white"
        >
          <Download className="h-4 w-4" />
        </a>
        <BotaoBarra onClick={onClose} label="Fechar"><X className="h-5 w-5" /></BotaoBarra>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        <img
          src={src}
          alt={alt}
          onClick={(e) => {
            e.stopPropagation();
            // Clique na imagem alterna entre 1x e 2x — o gesto que a pessoa
            // tenta primeiro, sem precisar mirar nos botões.
            setZoom((z) => (z === 1 ? 2 : 1));
          }}
          className="mx-auto cursor-zoom-in select-none"
          style={{
            transform: `scale(${zoom}) rotate(${rot}deg)`,
            transformOrigin: 'center center',
            transition: 'transform 120ms ease-out',
            maxWidth: zoom === 1 ? '100%' : 'none',
            maxHeight: zoom === 1 ? '100%' : 'none',
          }}
        />
      </div>

      <p className="pb-3 text-center text-[0.7rem] text-white/40">
        Esc fecha · R gira · + / − zoom
      </p>
    </div>
  );
}

function BotaoBarra({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}
