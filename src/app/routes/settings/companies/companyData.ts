import { getSupabase } from '@/lib/supabase';

// Empresa do grupo (fin_companies) com o cadastro completo de 20261008190000_company_settings.sql.
export interface CompanyRow {
  id: string; name: string; cnpj: string | null; is_active: boolean; is_default: boolean; created_at: string; updated_at: string;
  legal_name: string | null; person_type: 'pj' | 'pf'; state_registration: string | null; municipal_registration: string | null;
  phone: string | null; email: string | null; website: string | null; logo_url: string | null;
  zip_code: string | null; street: string | null; street_number: string | null; complement: string | null; district: string | null;
  city: string | null; state: string | null; founded_on: string | null; legal_status: string | null; notes: string | null;
  cnpj_data: Record<string, unknown> | null; cnpj_checked_at: string | null;
  tax_regime: 'mei' | 'simples' | 'simples_excesso' | 'presumido' | 'real' | null; main_activity: string | null;
  secondary_activities: string[]; service_code: string | null; fiscal_env: 'production' | 'homologation';
  nfe_series: number | null; nfce_series: number | null; nfse_series: number | null; tax_settings: Record<string, unknown>;
  pix_key: string | null; default_account_id: string | null; default_cost_center_id: string | null; default_chart_account_id: string | null;
  default_payment_method: string | null;
  purchase_location_id: string | null; purchase_cost_center_id: string | null; purchase_chart_account_id: string | null;
  purchase_account_id: string | null; purchase_requires_approval: boolean; purchase_limit_cents: number | null;
  purchase_manager_id: string | null; purchase_rules: Record<string, unknown>;
}

export const TAX_REGIME: Record<string, string> = {
  mei: 'MEI', simples: 'Simples Nacional', simples_excesso: 'Simples Nacional — excesso de sublimite',
  presumido: 'Lucro Presumido', real: 'Lucro Real',
};
export const PAYMENT_METHOD: Record<string, string> = {
  pix: 'PIX', boleto: 'Boleto', transferencia: 'Transferência', cartao: 'Cartão', dinheiro: 'Dinheiro', debito_automatico: 'Débito automático',
};

// Tradução das mensagens do banco (fin_fail já vem em português).
export function companyError(e: unknown): string {
  const m = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
  if (/fin_company_update|function .* does not exist|schema cache/i.test(m)) return 'Falta rodar o SQL das Empresas (company_settings) no Supabase.';
  return m;
}

export async function updateCompany(id: string, patch: Record<string, unknown>) {
  const { error } = await getSupabase().rpc('fin_company_update', { p_id: id, p: patch });
  if (error) throw new Error(companyError(error));
}
