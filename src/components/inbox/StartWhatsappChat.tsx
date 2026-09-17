import { useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink, Search } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { getSupabase } from '@/lib/supabase';

interface StartWhatsappChatProps {
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
}

type Resultado =
  | { tipo: 'existente'; conversationId: string; nome: string | null }
  | { tipo: 'novo'; phone: string; contactId: string }
  | null;

// Normaliza para E.164 brasileiro. Aceita "(68) 99975-5247", "68999755247",
// "+55 68 99975 5247" etc.
function normalizarTelefone(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `+${d}`;
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  if (d.length > 13) return null;
  return `+${d}`;
}

export function StartWhatsappChat({ onClose, onOpenConversation }: StartWhatsappChatProps) {
  const [input, setInput] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [resultado, setResultado] = useState<Resultado>(null);

  const buscar = async () => {
    const phone = normalizarTelefone(input);
    if (!phone) {
      toast.error('Número inválido.', { description: 'Ex.: (68) 99975-5247' });
      return;
    }
    setBuscando(true);
    setResultado(null);
    const supabase = getSupabase();

    // Já existe contato com esse telefone?
    const { data: contato } = await supabase
      .from('contacts')
      .select('id, name')
      .eq('phone', phone)
      .maybeSingle();

    let contactId = (contato as { id: string; name: string | null } | null)?.id ?? null;
    const nome = (contato as { id: string; name: string | null } | null)?.name ?? null;

    if (contactId) {
      // Existe conversa de WhatsApp com ele?
      const { data: conv } = await supabase
        .from('conversations')
        .select('id')
        .eq('contact_id', contactId)
        .eq('channel', 'whatsapp')
        .maybeSingle();
      const conversationId = (conv as { id: string } | null)?.id ?? null;
      if (conversationId) {
        setResultado({ tipo: 'existente', conversationId, nome });
        setBuscando(false);
        return;
      }
    } else {
      // Cadastra o contato para o número não se perder.
      const { data: novo, error } = await supabase
        .from('contacts')
        .insert({ phone, name: null, source: 'whatsapp' })
        .select('id')
        .single();
      if (error) {
        toast.error('Não foi possível cadastrar o contato.', { description: error.message });
        setBuscando(false);
        return;
      }
      contactId = (novo as { id: string }).id;
    }

    setResultado({ tipo: 'novo', phone, contactId: contactId! });
    setBuscando(false);
  };

  return (
    <Dialog open onClose={onClose} title="Iniciar conversa no WhatsApp" widthClass="max-w-md">
      <div className="space-y-3">
        <div>
          <Label htmlFor="swc-phone">Número de WhatsApp</Label>
          <div className="flex gap-2">
            <input
              id="swc-phone"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void buscar(); }}
              placeholder="(68) 99975-5247"
              className="flex-1 rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)]"
            />
            <Button onClick={() => void buscar()} disabled={buscando || !input.trim()}>
              <Search className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {resultado?.tipo === 'existente' && (
          <div className="rounded-lg border border-[rgba(14,154,160,0.25)] bg-[rgba(14,154,160,0.06)] p-3 text-sm">
            <p className="mb-2">
              Já existe conversa com {resultado.nome?.trim() || 'este número'}.
            </p>
            <Button
              className="w-full"
              onClick={() => { onOpenConversation(resultado.conversationId); onClose(); }}
            >
              Abrir conversa
            </Button>
          </div>
        )}

        {resultado?.tipo === 'novo' && (
          <div className="space-y-3">
            <div className="rounded-lg border border-[rgba(242,185,55,0.3)] bg-[rgba(242,185,55,0.06)] p-3 text-xs text-[#F2B937]">
              <p className="font-semibold mb-1">Esse número nunca escreveu pra você.</p>
              <p>
                O WhatsApp não permite que a empresa mande a primeira mensagem em texto livre —
                só com um template aprovado pela Meta. Enquanto o template não sai, use o botão
                abaixo para falar pelo seu próprio WhatsApp.
              </p>
            </div>
            <p className="text-xs text-[var(--color-text-secondary)]">
              O contato já foi salvo no CRM. Quando ele responder, a conversa aparece aqui
              automaticamente e a AMAIA assume.
            </p>
            <a
              href={`https://wa.me/${resultado.phone.replace(/\D/g, '')}`}
              target="_blank"
              rel="noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white"
              style={{ background: 'var(--cta)' }}
            >
              <ExternalLink className="h-4 w-4" />
              Abrir no WhatsApp
            </a>
          </div>
        )}
      </div>
    </Dialog>
  );
}
