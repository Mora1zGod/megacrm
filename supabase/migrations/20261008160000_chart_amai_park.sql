-- ============================================================================
-- Plano de contas AMAI Park (substitui o plano básico semeado no Financeiro)
--
-- Por organização (menos as que têm "BELA" no nome — outro negócio):
--   * contas antigas SEM lançamento são apagadas;
--   * contas antigas COM lançamento (ou ligadas a item de estoque) não podem
--     sumir: vão para "98 PLANO ANTIGO — RECEITAS" / "99 PLANO ANTIGO —
--     DESPESAS", inativas (o histórico e os relatórios continuam certos);
--   * entra o plano novo.
-- Rodar de novo não muda nada (a org que já tem o plano novo é pulada).
-- Orgs criadas depois já nascem com este plano (fin_seed_org).
-- ============================================================================

-- Plano novo: (código, pai, nome, tipo, natureza, sintética, ativa)
CREATE OR REPLACE FUNCTION whatsapp_hub._fin_amai_chart()
RETURNS TABLE (code text, parent text, name text, type text, nature text, synthetic boolean, active boolean)
LANGUAGE sql IMMUTABLE
AS $$
  SELECT * FROM (VALUES
    ('1',     NULL,  'RECEITAS OPERACIONAIS',               'revenue', 'operating_revenue', true,  true),
    ('1.1',   '1',   'Venda de Ingressos / Passaportes',    'revenue', 'operating_revenue', true,  true),
    ('1.1.1', '1.1', 'Ingresso Individual Adulto',          'revenue', 'operating_revenue', false, true),
    ('1.1.2', '1.1', 'Ingresso Infantil',                   'revenue', 'operating_revenue', false, true),
    ('1.1.3', '1.1', 'Passaporte Diário',                   'revenue', 'operating_revenue', false, true),
    ('1.1.4', '1.1', 'Passaporte Mensal',                   'revenue', 'operating_revenue', false, true),
    ('1.1.5', '1.1', 'Passaporte Anual',                    'revenue', 'operating_revenue', false, true),
    ('1.1.6', '1.1', 'Meia-entrada / Convênios',            'revenue', 'operating_revenue', false, true),
    ('1.1.7', '1.1', 'Cortesias (controle, não receita)',   'revenue', 'operating_revenue', false, false),
    ('1.2',   '1',   'Consumo Interno',                     'revenue', 'operating_revenue', true,  true),
    ('1.2.1', '1.2', 'Restaurante',                         'revenue', 'operating_revenue', false, true),
    ('1.2.2', '1.2', 'Lanchonetes',                         'revenue', 'operating_revenue', false, true),
    ('1.2.3', '1.2', 'Quiosques',                           'revenue', 'operating_revenue', false, true),
    ('1.2.4', '1.2', 'Bebidas',                             'revenue', 'operating_revenue', false, true),
    ('1.2.5', '1.2', 'Sorvetes / Açaí',                     'revenue', 'operating_revenue', false, true),
    ('1.2.6', '1.2', 'Bar molhado',                         'revenue', 'operating_revenue', false, true),
    ('1.3',   '1',   'Serviços Adicionais',                 'revenue', 'operating_revenue', true,  true),
    ('1.3.1', '1.3', 'Aluguel de Boias',                    'revenue', 'operating_revenue', false, true),
    ('1.3.2', '1.3', 'Armários / Lockers',                  'revenue', 'operating_revenue', false, true),
    ('1.3.3', '1.3', 'Aluguel de Toalhas',                  'revenue', 'operating_revenue', false, true),
    ('1.3.4', '1.3', 'Áreas VIP / Bangalôs',                'revenue', 'operating_revenue', false, true),
    ('1.3.5', '1.3', 'Eventos e aniversários',              'revenue', 'operating_revenue', false, true),
    ('1.3.6', '1.3', 'Excursões / Escolas',                 'revenue', 'operating_revenue', false, true),
    ('1.4',   '1',   'Outras Receitas',                     'revenue', 'operating_revenue', true,  true),
    ('1.4.1', '1.4', 'Estacionamento',                      'revenue', 'operating_revenue', false, true),
    ('1.4.2', '1.4', 'Loja / Souvenirs',                    'revenue', 'operating_revenue', false, true),
    ('1.4.3', '1.4', 'Patrocínios',                         'revenue', 'operating_revenue', false, true),
    ('1.4.4', '1.4', 'Publicidade interna',                 'revenue', 'operating_revenue', false, true),

    ('2',     NULL,  'DEDUÇÕES',                            'expense', 'deduction', true,  true),
    ('2.1',   '2',   'Taxas de cartão',                     'expense', 'deduction', false, true),
    ('2.2',   '2',   'Taxas Pix / Gateways',                'expense', 'deduction', false, true),
    ('2.3',   '2',   'Descontos concedidos',                'expense', 'deduction', false, true),
    ('2.4',   '2',   'Cancelamentos / Estornos',            'expense', 'deduction', false, true),

    ('3',     NULL,  'CUSTOS OPERACIONAIS DIRETOS',         'expense', 'cost', true,  true),
    ('3.1',   '3',   'Alimentação',                         'expense', 'cost', true,  true),
    ('3.1.1', '3.1', 'Compras de alimentos',                'expense', 'cost', false, true),
    ('3.1.2', '3.1', 'Bebidas',                             'expense', 'cost', false, true),
    ('3.1.3', '3.1', 'Gás',                                 'expense', 'cost', false, true),
    ('3.1.4', '3.1', 'Embalagens',                          'expense', 'cost', false, true),
    ('3.2',   '3',   'Operação Aquática',                   'expense', 'cost', true,  true),
    ('3.2.1', '3.2', 'Tratamento de água',                  'expense', 'cost', false, true),
    ('3.2.2', '3.2', 'Produtos químicos piscina',           'expense', 'cost', false, true),
    ('3.2.3', '3.2', 'Limpeza de piscinas',                 'expense', 'cost', false, true),
    ('3.2.4', '3.2', 'Manutenção de bombas e filtros',      'expense', 'cost', false, true),
    ('3.3',   '3',   'Equipe Operacional Direta',           'expense', 'cost', true,  true),
    ('3.3.1', '3.3', 'Salva-vidas',                         'expense', 'cost', false, true),
    ('3.3.2', '3.3', 'Operadores de brinquedos',            'expense', 'cost', false, true),
    ('3.3.3', '3.3', 'Limpeza operacional',                 'expense', 'cost', false, true),
    ('3.3.4', '3.3', 'Temporários / Diaristas',             'expense', 'cost', false, true),
    ('3.4',   '3',   'Energia e Utilidades',                'expense', 'cost', true,  true),
    ('3.4.1', '3.4', 'Energia elétrica',                    'expense', 'cost', false, true),
    ('3.4.2', '3.4', 'Água',                                'expense', 'cost', false, true),
    ('3.4.3', '3.4', 'Gerador / Combustível',               'expense', 'cost', false, true),

    ('4',     NULL,  'DESPESAS ADMINISTRATIVAS',            'expense', 'operating_expense', true,  true),
    ('4.1',   '4',   'Pessoal Administrativo',              'expense', 'operating_expense', true,  true),
    ('4.1.1', '4.1', 'Administração',                       'expense', 'operating_expense', false, true),
    ('4.1.2', '4.1', 'Financeiro',                          'expense', 'operating_expense', false, true),
    ('4.1.3', '4.1', 'RH',                                  'expense', 'operating_expense', false, true),
    ('4.1.4', '4.1', 'TI / Sistemas',                       'expense', 'operating_expense', false, true),
    ('4.2',   '4',   'Despesas Gerais',                     'expense', 'operating_expense', true,  true),
    ('4.2.1', '4.2', 'Material de escritório',              'expense', 'operating_expense', false, true),
    ('4.2.2', '4.2', 'Internet / Telefonia',                'expense', 'operating_expense', false, true),
    ('4.2.3', '4.2', 'Softwares / Licenças',                'expense', 'operating_expense', false, true),
    ('4.2.4', '4.2', 'Contabilidade',                       'expense', 'operating_expense', false, true),
    ('4.2.5', '4.2', 'Jurídico',                            'expense', 'operating_expense', false, true),

    ('5',     NULL,  'MANUTENÇÃO E INFRAESTRUTURA',         'expense', 'operating_expense', true,  true),
    ('5.1',   '5',   'Manutenção elétrica',                 'expense', 'operating_expense', false, true),
    ('5.2',   '5',   'Manutenção hidráulica',               'expense', 'operating_expense', false, true),
    ('5.3',   '5',   'Manutenção de brinquedos',            'expense', 'operating_expense', false, true),
    ('5.4',   '5',   'Peças e reposições',                  'expense', 'operating_expense', false, true),
    ('5.5',   '5',   'Ferramentas',                         'expense', 'operating_expense', false, true),
    ('5.6',   '5',   'Segurança estrutural',                'expense', 'operating_expense', false, true),

    ('6',     NULL,  'MARKETING E COMERCIAL',               'expense', 'operating_expense', true,  true),
    ('6.1',   '6',   'Tráfego pago',                        'expense', 'operating_expense', false, true),
    ('6.2',   '6',   'Redes sociais',                       'expense', 'operating_expense', false, true),
    ('6.3',   '6',   'Impressos / Outdoors',                'expense', 'operating_expense', false, true),
    ('6.4',   '6',   'Promoções e campanhas',               'expense', 'operating_expense', false, true),
    ('6.5',   '6',   'Parcerias e comissões',               'expense', 'operating_expense', false, true),

    ('7',     NULL,  'SEGURANÇA E CONTROLE',                'expense', 'operating_expense', true,  true),
    ('7.1',   '7',   'CFTV',                                'expense', 'operating_expense', false, true),
    ('7.2',   '7',   'Manutenção de câmeras',               'expense', 'operating_expense', false, true),
    ('7.3',   '7',   'Controle de acesso',                  'expense', 'operating_expense', false, true),
    ('7.4',   '7',   'Portaria',                            'expense', 'operating_expense', false, true),
    ('7.5',   '7',   'Vigilância / Rondas',                 'expense', 'operating_expense', false, true),

    ('8',     NULL,  'IMPOSTOS E OBRIGAÇÕES',               'expense', 'tax', true,  true),
    ('8.1',   '8',   'Simples Nacional / Lucro Presumido',  'expense', 'tax', false, true),
    ('8.2',   '8',   'INSS',                                'expense', 'tax', false, true),
    ('8.3',   '8',   'FGTS',                                'expense', 'tax', false, true),
    ('8.4',   '8',   'Taxas municipais',                    'expense', 'tax', false, true),
    ('8.5',   '8',   'Licenças / Alvarás',                  'expense', 'tax', false, true),

    ('9',     NULL,  'INVESTIMENTOS (CAPEX)',               'expense', 'investment', true,  true),
    ('9.1',   '9',   'Novos brinquedos',                    'expense', 'investment', false, true),
    ('9.2',   '9',   'Obras e ampliações',                  'expense', 'investment', false, true),
    ('9.3',   '9',   'Equipamentos',                        'expense', 'investment', false, true),
    ('9.4',   '9',   'TI / Servidores / Rede',              'expense', 'investment', false, true),
    ('9.5',   '9',   'Veículos',                            'expense', 'investment', false, true),

    -- RESULTADOS: linhas calculadas pelo DRE (não recebem lançamento).
    ('10',    NULL,  'RESULTADOS (calculados no DRE)',      'revenue', 'operating_revenue', true, true),
    ('10.1',  '10',  'Lucro Operacional',                   'revenue', 'operating_revenue', true, true),
    ('10.2',  '10',  'Resultado Financeiro',                'revenue', 'operating_revenue', true, true),
    ('10.3',  '10',  'Lucro Líquido',                       'revenue', 'operating_revenue', true, true),
    ('10.4',  '10',  'Reserva / Caixa futuro',              'revenue', 'operating_revenue', true, true)
  ) AS t(code, parent, name, type, nature, synthetic, active)
$$;

-- Insere o plano novo numa org (assume que os códigos estão livres).
CREATE OR REPLACE FUNCTION whatsapp_hub._fin_insert_amai_chart(p_org uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE r record; v_parent uuid;
BEGIN
  FOR r IN SELECT * FROM whatsapp_hub._fin_amai_chart() LOOP
    v_parent := NULL;
    IF r.parent IS NOT NULL THEN
      SELECT id INTO v_parent FROM whatsapp_hub.fin_chart_accounts WHERE org_id = p_org AND code = r.parent;
    END IF;
    INSERT INTO whatsapp_hub.fin_chart_accounts (org_id, parent_id, code, name, type, nature, is_synthetic, is_active)
    VALUES (p_org, v_parent, r.code, r.name, r.type, r.nature, r.synthetic, r.active);
  END LOOP;
END
$$;

-- Troca o plano de uma org. Contas com uso vão para 98/99 (inativas).
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_replace_chart_amai(p_org uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_rev uuid; v_exp uuid; r record; n int := 0; v_kept int := 0; v_deleted int;
  v_has_inv boolean := to_regclass('whatsapp_hub.inv_items') IS NOT NULL;
BEGIN
  IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_chart_accounts WHERE org_id = p_org AND code = '10' AND name = 'RESULTADOS (calculados no DRE)') THEN
    RETURN 'já estava com o plano AMAI Park';
  END IF;

  -- 1) Contas usadas: guardar em 98/99, inativas.
  CREATE TEMP TABLE IF NOT EXISTS _fin_used (id uuid PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE _fin_used;
  INSERT INTO _fin_used SELECT DISTINCT chart_account_id FROM whatsapp_hub.fin_entries WHERE org_id = p_org ON CONFLICT DO NOTHING;
  IF v_has_inv THEN
    EXECUTE 'INSERT INTO _fin_used SELECT DISTINCT chart_account_id FROM whatsapp_hub.inv_items WHERE org_id = $1 AND chart_account_id IS NOT NULL ON CONFLICT DO NOTHING' USING p_org;
  END IF;

  IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_chart_accounts c JOIN _fin_used u ON u.id = c.id WHERE c.type = 'revenue') THEN
    INSERT INTO whatsapp_hub.fin_chart_accounts (org_id, code, name, type, nature, is_synthetic, is_active)
    VALUES (p_org, '98', 'PLANO ANTIGO — RECEITAS (só histórico)', 'revenue', 'operating_revenue', true, false)
    ON CONFLICT (org_id, code) DO NOTHING;
    SELECT id INTO v_rev FROM whatsapp_hub.fin_chart_accounts WHERE org_id = p_org AND code = '98';
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_chart_accounts c JOIN _fin_used u ON u.id = c.id WHERE c.type = 'expense') THEN
    INSERT INTO whatsapp_hub.fin_chart_accounts (org_id, code, name, type, nature, is_synthetic, is_active)
    VALUES (p_org, '99', 'PLANO ANTIGO — DESPESAS (só histórico)', 'expense', 'operating_expense', true, false)
    ON CONFLICT (org_id, code) DO NOTHING;
    SELECT id INTO v_exp FROM whatsapp_hub.fin_chart_accounts WHERE org_id = p_org AND code = '99';
  END IF;

  FOR r IN SELECT c.* FROM whatsapp_hub.fin_chart_accounts c JOIN _fin_used u ON u.id = c.id
            WHERE c.org_id = p_org AND c.code NOT IN ('98', '99') ORDER BY c.code LOOP
    n := n + 1;
    UPDATE whatsapp_hub.fin_chart_accounts
       SET parent_id = CASE WHEN r.type = 'revenue' THEN v_rev ELSE v_exp END,
           code = CASE WHEN r.type = 'revenue' THEN '98.' ELSE '99.' END || n,
           name = left(r.name || ' (antiga ' || r.code || ')', 200),
           is_active = false
     WHERE id = r.id;
    v_kept := v_kept + 1;
  END LOOP;

  -- 2) Apagar o resto do plano antigo (folhas primeiro).
  LOOP
    DELETE FROM whatsapp_hub.fin_chart_accounts c
     WHERE c.org_id = p_org AND c.code NOT IN ('98', '99') AND c.code NOT LIKE '98.%' AND c.code NOT LIKE '99.%'
       AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_chart_accounts k WHERE k.parent_id = c.id);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    EXIT WHEN v_deleted = 0;
  END LOOP;

  -- 3) Plano novo.
  PERFORM whatsapp_hub._fin_insert_amai_chart(p_org);
  RETURN format('plano AMAI Park aplicado; %s conta(s) antiga(s) com lançamento guardada(s) em 98/99', v_kept);
END
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.fin_replace_chart_amai(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._fin_insert_amai_chart(uuid) FROM PUBLIC, anon, authenticated;

-- Orgs novas: empresa padrão + plano AMAI Park.
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_seed_org(p_org uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies WHERE org_id = p_org) THEN
    INSERT INTO whatsapp_hub.fin_companies (org_id, name, is_default)
    SELECT p_org, name, true FROM whatsapp_hub.organizations WHERE id = p_org;
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_chart_accounts WHERE org_id = p_org) THEN RETURN; END IF;
  PERFORM whatsapp_hub._fin_insert_amai_chart(p_org);
END
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.fin_seed_org(uuid) FROM PUBLIC, anon, authenticated;

-- Aplicar agora (todas as orgs, menos BELA/BELLA CENTER).
DO $$
DECLARE o record; v text;
BEGIN
  FOR o IN SELECT id, name FROM whatsapp_hub.organizations WHERE name !~* 'bel+a center' ORDER BY name LOOP
    v := whatsapp_hub.fin_replace_chart_amai(o.id);
    RAISE NOTICE '%: %', o.name, v;
  END LOOP;
END $$;
