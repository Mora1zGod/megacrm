import type { Board } from '@/hooks/useBoards';

// Fundos de quadro (boards.color guarda a chave; cor hex antiga também funciona).
export const BOARD_BG: Record<string, string> = {
  noite: 'linear-gradient(160deg,#0c1a33 0%,#1d3557 45%,#3a506b 100%)',
  oceano: 'linear-gradient(135deg,#0c66e4 0%,#09326c 100%)',
  lagoa: 'linear-gradient(135deg,#1f845a 0%,#0b4f6c 100%)',
  por_do_sol: 'linear-gradient(135deg,#f87168 0%,#a54800 100%)',
  uva: 'linear-gradient(135deg,#6e5dc6 0%,#352c63 100%)',
  rosa: 'linear-gradient(135deg,#e774bb 0%,#943d73 100%)',
  grafite: 'linear-gradient(135deg,#596773 0%,#22272b 100%)',
  ceu: 'linear-gradient(135deg,#579dff 0%,#9f8fef 100%)',
};
export const boardBg = (b: Pick<Board, 'color'> | null | undefined) =>
  !b?.color ? BOARD_BG.noite : BOARD_BG[b.color] ?? (/^#[0-9a-f]{6}$/i.test(b.color) ? b.color : BOARD_BG.noite);
