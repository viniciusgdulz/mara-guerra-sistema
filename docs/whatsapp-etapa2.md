# Etapa 2 — Seleção de provedor e processamento seguro da fila

## Arquitetura implementada

**Registro histórico.** Persistência e webhooks já foram integrados na Etapa 3 e as migrações 003/004 validadas na Etapa 4 somente em PostgreSQL isolado. Não foram aplicadas no Neon. A lista de pendências abaixo é a da Etapa 2. O [estado consolidado](documentacao-tecnica.md) e a [validação](validacao.md) prevalecem. O envio real continua bloqueado/não validado; o comando manual separado depende de configuração e autorização.

Registro histórico da Etapa 2. A integração durável das funções, a revisão de 003 e os webhooks da Etapa 3 estão em `docs/whatsapp-etapa3.md`; esse documento mais recente define o comportamento atual.

`src/integrations/whatsapp-provider.ts` adapta os contratos da preparação simulada e do cliente Meta da Etapa 1. `WHATSAPP_PROVIDER` seleciona `simulado` ou `meta`; o padrão é `simulado`. Valores desconhecidos são rejeitados, sem seleção implícita baseada em credenciais.

O processamento usa uma única função de negócio, `processarNotificacao`, em `src/services/notificacoes.service.ts`. Ela valida UUID, carrega a origem, verifica o consentimento com data, a elegibilidade e o telefone, e usa o mesmo advisory lock transacional da geração e da revogação. A geração continua deduplicando por tipo/origem. Nenhum worker, cron ou processamento automático foi adicionado.

A ação anterior `simularNotificacao` é um wrapper dessa função, com canal simulado fixo. Continua testável com o provedor simulado e rejeita clientes reais. A nova ação usa o canal selecionado no servidor; o corpo HTTP não pode escolher provedor, habilitação, destinatário, conteúdo ou status.

### Configurações

- `WHATSAPP_PROVIDER=simulado`: padrão. Credenciais presentes não alteram essa escolha.
- `WHATSAPP_PROVIDER=meta`: seleciona o adaptador Meta para o processamento da fila.
- `WHATSAPP_REAL_SEND_ENABLED=false`: padrão e habilitação adicional exigida para uma futura liberação. Somente os textos exatos `true` e `false` são aceitos.
- `WHATSAPP_REAL_SEND_ENABLED=true` **não libera chamadas externas nesta etapa**. A função de política `exigirLiberacaoReal` contém um bloqueio incondicional da Etapa 2, sem variável ou opção HTTP que o remova.
- Token, Phone Number ID, versão e timeout são os da Etapa 1. A fila bloqueada não precisa dessas credenciais e não chega a construir o cliente Meta.

A seleção `meta` chega ao adaptador, mas para antes da fábrica do cliente, antes da reserva de tentativa e antes de qualquer HTTP. O resultado distingue `envio_desabilitado` de `etapa2`, sem marcar falha ou envio. Não existe resposta de aceitação real no contrato ativo do canal desta etapa. O código que referencia `enviarTemplate` é inalcançável enquanto vigorar a política; não basta remover uma linha para tornar o restante pronto para produção.

O cliente de baixo nível da Etapa 1 continua disponível para chamada explícita por código futuro. O bloqueio da Etapa 2 protege o fluxo da aplicação e a interface, não redefine o comportamento desse cliente isolado. Nenhum teste desta implementação chama seu transporte real.

### API e interface

- `POST /api/notificacoes/:id/processar`, corpo `{}`: processa com o provedor escolhido no ambiente do servidor.
- `POST /api/notificacoes/:id/simular`, corpo `{}`: permanece exclusivamente simulado, mesmo com `WHATSAPP_PROVIDER=meta`.
- `GET /api/notificacoes`: informa a seleção e a política em `processamento`, sem credenciais. O campo legado `modo: simulado` indica ausência de envio externo nesta etapa.
- Todas essas ações continuam exclusivas de administrador, com sessão e proteção de origem em escritas. Funcionários não acessam a fila ou os dados internos de atendimentos.
- A interface mostra **Provedor selecionado** e **Envios externos bloqueados pela Etapa 2**. Há botões separados para simular e processar com a seleção do servidor.

## Estados e prevenção de reenvios

Os status legados de `notificacoes` continuam `pendente`, `enviada`, `cancelada`, `falhou`, sem introduzir um status de entrega por interpretação de HTTP 200:

| Resultado atual | Efeito |
| --- | --- |
| Simulação bem-sucedida | `pendente`, `data_envio = NULL`. |
| Consentimento/eligibilidade inválidos | `cancelada`, sem envio. |
| Telefone inválido ou falha da preparação simulada | `falhou`, `data_envio = NULL`, erro seguro. |
| Canal Meta bloqueado | Mantém o status anterior e informa o motivo; não grava tentativa nem `wamid`. |
| Tentativa Meta previamente registrada | Reprocessamento e simulação bloqueados, independentemente do status legado. |

`contextos` lê os metadados propostos via `to_jsonb(n)->>'campo'`. Assim, a consulta funciona antes da migração: campo ausente equivale a `nao_iniciado`. Um `meta_wamid` existente também bloqueia processamento, mesmo se o estado estiver inconsistente. Geração não reabre essas tentativas e cancelamento manual não sobrescreve seus dados. Revogação de consentimento preserva metadados, embora possa cancelar a fila legada; ela não apaga uma aceitação já registrada.

## Migração proposta, não executada

`sql/003_prepare_meta_notifications.sql` adiciona:

- `meta_estado`: `nao_iniciado`, `reservado`, `aceita`, `incerto`, `falhou`.
- `meta_wamid`: identificador retornado pela Meta.
- `meta_tentativa_em` e `meta_aceita_em`: instantes de tentativa e aceitação.
- Constraints de coerência e índice UNIQUE parcial do `wamid`.

É uma migração aditiva e transacional, que não redefine os status legados. Sua execução requer revisão/aprovação separada. Não existe chamada de migração no servidor, testes ou inicialização. A leitura compatível com o schema anterior não depende da aprovação desse arquivo.

`src/services/notificacoes-meta.repository.ts` prepara funções de persistência, ainda não chamadas pelas rotas:

1. Reserva condicional/atômica somente de `nao_iniciado`, sem `wamid`, status aberto e previsão vencida. Uma segunda reserva não é permitida.
2. Registro de aceitação com `wamid` e instante, idempotente para o mesmo id. Não altera `status`, `data_envio` nem inventa confirmação de entrega.
3. Registro separado de falha definitiva ou resultado incerto somente de uma reserva. Nenhum dos dois estados volta a `nao_iniciado` automaticamente.

A aceitação HTTP da Meta é apenas aceitação: entrega/leitura dependem de webhooks e conciliação futura. Timeout/rede/HTTP 5xx podem ter resultado incerto e não justificam repetir automaticamente. Nem o cliente, nem a fila implementam retries automáticos.

Os testes de migração verificam o arquivo DDL e o comportamento das funções com SQL simulado. O DDL **não foi executado/validado em um servidor PostgreSQL** nesta etapa. A aplicação da migração e testes reais de constraints em banco isolado continuam pendentes.

## O que falta para um teste real controlado

1. Revisar/aprovar e validar a migração em banco isolado; preparar reserva durável com commit antes de iniciar HTTP, sem manter a reserva somente em uma transação que possa desaparecer após o envio.
2. Conectar reserva, revalidação de consentimento/elegibilidade, chamada externa e registro de aceitação/resultado incerto em um fluxo de despacho/reconciliação. Os helpers preparados não substituem essa orquestração.
3. Definir recuperação de reservas abandonadas, falhas após aceitação e webhooks verificáveis para entrega/leitura; não reabrir resultados incertos automaticamente.
4. Substituir templates rascunho por nomes/idiomas/parâmetros aprovados. Configurar token e Phone Number ID no ambiente seguro, sem registrar valores em código ou logs.
5. Implementar uma lista explícita de destinatários de teste autorizados e limites operacionais para o teste controlado. Nenhum dado real de paciente deve ser usado para esse fim.
6. Aprovar uma alteração de código que remova o bloqueio incondicional da Etapa 2 somente depois de concluir essas verificações. Depois, selecionar `meta` e habilitar a flag adicional; hoje essas configurações continuam bloqueadas.

## Validação sem envios

Execute `bun test`, `bun run typecheck` e `git diff --check`. Os testes de seleção verificam que a fábrica e o método de envio Meta não são chamados, inclusive com seleção Meta, credenciais fictícias e flag true. Consentimento, telefone, elegibilidade, origem, perfis, estado da tentativa, reserva concorrente, aceitação e falhas são testados com mocks.

No navegador, use conta administrativa e banco separado de desenvolvimento para operações que gravam. Com a seleção padrão, **Processar com provedor selecionado** mantém a simulação existente. Selecionando `meta` no ambiente e reiniciando o servidor, a tela informa o bloqueio. Mesmo com `WHATSAPP_REAL_SEND_ENABLED=true`, processar uma notificação elegível apenas apresenta a mensagem de bloqueio; não muda seu status nem exige credenciais. A ação **Simular preparação** continua funcionando como simulação. Não execute migrações ou testes de escrita no Neon de produção.
