# Fase 9 — Limitações do schema e propostas para evolução

Este documento é uma proposta. Não contém migração executável e nenhuma alteração foi aplicada no Neon.

Atualização de encerramento: persistência SQL 003/004 e webhooks foram integrados na Etapa 3 e validados na Etapa 4 em PostgreSQL isolado, sem aplicação no Neon de produção. A ausência de campos descrita adiante se refere ao schema base 001. Auditoria de consentimento, UNIQUE por tipo/origem e vínculo exato de retorno continuam pendentes. Consulte o [estado consolidado](documentacao-tecnica.md) e a [validação](validacao.md).

## Consentimento e revogação

A tabela `pacientes` suporta estado atual (`consentimento_whatsapp`) e data da autorização (`consentimento_whatsapp_em`). A constraint `pacientes_consentimento_coerente` obriga o timestamp a ser NULL ao revogar. Não é possível registrar a data da revogação nem preservar autorizações antigas usando apenas esses dois campos.

Nesta fase, autorização explícita usa o timestamp do servidor; repetir a mesma autorização preserva a data original. Revogar limpa a data e cancela notificações pendentes/falhas na mesma transação. Administrador e funcionário podem registrar a manifestação do paciente, mas o sistema não presume autorização pelo cadastro, telefone, agendamento ou atendimento. A confirmação na interface registra a declaração da equipe, não comprova por si só a manifestação original do paciente.

**Proposta sujeita a aprovação:** criar uma tabela de eventos de consentimento com paciente, usuário responsável, decisão (autorizar/revogar), instante e origem/evidência mínima da manifestação. Preservar os campos atuais como projeção do estado vigente. Sem isso, não se deve apresentar o sistema como trilha de auditoria de consentimentos.

## Preparação, falhas e envio futuro

`notificacoes` armazena origem, tipo, previsão, data de envio e status. Não possui texto/payload persistido, motivo/código de falha, contador ou histórico de tentativas, identificador do provedor, reserva de processamento ou confirmação de entrega.

Nesta fase, as mensagens são prévias recalculadas a partir dos dados atuais, usando somente primeiro nome e, para horário agendado, data/hora de São Paulo. Não são cópias históricas imutáveis. A prévia fica indisponível quando a origem deixa de ser elegível. Um sucesso de preparação simulada permanece `pendente`, com `data_envio = NULL`. Uma falha de telefone/provedor simulado pode persistir `falhou`, mas a causa detalhada não é salva: a tela mostra diagnóstico atual ou explica a ausência de detalhe. Nenhuma operação desta fase grava `enviada`.

**Proposta sujeita a aprovação:** adicionar eventos de preparação/envio com resultado, código de falha seguro, instante, número de tentativa, identificador do provedor e idempotência. Para envio real, projetar reserva/lease e reconciliação de respostas/webhooks para lidar com a fronteira entre transação do banco e efeito externo. Definir retenção e acesso ao conteúdo antes de persistir mensagens, evitando dados clínicos e segredos.

## Deduplicação

O schema tem índices nas FKs, mas nenhum UNIQUE para tipo/origem. Todas as operações de geração, preparação simulada, cancelamento e consentimento desta fase usam o mesmo `pg_advisory_xact_lock` transacional no PostgreSQL. A geração consulta a existência por tipo/origem antes do INSERT. O bloqueio vale entre processos que usam o mesmo banco, não apenas dentro do servidor Bun.

Existe no máximo uma nova notificação por tipo/origem nas rotas da aplicação, independentemente do status. A execução repetida não reativa registros cancelados nem cria outra mensagem após revogação e nova autorização. Reagendamento atualiza a previsão da notificação ainda pendente/falha ao gerar novamente; registros enviados/cancelados não são reabertos. Dados duplicados anteriores e escritores externos que ignorem o bloqueio não são corrigidos nem protegidos por este protocolo.

**Proposta sujeita a aprovação:** após revisar/tratar duplicidades existentes, criar índices UNIQUE parciais para `(tipo, agendamento_id)` quando o agendamento não for NULL e `(tipo, atendimento_id)` quando o atendimento não for NULL. Se forem necessários vários lembretes por evento ou nova tentativa independente após cancelamento, definir primeiro a política de revisão/chave de idempotência e sua representação no schema.

## Retornos já agendados

`agendamentos` não possui vínculo com o atendimento que originou a sugestão. Não é possível afirmar com certeza que uma reserva corresponde àquela sugestão, especialmente se houver troca de procedimento ou data anterior à sugerida.

Nesta fase, a consulta da Fase 8 mantém as sugestões visíveis e acrescenta `retorno_agendado`: existe reserva não cancelada/não marcada como ausência, do mesmo paciente e procedimento, entre a data sugerida e os 30 dias seguintes. A tela mostra **Possível retorno já agendado** e orienta conferir a agenda, sem botão para agendar outra vez a partir daquela linha. Uma reserva genérica ainda pode ser criada após a conferência. O mesmo critério conservador impede gerar/preparar lembretes de retorno possivelmente já atendidos pela agenda.

A correspondência é uma aproximação: pode identificar uma reserva sem relação ou deixar de identificar uma reserva com procedimento diferente. Não exclui sugestões, não altera o histórico clínico e não marca automaticamente um retorno como concluído.

**Proposta sujeita a aprovação, se for exigida certeza:** adicionar referência opcional do agendamento ao atendimento de origem, validando também o paciente. Alimentar essa referência somente no fluxo explícito de agendamento por sugestão e definir o comportamento após cancelamento/reagendamento. Não usar a tabela de notificações como associação artificial entre agendamento e atendimento, pois suas constraints exigem exatamente uma das origens.

## Integração oficial futura

`src/integrations/whatsapp.ts` define somente um contrato de preparação e a estrutura de um payload de template. Os nomes `rascunho_lembrete_agendamento` e `rascunho_lembrete_retorno` são exemplos locais, não templates aprovados. Nenhuma credencial é necessária para a simulação. `src/integrations/whatsapp-meta.ts` implementa o cliente de comunicação real. Na Etapa 2, o seletor conecta esse contrato ao processamento da fila, mas um bloqueio incondicional impede construir/chamar o cliente nesse fluxo, mesmo com habilitação configurada. Criar o cliente de baixo nível não faz requisições; seu método explícito de envio é reservado a código futuro autorizado. Veja `docs/whatsapp-etapa2.md` para a política e a migração proposta, ainda não aplicada.

A Meta documenta mensagens iniciadas pela empresa com templates previamente aprovados em [controle de conversas comerciais](https://about.fb.com/news/2025/04/ways-to-manage-your-businesses-chats-on-whatsapp/). A [referência de template hospedada pela Meta](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/template/) descreve parâmetros de corpo e idioma; o SDK dessa referência está arquivado e não foi adotado como dependência. A [referência oficial da Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages) deve ser revisada na etapa de implementação do transporte real (sua leitura automatizada retornou limite de acesso nesta sessão).

Antes de uma fase de envio real, será necessário revisar a documentação vigente, aprovar os templates e a integração, definir credenciais no ambiente seguro, webhooks e recuperação de falhas. Isso é trabalho futuro, não uma capacidade habilitada nesta fase.
