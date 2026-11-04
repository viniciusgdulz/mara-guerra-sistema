# Etapa 4 — PostgreSQL real isolado

## Ambiente e isolamento

Utilizados os binários PostgreSQL **18.3** já instalados em `C:\Program Files\PostgreSQL\18\bin`, Bun **1.3.14** e um cluster novo dentro de `.local/meta-pg-stage4/`. Nenhum programa foi instalado e nenhuma configuração global foi alterada. O serviço PostgreSQL preexistente não foi utilizado nem interrompido.

O cluster exclusivo escuta somente `127.0.0.1`, na porta local 57659 desta execução. Credenciais sintéticas, dados, logs e relatório ficam no diretório ignorado pelo Git. Não publicar esse diretório. Cada execução da suíte cria outro banco com nome `mara_meta_stage4_<uuid>`, valida o endereço e o diretório efetivo do servidor e aplica **001, 002, 003 e 004**, nesta ordem, via `psql -X -v ON_ERROR_STOP=1`.

Nenhuma conexão utiliza `DATABASE_URL`; os comandos Bun ignoram `.env` explicitamente. Somente pacientes e procedimentos sintéticos são criados no cluster exclusivo. Não há operação no Neon. As migrações permanecem pendentes em produção.

## Reproduzir

Não instale programas se os binários não estiverem disponíveis. O script aceita `-Bin` para apontar outra instalação existente. A opção de execução abaixo vale apenas para o processo PowerShell, sem modificar a política global:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/meta-local-db.ps1 -Action start
$env:MARA_META_REAL_TESTS = '1'
bun --no-env-file test
bun --no-env-file run typecheck
git diff --check
Remove-Item Env:MARA_META_REAL_TESTS
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/meta-local-db.ps1 -Action stop
```

`start` prepara o cluster uma vez ou reinicia o cluster exclusivo já registrado. `status` consulta esse cluster; `stop` encerra somente esse cluster. A senha local não é impressa. Os bancos sintéticos ficam preservados no diretório ignorado para diagnóstico, sem exclusão automática. Não usar `bun run db:test`, pois esse fluxo não é o utilizado nesta validação isolada.

Sem `MARA_META_REAL_TESTS=1`, os 14 testes PostgreSQL são ignorados. Com a flag, ausência de cluster ou configuração divergente falha explicitamente, sem fallback para outro banco.

## Verificações reais

- Aplicação de 001–004 sem erro SQL; existência dos índices de wamid, tentativa, inbox e deduplicação.
- Constraints rejeitam reservas incompletas, aceite sem wamid e entrega sem aceite (SQLSTATE 23514).
- Unicidade rejeita wamid e tentativa reutilizados em notificações distintas (SQLSTATE 23505).
- Rollback desfaz a reserva; uma transação posterior consegue reservá-la.
- Dez conexões independentes disputam a mesma notificação: exatamente uma reserva vence.
- Dois processadores concorrentes fazem uma única chamada ao canal mock, com reserva confirmada e visível por outra conexão. Aceite não preenche entrega/data_envio.
- Expiração muda reservado para incerto sem reenviar; webhook correlacionado reconcilia para aceita/delivered. Nova tentativa é recusada com erro 409, sem chamar o canal nem modificar o wamid e os estados persistidos.
- Inbox anterior ao aceite é reconciliado; dez callbacks duplicados geram um único evento/aplicação; eventos fora de ordem não regridem read.
- `pg_terminate_backend` encerra somente conexões do banco e usuário sintéticos desta execução: antes do commit a reserva sofre rollback; depois do commit, falha na finalização preserva a reserva e a expiração produz incerto.
- POST assinado persiste no PostgreSQL; assinatura inválida não altera a entrega.
- Seleção Meta com flags habilitadas permanece bloqueada por código e não constrói o transporte; geração repetida não duplica a fila.

O canal de aceitação é um mock injetado. `fetch` é bloqueado durante a suíte e a ausência de chamadas é verificada. Nenhuma chamada real à Meta foi realizada.

## Timeout investigado e corrigido

Inicialmente, a suíte completa teve 570 testes aprovados e um timeout. O PostgreSQL mostrava a sessão aguardando o cliente após `BEGIN`, sem espera por lock SQL. A reprodução isolou o travamento ao uso de `expect(promessaPendente).rejects.toThrow()` neste cenário no Bun 1.3.14: o mesmo fluxo executado fora do matcher finalizou normalmente com a recusa esperada.

A correção aguarda a conclusão da mesma promessa com `await tentativa.catch(() => {})` antes do matcher. Isso não transforma a promessa original em sucesso: as asserções continuam exigindo sua rejeição. Não houve mudança no processamento, nas transações, no pool ou no timeout de cinco segundos do teste.

O teste original foi mantido e reforçado: exige a mensagem de recusa, status 409, nenhuma chamada ao canal e preservação de `meta_estado`, `meta_entrega_estado` e `meta_wamid`. Uma falha SQL ou de conexão não satisfaz essas condições. A leitura final também verifica que a conexão continua utilizável. A suíte PostgreSQL completa passou com 14 testes.

Resultado final da suíte completa com PostgreSQL habilitado: **571 testes aprovados, 0 falhas**, em 16 arquivos. `bun --no-env-file run typecheck` e `git diff --check` também passaram. O cluster exclusivo foi encerrado após a validação.

No encerramento posterior, com 19 testes adicionais do comando manual, a validação foi repetida: **576 aprovados** sem PostgreSQL e **590 aprovados** com os 14 casos reais habilitados, sem falhas. Veja [registro consolidado](validacao.md). Nenhum envio real ou migração no Neon foi realizado.

## Próximos passos

Esta validação não habilita envios reais. Antes de um teste real controlado, revisar o plano de implantação, obter aprovação específica para migrações e configurar conta, template aprovado, destinatário de teste com consentimento e webhooks. O bloqueio de envio real permanece intacto; não há autorização para removê-lo nem aplicar migrações em produção.
