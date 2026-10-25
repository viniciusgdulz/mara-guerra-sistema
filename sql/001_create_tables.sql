BEGIN;

CREATE TABLE pacientes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome VARCHAR(150) NOT NULL,
    telefone VARCHAR(20) NOT NULL,
    email VARCHAR(254),
    data_nascimento DATE,
    consentimento_whatsapp BOOLEAN NOT NULL DEFAULT false,
    consentimento_whatsapp_em TIMESTAMPTZ,
    data_cadastro TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT pacientes_nome_valido CHECK (length(btrim(nome)) > 0),
    CONSTRAINT pacientes_telefone_valido CHECK (length(btrim(telefone)) > 0),
    CONSTRAINT pacientes_email_nao_vazio CHECK (email IS NULL OR length(btrim(email)) > 0),
    CONSTRAINT pacientes_consentimento_coerente CHECK (
        (consentimento_whatsapp AND consentimento_whatsapp_em IS NOT NULL)
        OR (NOT consentimento_whatsapp AND consentimento_whatsapp_em IS NULL)
    )
);

CREATE TABLE procedimentos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome VARCHAR(150) NOT NULL,
    descricao TEXT,
    intervalo_retorno_dias INTEGER,
    ativo BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT procedimentos_nome_valido CHECK (length(btrim(nome)) > 0),
    CONSTRAINT procedimentos_intervalo_valido CHECK (intervalo_retorno_dias > 0)
);

CREATE TABLE atendimentos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paciente_id UUID NOT NULL REFERENCES pacientes(id) ON DELETE RESTRICT,
    procedimento_id UUID NOT NULL REFERENCES procedimentos(id) ON DELETE RESTRICT,
    data_atendimento DATE NOT NULL,
    data_retorno_sugerida DATE,

    -- Necessária para a FK composta de notificacoes.
    CONSTRAINT atendimentos_id_paciente_unico UNIQUE (id, paciente_id),
    CONSTRAINT atendimentos_retorno_valido CHECK (data_retorno_sugerida >= data_atendimento)
);

CREATE TABLE agendamentos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paciente_id UUID NOT NULL REFERENCES pacientes(id) ON DELETE RESTRICT,
    procedimento_id UUID REFERENCES procedimentos(id) ON DELETE RESTRICT,
    data_hora TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pendente',

    -- Necessária para a FK composta de notificacoes.
    CONSTRAINT agendamentos_id_paciente_unico UNIQUE (id, paciente_id),
    CONSTRAINT agendamentos_status_valido CHECK (
        status IN ('pendente', 'confirmado', 'cancelado', 'realizado', 'nao_compareceu')
    )
);

CREATE TABLE notificacoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paciente_id UUID NOT NULL REFERENCES pacientes(id) ON DELETE RESTRICT,
    agendamento_id UUID,
    atendimento_id UUID,
    tipo VARCHAR(30) NOT NULL,
    previsao_envio TIMESTAMPTZ NOT NULL,
    data_envio TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'pendente',

    CONSTRAINT notificacoes_agendamento_paciente_fk
        FOREIGN KEY (agendamento_id, paciente_id)
        REFERENCES agendamentos(id, paciente_id) ON DELETE RESTRICT,
    CONSTRAINT notificacoes_atendimento_paciente_fk
        FOREIGN KEY (atendimento_id, paciente_id)
        REFERENCES atendimentos(id, paciente_id) ON DELETE RESTRICT,
    CONSTRAINT notificacoes_vinculo_exclusivo CHECK (
        (agendamento_id IS NOT NULL AND atendimento_id IS NULL)
        OR (agendamento_id IS NULL AND atendimento_id IS NOT NULL)
    ),
    CONSTRAINT notificacoes_tipo_valido CHECK (
        tipo IN ('lembrete_agendamento', 'lembrete_retorno')
    ),
    CONSTRAINT notificacoes_tipo_vinculo_coerente CHECK (
        (tipo = 'lembrete_agendamento' AND agendamento_id IS NOT NULL)
        OR (tipo = 'lembrete_retorno' AND atendimento_id IS NOT NULL)
    ),
    CONSTRAINT notificacoes_status_valido CHECK (
        status IN ('pendente', 'enviada', 'cancelada', 'falhou')
    ),
    CONSTRAINT notificacoes_envio_coerente CHECK (
        (status = 'enviada' AND data_envio IS NOT NULL)
        OR (status <> 'enviada' AND data_envio IS NULL)
    )
);

-- PKs e UNIQUE já criam seus índices. Estes apoiam as buscas pelas FKs
-- e a verificação de registros relacionados ao excluir um registro de origem.
CREATE INDEX atendimentos_paciente_idx ON atendimentos (paciente_id);
CREATE INDEX atendimentos_procedimento_idx ON atendimentos (procedimento_id);
CREATE INDEX agendamentos_paciente_idx ON agendamentos (paciente_id);
CREATE INDEX agendamentos_procedimento_idx ON agendamentos (procedimento_id);
CREATE INDEX notificacoes_paciente_idx ON notificacoes (paciente_id);
CREATE INDEX notificacoes_agendamento_paciente_idx
    ON notificacoes (agendamento_id, paciente_id) WHERE agendamento_id IS NOT NULL;
CREATE INDEX notificacoes_atendimento_paciente_idx
    ON notificacoes (atendimento_id, paciente_id) WHERE atendimento_id IS NOT NULL;

COMMIT;
