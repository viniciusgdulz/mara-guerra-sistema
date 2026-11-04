# Documentação técnica consolidada

Encerramento desta etapa, em 4 de novembro de 2026. Este documento descreve o código atual; documentos das etapas anteriores preservam o histórico. **O envio WhatsApp real não foi validado**, nem foi confirmada a liberação da conta da clínica. As migrações da integração não foram aplicadas no Neon de produção.

## Arquitetura

Monólito Bun 1.3.14/TypeScript estrito. `src/server.ts` inicia `Bun.serve`; `src/app.ts` despacha rotas e serve somente os arquivos estáticos permitidos. Controllers verificam HTTP, sessão, perfil, origem e respostas; services concentram regras e validações, com SQL parametrizado nativo do Bun. Dependências de banco e transporte podem ser substituídas por mocks.

`src/db/connection.ts` lê `DATABASE_URL` quando uma rota precisa abrir o banco. A arquitetura utiliza PostgreSQL no Neon, mas a revisão e os testes desta etapa não o consultam. Não há executor automático de migração.

O frontend em `public/` não usa framework. `app.js` trata login/pacientes; `navigation.js` alterna telas; scripts próprios tratam procedimentos, atendimentos, agenda, consentimento e notificações. Uma tela fica visível por vez, com item ativo destacado e formulários sob demanda. Há mensagens `aria-live`, foco, elementos nativos, tabelas com rolagem e layout responsivo. Não houve auditoria formal de acessibilidade.

## Funcionalidades e permissões

| Módulo | Administrador | Funcionário | Limites atuais |
| --- | --- | --- | --- |
| Sessão | Entrar, consultar próprio perfil e sair | Igual | Sem cadastro público/recuperação de senha |
| Pacientes | Cadastrar, pesquisar e consultar | Igual | Sem edição/exclusão geral |
| Consentimento WhatsApp | Consultar, registrar e revogar manifestação explícita | Igual | Estado/data atuais, sem auditoria histórica de revogações |
| Procedimentos | Cadastrar, consultar ativos/inativos, editar e inativar | Consultar somente ativos | Sem exclusão permanente ou reativação |
| Atendimentos | Registrar, consultar histórico e ajustar retorno | Sem acesso, inclusive API | Sem edição geral/exclusão; preserva procedimento inativado |
| Agenda | Criar, consultar, reagendar, cancelar e concluir | Criar, consultar, reagendar e cancelar | Conclusão administrativa; não cria atendimento automaticamente |
| Retornos sugeridos | Consultar e iniciar agendamento explícito | Sem acesso aos dados internos de atendimentos | Associação com agenda é aproximada |
| Notificações | Gerar, consultar, simular, processar bloqueado, cancelar e reconciliar | Sem acesso | Sem envios automáticos ou worker/cron |

Paciente exige nome e telefone; e-mail e nascimento são opcionais. Procedimento exige nome; descrição e intervalo são opcionais. Novos atendimentos/agendamentos exigem procedimento ativo. O histórico mantém registros de procedimentos inativados e exibe o nome atual do catálogo, sem cópia histórica do nome.

O backend calcula o retorno em dias de calendário; o administrador pode informar, remover ou ajustar a data. Atendimento não pode ser futuro; retorno não pode antecedê-lo. A agenda interpreta horários em `America/Sao_Paulo`, respeita `pendente`, `confirmado`, `realizado`, `cancelado`, `nao_compareceu` e representa conclusão como `realizado`. Nem todo status possui um fluxo de edição dedicado. Duplicidade de paciente/horário é controlada pelo protocolo transacional da aplicação, sem garantia contra escritores externos que o ignorem. Consultas usuais têm páginas de até 50 registros.

## APIs principais

| Grupo | Rotas |
| --- | --- |
| Autenticação | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Pacientes | `GET/POST /api/pacientes`; filtros `nome`, `pagina` |
| Consentimento | `GET/PATCH /api/pacientes/:id/consentimento-whatsapp` |
| Procedimentos | `GET/POST /api/procedimentos`, `PUT /api/procedimentos/:id`, `POST /api/procedimentos/:id/inativar` |
| Atendimentos | `GET/POST /api/atendimentos`, `GET /api/atendimentos/procedimentos`, `PATCH /api/atendimentos/:id/retorno` |
| Agenda | `GET/POST /api/agenda`, `GET /api/agenda/procedimentos`, `PUT /api/agenda/:id`, `PATCH /api/agenda/:id/status`, `GET /api/agenda/retornos`, `POST /api/agenda/retornos/:id/agendar` |
| Notificações | `GET /api/notificacoes`, `POST /api/notificacoes/gerar`, `POST /api/notificacoes/reconciliar`, `POST /api/notificacoes/:id/{simular,processar,cancelar}` |
| Webhook | `GET/POST /api/webhooks/whatsapp` |
| Saúde | `GET/HEAD /api/health` |

Payloads detalhados estão em controllers/services e no [histórico](implementacao-fases.md). `/api/admin` exige administrador, mas não oferece gestão adicional de usuários. Funcionários não obtêm histórico clínico pelas APIs cadastrais, de agenda ou notificações.

## Segurança

Senhas usam Argon2id. Token aleatório de sessão fica em cookie HttpOnly/SameSite=Strict, com SHA-256 no banco, expiração absoluta de oito horas, inatividade de trinta minutos, verificação de usuário ativo e logout. Escritas exigem origem autorizada. Em produção: `NODE_ENV=production`, `APP_ORIGIN` HTTPS exata, cookie Secure e prefixo `__Host-`. O limitador de login fica em memória e não é compartilhado entre instâncias.

Perfis são verificados no backend; UUIDs, datas, tipos, campos e tamanhos de corpo são validados. Respostas de negócio usam `no-store`; o frontend exibe dados com `textContent` e descarta respostas atrasadas após mudança de sessão/perfil. Segredos não devem aparecer em logs, mensagens ou URLs.

Webhooks não usam cookies nem Origin do navegador: GET compara verify token; POST valida HMAC-SHA256 de `X-Hub-Signature-256` sobre bytes originais, limita corpo/eventos e filtra Phone Number ID e WABA opcional. Confirma recebimento só após persistência. Proxy/hospedagem também devem omitir URLs de verificação que contenham token dos logs.

## WhatsApp: implementação atual

### Preparação e consentimento

O administrador gera lembretes de agendamentos nas próximas 48 horas e retornos entre hoje e sete dias. Mensagens discretas usam primeiro nome e data/horário do agendamento, sem procedimento, diagnóstico ou histórico. `rascunho_lembrete_agendamento` e `rascunho_lembrete_retorno` são templates locais de exemplo, **não aprovados pela Meta**.

Consentimento exige confirmação explícita e data do servidor. Revogação limpa a data conforme a constraint e cancela notificações pendentes/falhas na mesma transação. O processamento verifica consentimento, telefone, elegibilidade e tentativas anteriores. Operações relacionadas compartilham advisory lock transacional; o schema não tem UNIQUE por tipo/origem e a garantia depende de todos os escritores seguirem o protocolo.

Retornos possivelmente já agendados são sinalizados usando mesmo paciente/procedimento e reserva não cancelada/ausente entre data sugerida e trinta dias depois. É uma aproximação, sem FK de origem; não comprova o vínculo nem impede um agendamento genérico após conferência.

### Transporte e bloqueio

`whatsapp.ts` prepara a simulação; `whatsapp-meta.ts` implementa `POST https://graph.facebook.com/{versao}/{phoneNumberId}/messages`, Bearer token, template/idioma e parâmetros posicionais de texto no corpo. Interpreta `wamid`, falhas HTTP/autenticação/rede/timeout/resposta inválida e código 130497, com erros sanitizados e sem retry automático.

`whatsapp-provider.ts` seleciona `simulado` por padrão ou `meta` explicitamente. Mesmo com `WHATSAPP_REAL_SEND_ENABLED=true`, um bloqueio incondicional impede a fábrica/transporte real na fila/interface. Não há cron ou worker de envio. O cliente isolado só envia por chamada explícita; testes usam transporte mock.

### Persistência, estados e webhooks

Com schema preparado e persistência habilitada, a reserva é confirmada antes do canal; resultado é salvo em outra transação. A reserva tem UUID único e expiração de cinco minutos. Timeout, expiração ou falha na finalização impedem reenvio; reconciliação não reabre tentativas.

| Camada | Estados |
| --- | --- |
| Notificação legada | `pendente`, `enviada`, `cancelada`, `falhou` |
| Processamento Meta | `nao_iniciado`, `reservado`, `aceita`, `incerto`, `falhou`, `bloqueado` |
| Entrega via webhook | `nao_confirmada`, `sent`, `delivered`, `read`, `failed` |

Simulação permanece pendente com `data_envio = NULL`. HTTP aceito e wamid não confirmam entrega. Eventos assinados são deduplicados em inbox por remetente/wamid/status/instante e reconciliados por wamid ou correlação UUID, sem associação por telefone. Eventos fora de ordem não regridem read/delivered; inbox anterior ao aceite pode ser reconciliado depois. Eventos desconhecidos são ignorados ou permanecem pendentes conforme forma e associação.

### Comando manual separado

`scripts/whatsapp-manual-test.ts` não importa banco nem aplicação. Usa JSON privado em `.local/whatsapp-manual/`; `--check` é offline. Um envio futuro exige argumentos explícitos, terminal e frase exata de autorização, fixa `hello_world/en_US` e cria reserva exclusiva local contra repetição. O resultado fica local, sem associação automática à fila SQL.

O arquivo foi preparado, sem leitura nesta revisão. Token válido, permissões, template, destinatário verificado e liberação da conta da clínica **não foram confirmados remotamente**. As confirmações do JSON são declarações do operador. Siga o [guia manual](whatsapp-teste-manual.md) somente após configuração e autorização.

## Schema e operação

| SQL | Conteúdo | Estado |
| --- | --- | --- |
| 001 | Pacientes, procedimentos, atendimentos, agenda e notificações | Base existente; reaplicada em banco sintético vazio |
| 002 | Usuários e sessões | Base existente; reaplicada em banco sintético vazio |
| 003 | Reserva, tentativa, wamid, falha e constraints/índices Meta | Validada só em PostgreSQL isolado; não aplicada no Neon de produção |
| 004 | Entrega e inbox de webhooks | Validada só em PostgreSQL isolado; não aplicada no Neon de produção |

Não reaplicar 001/002 em banco existente: não são um migrador idempotente. Ordem em banco vazio: 001 → 002 → 003 → 004. Commit de SQL ou aprovação para teste não autorizam migração em produção.

Configuração: `HOST`, `PORT`, `DATABASE_URL`, `NODE_ENV`, `APP_ORIGIN`; WhatsApp: `WHATSAPP_PROVIDER`, `WHATSAPP_REAL_SEND_ENABLED`, `WHATSAPP_PERSISTENCE_ENABLED`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_TIMEOUT_MS`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WABA_ID` opcional. `.env.example` contém somente placeholders. O teste manual usa JSON separado.

## Pendências

1. Configurar/liberar a conta da clínica, revisar permissões/restrições, templates, token e destinatário de teste verificado/consentido. Validar envio real somente com autorização específica.
2. Antes da fila real, revisar janela entre commit e envio quanto a revogação/cancelamento, limites de destinatários/volume e aprovação específica de alteração do bloqueio. Flags não bastam.
3. Aprovar plano de migração 003/004, backup e recuperação. Testes não comprovam que o schema real do Neon coincide com o versionado.
4. Configurar HTTPS, inscrição de webhooks na Meta, retenção do inbox, monitoramento seguro, segredos e backups. Aceite HTTP não comprova entrega/leitura.
5. Consentimento não possui histórico, data da revogação ou usuário responsável. Um requisito de auditoria exigirá proposta de schema e aprovação.
6. Vínculo exato de retorno/agendamento e UNIQUE por tipo/origem dependem de evolução de schema e tratamento prévio de duplicidades externas.
7. Não implementados: recuperação de senha, gestão completa de usuários, edição/exclusão de pacientes, reativação de procedimentos, edição geral de atendimentos, conflitos por duração/sala/profissional e retries automáticos.
8. Aprovação visual anterior não equivale a teste de carga, auditoria de segurança/acessibilidade ou estudo de resultados na clínica. Não houve nova avaliação visual de navegador neste encerramento.
