# Validação técnica e encerramento

Data: 4 de novembro de 2026. Registra testes automatizados e SQL isolado, sem homologação de produção ou comprovação de impacto na clínica.

## Suítes e contagem

| Marco | Resultado registrado | Escopo |
| --- | --- | --- |
| Etapa 1 | 478 aprovados | Cliente Meta com HTTP mock |
| Etapa 2 | 520 aprovados | Seleção, consentimento, processamento e bloqueio |
| Etapa 3 | 557 aprovados | Persistência/webhooks com banco simulado |
| Etapa 4 após correção | 571 aprovados, zero falhas | 557 anteriores + 14 PostgreSQL real |
| Suíte padrão atual | **576 aprovados**, zero falhas | 557 anteriores + 19 manuais, sem PostgreSQL |
| Encerramento com PostgreSQL habilitado | **590 aprovados**, zero falhas | Suíte padrão + 14 casos PostgreSQL reais, 17 arquivos |

Na suíte padrão, Bun informa 16 itens ignorados da suíte PostgreSQL desativada, incluindo seus hooks; são 14 casos funcionais adicionais. Os 571 e 576 pertencem a combinações diferentes, sem perda de testes. No encerramento, ambas as execuções foram repetidas: **576 aprovados** na padrão e **590 aprovados** com PostgreSQL (576 + 14). Typecheck, sintaxe dos sete scripts frontend e `git diff --check` passaram; os dez documentos Markdown têm seus links locais verificados. O cluster exclusivo foi encerrado após os testes, preservando o serviço PostgreSQL preexistente.

Comandos seguros:

```powershell
bun --no-env-file test
bun --no-env-file run typecheck
git diff --check
```

Não carregam `.env` nem usam a conexão de produção. Não executar `bun run db:test`, que lê a configuração normal do banco. O cliente Meta usa mocks nos testes; o envio manual real não é invocado pela suíte.

## PostgreSQL real isolado

Utilizada a instalação existente **PostgreSQL 18.3**, em cluster exclusivo dentro de `.local/meta-pg-stage4/`, ligado somente a `127.0.0.1`, em porta própria. Nenhum programa instalado, configuração global alterada ou serviço preexistente usado para os testes. Credenciais sintéticas/logs são ignorados pelo Git. O arquivo pessoal WhatsApp não é necessário nem lido.

`scripts/meta-local-db.ps1` prepara/inicia/para somente esse cluster. `tests/meta-postgres.test.ts` exige flag opt-in e valida host, usuário, nome de banco e diretório efetivo antes de criar outro banco exclusivo. Não há fallback para Neon. Em banco vazio foram aplicadas **001, 002, 003 e 004**, na ordem, interrompendo em erro SQL.

Verificações reais:

- Constraints de reserva/aceite/entrega (SQLSTATE 23514) e unicidade de wamid/tentativa (23505).
- Rollback e reserva posterior; dez conexões concorrentes com uma única vencedora.
- Dois processadores concorrentes com uma chamada ao canal mock, reserva visível após commit e aceite sem falsa confirmação de entrega.
- Expiração para incerto sem reenvio; reconciliação por webhook correlacionado.
- Inbox antes do aceite, callbacks duplicados e eventos fora de ordem sem regressão indevida.
- `pg_terminate_backend` somente em conexões sintéticas: rollback antes do commit e reserva preservada após falha na finalização.
- POST assinado com persistência real; assinatura inválida não grava; flags Meta não constroem transporte externo.

O timeout inicial ocorreu no matcher `rejects.toThrow()` do Bun 1.3.14 com promessa pendente. A correção aguarda a mesma promessa antes da asserção, sem aumentar timeout ou remover o teste; exige erro 409/mensagem, ausência de chamada ao canal e preservação de estados/wamid. Fora do matcher, o fluxo retornava a recusa esperada. Detalhes: [Etapa 4](whatsapp-etapa4.md).

Reprodução, somente com binários locais já disponíveis:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/meta-local-db.ps1 -Action start
$env:MARA_META_REAL_TESTS = '1'
bun --no-env-file test
Remove-Item Env:MARA_META_REAL_TESTS
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/meta-local-db.ps1 -Action stop
```

Política de execução apenas para o processo. Bancos sintéticos permanecem locais para diagnóstico. Não aplicar esses comandos a produção nem usar o `.env` da clínica.

## Segurança do material versionado

Antes da documentação e antes do commit, arquivos candidatos foram inspecionados para tokens, chaves privadas, senhas em URLs, dados identificáveis e nomes sensíveis. Testes contêm fixtures sintéticas/credenciais fictícias; exemplos de URL local não são produção. Busca automatizada não prova ausência absoluta, por isso foi combinada com revisão e exclusões Git.

`.env`, configuração pessoal WhatsApp, reserva do envio manual, dados/credenciais/logs PostgreSQL e resultados brutos locais são excluídos. O arquivo pessoal não foi aberto nem reproduzido. Não copiar tokens reais para documentos/commits. O histórico Git preexistente não passou por auditoria forense nesta etapa.

## Limites

- Nenhuma chamada real à Meta ou envio manual. Token, permissões, template, liberação da conta e entrega real dependem da clínica e autorização posterior.
- Nenhuma migração/consulta/inserção no Neon. SQL local não prova igualdade com o schema real da clínica.
- Quedas testadas encerrando conexões próprias, não por desligamento físico ou falha de rede cloud; backups/operação precisam de ensaio.
- Fixtures/assinaturas validam código de webhook; HTTPS, inscrição e entrega efetiva pela Meta ainda não foram testados.
- Aprovação visual anterior não substitui avaliação de carga, acessibilidade, segurança ou resultados com usuários.
