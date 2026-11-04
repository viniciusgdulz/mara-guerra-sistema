BEGIN;

-- ETAPA 3: validada somente em PostgreSQL isolado; produção exige aprovação separada.
ALTER TABLE notificacoes
    ADD COLUMN meta_entrega_estado VARCHAR(20) NOT NULL DEFAULT 'nao_confirmada',
    ADD COLUMN meta_entrega_em TIMESTAMPTZ,
    ADD COLUMN meta_entrega_erro INTEGER CHECK (meta_entrega_erro >= 0),
    ADD CONSTRAINT notificacoes_meta_entrega_valida CHECK (
        (meta_entrega_estado = 'nao_confirmada' AND meta_entrega_em IS NULL)
        OR (meta_entrega_estado IN ('sent', 'delivered', 'read', 'failed')
            AND meta_entrega_em IS NOT NULL AND meta_estado = 'aceita' AND meta_wamid IS NOT NULL)
    ),
    ADD CONSTRAINT notificacoes_meta_erro_entrega_coerente CHECK (meta_entrega_estado = 'failed' OR meta_entrega_erro IS NULL);

-- Inbox mínimo: não armazena telefones, mensagens, tokens, assinatura ou payload bruto.
CREATE TABLE meta_webhook_eventos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number_id VARCHAR(30) NOT NULL CHECK (phone_number_id ~ '^[0-9]+$'),
    meta_wamid VARCHAR(2054) NOT NULL CHECK (meta_wamid ~ '^wamid\.[^[:space:]]+$'),
    estado VARCHAR(10) NOT NULL CHECK (estado IN ('sent', 'delivered', 'read', 'failed')),
    ocorrido_em TIMESTAMPTZ NOT NULL,
    recebido_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    erro_codigo INTEGER CHECK (erro_codigo >= 0),
    correlacao UUID,
    notificacao_id UUID REFERENCES notificacoes(id) ON DELETE RESTRICT,
    aplicado_em TIMESTAMPTZ,
    CONSTRAINT meta_webhook_evento_unico UNIQUE (phone_number_id, meta_wamid, estado, ocorrido_em),
    CONSTRAINT meta_webhook_aplicacao_coerente CHECK (aplicado_em IS NULL OR notificacao_id IS NOT NULL)
);
CREATE INDEX meta_webhook_pendentes_idx ON meta_webhook_eventos (meta_wamid, ocorrido_em) WHERE aplicado_em IS NULL;

COMMIT;
