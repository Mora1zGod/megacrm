// Peças do topo no CELULAR (< 768 px). O topo mede a própria altura e grava em --mh
// (ver Header → MobileTop); os painéis abrem logo abaixo dele, ocupando a largura da tela.
export const MOBILE_BTN =
  'relative grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[0_1px_2px_rgba(15,27,46,0.06)] transition-colors active:scale-[0.97] hover:bg-[var(--color-surface-hover)]';
export const MOBILE_PANEL =
  'fixed inset-x-3 top-[calc(var(--mh,120px)+6px)] w-auto max-w-none max-h-[calc(100dvh-var(--mh,120px)-20px)] overflow-y-auto';
