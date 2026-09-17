import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

export interface OrgBranding {
  id: string;
  name: string | null;
  logo_url: string | null;
  theme_mode: 'dark' | 'light';
}

export function useOrgBranding() {
  // orgId do contexto (não da sessão crua): em modo suporte, é o id da org
  // sendo atendida (ex.: AMAI PARK), não da "Organização Principal" do
  // super admin — mesmo padrão que o próprio AppUserProvider já usa pra
  // buscar name/status/theme_mode. Sem esse filtro, RLS de super admin
  // pode expor mais de uma linha e o .single() abaixo quebra.
  const { orgId } = useAppUser();
  const [branding, setBranding] = useState<OrgBranding | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) {
      setBranding(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await getSupabase()
      .schema('whatsapp_hub')
      .from('organizations')
      .select('id, name, logo_url, theme_mode')
      .eq('id', orgId)
      .single();
    if (err) setError(err.message);
    else setBranding(data as OrgBranding);
    setLoading(false);
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (patch: Partial<Pick<OrgBranding, 'name' | 'theme_mode'>>) => {
    if (!branding) throw new Error('Ainda carregando os dados da organização.');
    const { error: err } = await getSupabase()
      .schema('whatsapp_hub')
      .from('organizations')
      .update(patch)
      .eq('id', branding.id);
    if (err) throw new Error(err.message);
    await load();
  }, [branding, load]);

  const uploadLogo = useCallback(async (file: File) => {
    if (!branding) throw new Error('Ainda carregando os dados da organização.');
    const ext = file.name.split('.').pop() ?? 'png';
    const path = `${branding.id}/logo.${ext}`;
    const supabase = getSupabase();
    const { error: upErr } = await supabase.storage
      .from('org-branding')
      .upload(path, file, { upsert: true, cacheControl: '3600' });
    if (upErr) throw new Error(upErr.message);

    const { data: pub } = supabase.storage.from('org-branding').getPublicUrl(path);
    const url = `${pub.publicUrl}?v=${Date.now()}`;

    const { error: updErr } = await supabase
      .schema('whatsapp_hub')
      .from('organizations')
      .update({ logo_url: url })
      .eq('id', branding.id);
    if (updErr) throw new Error(updErr.message);
    await load();
  }, [branding, load]);

  return { branding, loading, error, save, uploadLogo, reload: load };
}
