BEGIN;

-- ETAPAS 2/3: validada em PostgreSQL isolado na Etapa 4; não aplicada no Neon de produção.
-- Aceitação da Meta é independente de entrega e do status legado de notificacoes.
ALTER TABLE notificacoes
    ADD COLUMN meta_estado VARCHAR(20) NOT NULL DEFAULT 'nao_iniciado',
    ADD COLUMN meta_wamid VARCHAR(2054),
    ADD COLUMN meta_tentativa_em TIMESTAMPTZ,
    ADD COLUMN meta_aceita_em TIMESTAMPTZ,
    ADD COLUMN meta_tentativa_id UUID,
    ADD COLUMN meta_reserva_expira_em TIMESTAMPTZ,
    ADD COLUMN meta_falha_codigo INTEGER CHECK (meta_falha_codigo >= 0),
    ADD CONSTRAINT notificacoes_meta_estado_valido CHECK (
        meta_estado IN ('nao_iniciado', 'reservado', 'aceita', 'incerto', 'falhou', 'bloqueado')
    ),
    ADD CONSTRAINT notificacoes_meta_tentativa_coerente CHECK (
        (meta_estado = 'nao_iniciado' AND meta_tentativa_em IS NULL)
        OR (meta_estado <> 'nao_iniciado' AND meta_tentativa_em IS NOT NULL)
    ),
    ADD CONSTRAINT notificacoes_meta_aceitacao_coerente CHECK (
        (meta_estado = 'aceita' AND meta_wamid IS NOT NULL AND meta_wamid ~ '^wamid\.[^[:space:]]+$' AND meta_aceita_em IS NOT NULL)
        OR (meta_estado <> 'aceita' AND meta_wamid IS NULL AND meta_aceita_em IS NULL)
    ),
    ADD CONSTRAINT notificacoes_meta_reserva_coerente CHECK (
        (meta_estado = 'nao_iniciado' AND meta_tentativa_id IS NULL AND meta_reserva_expira_em IS NULL)
        OR (meta_estado <> 'nao_iniciado' AND meta_tentativa_id IS NOT NULL AND meta_reserva_expira_em IS NOT NULL
            AND meta_reserva_expira_em > meta_tentativa_em)
    );

CREATE UNIQUE INDEX notificacoes_meta_wamid_unico ON notificacoes (meta_wamid) WHERE meta_wamid IS NOT NULL;
CREATE UNIQUE INDEX notificacoes_meta_tentativa_unica ON notificacoes (meta_tentativa_id) WHERE meta_tentativa_id IS NOT NULL;

COMMIT;
