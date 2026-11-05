import { useCallback, useEffect, useState } from 'react';
import { getSupabase, getSupabaseCredentials } from '@/lib/supabase';
import { friendlyError, type Company } from '../finance/data';

// Ponto (fase 1): funcionários, aparelhos iDFace e batidas — 20261105100000_ponto_base.sql.
export const PONTO_BUCKET = 'whatsapp-hub-ponto';

export interface Employee {
  id: string;
  org_id: string;
  company_id: string;
  name: string;
  cpf: string;
  registration: string | null;
  job_title: string | null;
  admission_date: string | null;
  dismissal_date: string | null;
  status: 'active' | 'inactive';
  device_user_id: number;
  photo_path: string | null;
  photo_synced_at: string | null;
  notes: string | null;
}

export interface Device {
  id: string;
  company_id: string;
  name: string;
  model: string;
  push_token: string;
  timezone: string;
  device_serial: string | null;
  last_seen_at: string | null;
  last_log_id: number;
  is_active: boolean;
}

export interface Mark {
  id: string;
  company_id: string;
  nsr: number;
  employee_id: string;
  cpf: string;
  marked_at: string;
  recorded_at: string;
  tz: string;
  device_id: string | null;
  collector: string;
  online: boolean;
  hash: string;
}

export interface DeviceLog {
  id: number;
  device_id: string;
  device_log_id: number;
  event: number | null;
  device_user_id: number | null;
  marked_at: string | null;
  mark_id: string | null;
  note: string | null;
  received_at: string;
}

export interface DeviceCmd {
  id: number;
  device_id: string;
  kind: string;
  employee_id: string | null;
  status: 'pending' | 'sent' | 'done' | 'error';
  error: string | null;
  created_at: string;
  done_at: string | null;
}

// Eventos do access_logs da Access API (Control iD).
export const EVENT_LABEL: Record<number, string> = {
  1: 'Equipamento inválido', 2: 'Regra inválida', 3: 'Não identificado', 4: 'Identificação pendente',
  5: 'Tempo esgotado', 6: 'Acesso negado', 7: 'Batida registrada', 8: 'Pendente (várias pessoas)',
  9: 'Menu sem administrador', 10: 'Liberado pela API', 11: 'Botão', 12: 'Interface web', 13: 'Cancelado',
  14: 'Sem resposta', 15: 'Interfone',
};

export const CMD_LABEL: Record<string, string> = {
  user_upsert: 'Cadastro do funcionário', user_photo: 'Foto do rosto', user_delete: 'Remover funcionário',
  set_time: 'Acertar hora', load_logs: 'Buscar batidas', raw: 'Comando',
};

export function pushUrl(token: string): string {
  const base = (getSupabaseCredentials()?.url ?? '').replace(/\/+$/, '');
  return `${base}/functions/v1/controlid-push/${token}`;
}

/** Data/hora no fuso do estabelecimento (o da batida), como o espelho/AFD mostram. */
export function fmtInTz(iso: string | null | undefined, tz: string, withSeconds = true): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  }).format(new Date(iso));
}

/** Dia (YYYY-MM-DD) de hoje num fuso. */
export function todayIn(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Início do dia local (YYYY-MM-DD) num fuso, em ISO UTC. Rio Branco: sem horário de verão. */
export function dayStartIso(day: string, tz: string): string {
  const guess = new Date(`${day}T00:00:00Z`);
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return new Date(guess.getTime() - (asUtc - guess.getTime())).toISOString();
}

export function validCpf(raw: string): boolean {
  const c = raw.replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(c[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

export interface PontoLookups {
  loading: boolean;
  error: string | null;
  missing: boolean; // SQL do ponto ainda não rodado
  companies: Company[];
  employees: Employee[];
  devices: Device[];
  reload: () => Promise<void>;
}

export function usePontoLookups(): PontoLookups {
  const [state, setState] = useState<Omit<PontoLookups, 'reload'>>({
    loading: true, error: null, missing: false, companies: [], employees: [], devices: [],
  });
  const reload = useCallback(async () => {
    const sb = getSupabase();
    const [c, e, d] = await Promise.all([
      sb.from('fin_companies').select('*').order('is_default', { ascending: false }).order('name'),
      sb.from('ponto_employees').select('*').order('name').limit(5000),
      sb.from('ponto_devices').select('id, company_id, name, model, push_token, timezone, device_serial, last_seen_at, last_log_id, is_active').order('name'),
    ]);
    const err = c.error ?? e.error ?? d.error;
    const missing = !!err && /does not exist|could not find|schema cache/i.test(err.message ?? '') && /ponto_/i.test(err.message ?? '');
    setState({
      loading: false,
      missing,
      error: err && !missing ? friendlyError(err) : null,
      companies: (c.data ?? []) as Company[],
      employees: (e.data ?? []) as Employee[],
      // sem ponto.manage o RLS devolve 0 aparelhos (só a lista some)
      devices: (d.data ?? []) as Device[],
    });
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { ...state, reload };
}

/** Link assinado (1 h) de uma foto do bucket privado do ponto. */
export function usePontoPhoto(path: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!path) return;
    void getSupabase().storage.from(PONTO_BUCKET).createSignedUrl(path, 3600).then(({ data }) => {
      if (alive) setUrl(data?.signedUrl ?? null);
    });
    return () => { alive = false; };
  }, [path]);
  return url;
}

/**
 * Foto do rosto para o iDFace: JPEG até 1 MB. Reduz para no máx. 720 px no lado maior (o aparelho não
 * precisa de mais) e baixa a qualidade até caber.
 */
export async function prepareFacePhoto(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 720 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Navegador sem suporte a imagem.');
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  for (const q of [0.9, 0.8, 0.7, 0.6, 0.5]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= 1_000_000) return blob;
  }
  throw new Error('A foto ficou maior que 1 MB. Use uma foto menor.');
}
