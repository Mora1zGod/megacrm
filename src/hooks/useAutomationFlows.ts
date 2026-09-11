import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import type { Node, Edge } from '@xyflow/react';

export interface FlowDefinition {
  nodes: Node[];
  edges: Edge[];
}

export interface AutomationFlow {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  definition: FlowDefinition;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function useAutomationFlows() {
  const [flows, setFlows] = useState<AutomationFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await getSupabase()
      .from('automation_flows')
      .select('*')
      .order('updated_at', { ascending: false });
    if (err) setError(err.message);
    else setFlows((data ?? []) as AutomationFlow[]);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const createFlow = useCallback(async (name: string) => {
    const { data, error: err } = await getSupabase()
      .from('automation_flows')
      .insert({ name, definition: { nodes: [], edges: [] } })
      .select('*')
      .single();
    if (err) throw new Error(err.message);
    await load();
    return data as AutomationFlow;
  }, [load]);

  const saveDefinition = useCallback(async (id: string, definition: FlowDefinition) => {
    const { error: err } = await getSupabase()
      .from('automation_flows')
      .update({ definition, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (err) throw new Error(err.message);
  }, []);

  const renameFlow = useCallback(async (id: string, name: string, description?: string) => {
    const { error: err } = await getSupabase()
      .from('automation_flows')
      .update({ name, description })
      .eq('id', id);
    if (err) throw new Error(err.message);
    await load();
  }, [load]);

  const duplicateFlow = useCallback(async (flow: AutomationFlow) => {
    // Duplicar SEMPRE gera rascunho, mesmo que a original esteja "ativa" (o
    // campo existe, mas nada é executado hoje).
    const { error: err } = await getSupabase()
      .from('automation_flows')
      .insert({ name: `${flow.name} (cópia)`, description: flow.description, status: 'draft', definition: flow.definition });
    if (err) throw new Error(err.message);
    await load();
  }, [load]);

  const archiveFlow = useCallback(async (id: string) => {
    const { error: err } = await getSupabase().from('automation_flows').update({ status: 'archived' }).eq('id', id);
    if (err) throw new Error(err.message);
    await load();
  }, [load]);

  return { flows, loading, error, reload: load, createFlow, saveDefinition, renameFlow, duplicateFlow, archiveFlow };
}
