BEGIN;

CREATE TABLE usuarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome VARCHAR(150) NOT NULL,
    email VARCHAR(254) NOT NULL,
    senha_hash TEXT NOT NULL,
    perfil VARCHAR(20) NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT true,
    data_cadastro TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT usuarios_nome_valido CHECK (nome ~ '[^[:space:]]'),
    CONSTRAINT usuarios_email_valido CHECK (
        length(email) > 0
        AND email = lower(btrim(email))
        AND email !~ '[[:space:]]'
    ),
    CONSTRAINT usuarios_email_unico UNIQUE (email),
    CONSTRAINT usuarios_senha_hash_nao_vazio CHECK (senha_hash ~ '[^[:space:]]'),
    CONSTRAINT usuarios_perfil_valido CHECK (
        perfil IN ('administrador', 'funcionario')
    )
);

CREATE TABLE sessoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id UUID NOT NULL,
    token_hash TEXT NOT NULL,
    criada_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expira_em TIMESTAMPTZ NOT NULL,
    ultima_atividade_em TIMESTAMPTZ NOT NULL,

    CONSTRAINT sessoes_usuario_fk FOREIGN KEY (usuario_id)
        REFERENCES usuarios(id) ON DELETE CASCADE,
    CONSTRAINT sessoes_token_hash_unico UNIQUE (token_hash),
    CONSTRAINT sessoes_token_hash_nao_vazio CHECK (token_hash ~ '[^[:space:]]'),
    CONSTRAINT sessoes_expiracao_valida CHECK (expira_em > criada_em),
    CONSTRAINT sessoes_atividade_valida CHECK (
        ultima_atividade_em >= criada_em AND ultima_atividade_em < expira_em
    )
);

-- PKs e UNIQUE já criam índices. Este apoia a busca e exclusão de sessões por usuário.
CREATE INDEX sessoes_usuario_idx ON sessoes (usuario_id);

COMMIT;
