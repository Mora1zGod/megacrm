// Formatos brasileiros usados em todo o sistema (exibição e digitação).
import { formatPhoneDisplay, maskPhoneBR } from './phone';

export const onlyDigits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

// CPF/CNPJ enquanto digita: até 11 números = CPF, depois CNPJ.
export function maskDoc(raw: string | null | undefined): string {
  const d = onlyDigits(raw).slice(0, 14);
  if (d.length <= 11) {
    return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}
export function maskCNPJ(raw: string | null | undefined): string {
  const d = onlyDigits(raw).slice(0, 14);
  if (d.length <= 11 && d.length > 0) {
    return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2');
  }
  return maskDoc(d);
}

// Exibição de CPF/CNPJ completo; "—" quando vazio.
export function formatDoc(doc: string | null | undefined): string {
  const d = onlyDigits(doc);
  if (!d) return '—';
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  return doc ?? '—';
}

export function maskCEP(raw: string | null | undefined): string {
  const d = onlyDigits(raw).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}
export function formatCEP(raw: string | null | undefined): string {
  const d = onlyDigits(raw);
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : (raw ?? '');
}

// Telefone para exibir: "(68) 99942-8493"; estrangeiro fica como está.
export const formatPhone = formatPhoneDisplay;

// Máscara de telefone para campos que guardam no formato internacional (+55…):
// mostra "(68) 99942-8493" e mantém +código para números de fora.
export function maskPhoneInput(raw: string): string {
  const t = raw.trimStart();
  if (t.startsWith('+') && !t.startsWith('+55')) return t;
  const d = onlyDigits(t.startsWith('+55') ? t.slice(3) : t);
  return maskPhoneBR(d);
}
