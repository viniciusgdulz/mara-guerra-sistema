# Etapa 3 — Persistência durável e webhooks Meta

## Estado desta implementação

**Registro da Etapa 3.** A validação SQL mencionada como pendente adiante foi realizada na [Etapa 4](whatsapp-etapa4.md), com 001–004 e concorrência testadas somente em PostgreSQL local isolado. Não houve aplicação no Neon. O [estado consolidado](documentacao-tecnica.md) e a [validação](validacao.md) indicam as pendências atuais: conta da clínica e envio real ainda não validados. As instruções Docker abaixo são uma alternativa histórica; foi utilizado PostgreSQL 18.3 em cluster exclusivo.

Os envios externos continuam bloqueados por código no adaptador Meta, mesmo com credenciais e `WHATSAPP_REAL_SEND_ENABLED=true`. Nenhum worker, resposta automática, SDK ou chamada real à Meta foi ativado. `simulado` permanece o provedor padrão.

A persistência nova fica desabilitada por padrão (`WHATSAPP_PERSISTENCE_ENABLED=false`). A simulação e a consulta de fila antiga continuam compatíveis com o schema anterior. O processamento Meta durável e os webhooks assinados que gravam no banco exigem a flag `true` e as migrações propostas, validadas e aplicadas primeiro em banco isolado. Não existe execução automática de migrações.

## Reserva e processamento

1. Em uma transação com o mesmo advisory lock da fila, o processador valida consentimento, telefone, elegibilidade, status, previsão vencida e ausência de tentativa anterior.
2. Faz UPDATE condicional de `nao_iniciado` para `reservado`, com identificador UUID da tentativa e expiração de cinco minutos. A condição é verificada no PostgreSQL; a unicidade da tentativa também é protegida no banco.
3. Confirma a transação antes de chamar o canal. Falha de commit inicial impede a chamada. Não se mantém uma transação de banco aberta enquanto o canal responde.
4. O canal Meta desta etapa retorna bloqueio sem construir o cliente HTTP; esse resultado é persistido como `bloqueado` em outra transação, conservando o identificador da tentativa. Não volta à fila automaticamente.
5. Os caminhos de aceitação e falha são exercitados apenas com canais mockados nos testes. Aceitação salva `wamid`, instante e estado `aceita`, sem supor entrega ou preencher `data_envio`. Falha definitiva grava `falhou`; timeout/erro desconhecido grava `incerto`.
6. Finalizações conferem o identificador da tentativa, evitando que outro processamento sobrescreva o resultado. Uma reserva já confirmada permanece durável se a finalização falhar.

`POST /api/notificacoes/reconciliar`, corpo `{}`, é exclusivo de administrador e exige sessão, origem e persistência habilitada. Move reservas expiradas para `incerto` e reaplica eventos pendentes cujo `wamid` já foi vinculado. Não repete envios nem libera reservas para reutilização. A interface expõe **Reconciliar reservas e eventos (sem reenvio)** somente com persistência habilitada.

## Migrações propostas, não executadas

- `003_prepare_meta_notifications.sql` foi revisada porque ainda não foi aplicada: inclui UUID de tentativa, prazo da reserva, código numérico de falha e estado `bloqueado`, além de `wamid` e aceitação. Constraints garantem coerência e índices protegem unicidade de tentativa e `wamid`.
- `004_create_meta_webhook_events.sql` acrescenta estado/instante/código de entrega e um inbox mínimo de eventos. O UNIQUE em `(phone_number_id, meta_wamid, estado, ocorrido_em)` deduplica entregas concorrentes ou repetidas. O vínculo com a notificação é uma FK.

O inbox contém apenas identificadores técnicos, tipo/instante do evento, código numérico de erro, correlação UUID e vínculo/aplicação. Não contém telefone do paciente, texto da mensagem, App Secret, token, assinatura ou payload bruto. As mensagens recebidas dos pacientes são ignoradas.

Esses scripts não foram executados nem validados em um servidor PostgreSQL nesta sessão. Os testes atuais usam transações/SQL modelados em memória e verificações do DDL. Essa modelagem testa a orquestração e as condições SQL, mas não substitui executar as constraints e disputas em PostgreSQL real isolado. Se a versão anterior de 003 tiver sido aplicada em outro ambiente, não reaplique este arquivo: prepare antes uma migração incremental específica.

## Endpoint do webhook

URL local: `http://127.0.0.1:3000/api/webhooks/whatsapp`.

### GET — handshake

Configuração: `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. Recebe `hub.mode=subscribe`, `hub.verify_token` e `hub.challenge`, sem duplicatas. Confere o token com comparação de hashes em tempo constante e devolve o challenge literal como `text/plain`. Não acessa o banco e não precisa de sessão da clínica. Token incorreto retorna 403; parâmetros inválidos, 400; configuração ausente, 503.

### POST — eventos

Configurações: `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_PERSISTENCE_ENABLED=true` e, opcionalmente, `WHATSAPP_WABA_ID`.

O endpoint lê até 256 KiB, sem compressão, calcula HMAC-SHA256 sobre os bytes originais e compara com `X-Hub-Signature-256` (`sha256=...`) antes de decodificar JSON. Não reserializa o corpo para validar assinatura. Assinatura ausente/inválida retorna 401 sem SQL.

Somente eventos do objeto `whatsapp_business_account`, campo `messages`, produto `whatsapp` e Phone Number ID configurado são considerados. Se WABA ID estiver configurado, também filtra `entry.id`. Até cem status são processados por requisição. JSON malformado retorna 400; tamanho/lote excedido, 413; tipo/compressão incompatíveis, 415.

Os status `sent`, `delivered`, `read` e `failed` são persistidos de forma transacional. A resposta 200 ocorre somente depois do commit. Falha de banco/configuração/migração retorna 503 para não confirmar um evento que não ficou durável. Tipos, números/contas e status desconhecidos são ignorados com 200, sem ações externas. Não há resposta automática a mensagens.

O endpoint não usa cookie nem Origin do navegador, pois a autenticação externa é a assinatura da Meta. Essa exceção vale somente para o caminho exato do webhook; as APIs administrativas continuam com sessão/perfil/origem existentes. GET não altera a autorização de POST: token de verificação e App Secret têm funções diferentes.

## Ordenação, duplicidade e resultados incertos

- A aceitação HTTP e o `wamid` não marcam a mensagem como entregue.
- A projeção avança de `nao_confirmada` para `sent`, `delivered` ou `read`, sem exigir eventos intermediários. Eventos mais fracos não fazem regressão.
- `failed` pode substituir ausência de confirmação ou `sent`, desde que não seja anterior ao `sent` já conhecido. Não substitui `delivered`/`read`.
- Uma prova posterior de `delivered`/`read` pode superar `failed`. `sent` sozinho não apaga uma falha já registrada.
- Todos os eventos reconhecidos são registrados, inclusive os obsoletos. Os obsoletos são marcados como aplicados sem alterar a projeção; duplicatas não criam novo evento nem nova aplicação.
- `sent`/`delivered`/`read` verificados podem atualizar o status legado para `enviada`; `failed` pode atualizar para `falhou`. O estado específico de entrega fica nos novos campos. `data_envio` usa o instante do primeiro evento positivo aplicado, que pode ser de entrega/leitura se o evento sent ainda não chegou; o inbox preserva os instantes de cada evento para investigação.
- Cancelamento administrativo continua `cancelada`, mesmo que um callback tardio comprove entrega. Os metadados de entrega são preservados separadamente: cancelar não desfaz algo já enviado externamente.

Um evento com `wamid` ainda desconhecido fica no inbox, sem associação por telefone. Quando o HTTP persiste esse ID, os eventos pendentes são reconciliados na mesma transação.

Para timeout sem ID persistido, o payload de envio preparado inclui `biz_opaque_callback_data` com **somente o UUID da notificação**. Um status assinado que devolva essa correlação pode vincular o `wamid` a uma tentativa `reservado`/`incerto` e reconciliá-la, verificando a janela da tentativa. Não associa tentativas não iniciadas/bloqueadas. Se não houver `wamid` conhecido nem correlação confiável, o evento permanece órfão e a tentativa continua incerta: não há inferência por telefone nem reenvio automático. Uma resposta HTTP tardia ou um timeout não sobrescrevem aceitação já comprovada por webhook.

## Configurar um PostgreSQL local isolado — instruções, não executadas

Use um banco descartável **sem pacientes reais**, nunca a URL atual do Neon. Exemplo com Docker instalado, em PowerShell:

```powershell
docker run --name mara-meta-test -e POSTGRES_PASSWORD=apenas_teste_local -e POSTGRES_DB=mara_meta_test -p 127.0.0.1:55432:5432 -d postgres:17
```

Após o PostgreSQL estar pronto, revise os scripts e aplique somente nesse container:

```powershell
foreach ($arquivoMeta in @('001_create_tables.sql', '002_create_auth_tables.sql', '003_prepare_meta_notifications.sql', '004_create_meta_webhook_events.sql')) {
  docker cp "sql/$arquivoMeta" "mara-meta-test:/tmp/$arquivoMeta"
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao copiar o script para o banco isolado.' }
  docker exec mara-meta-test psql -U postgres -d mara_meta_test -v ON_ERROR_STOP=1 -f "/tmp/$arquivoMeta"
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao aplicar script no banco isolado.' }
}
```

Execute a aplicação em um terminal separado com variáveis locais explícitas (valores abaixo são fictícios), sem editar/substituir credenciais do Neon:

```powershell
$env:DATABASE_URL = 'postgresql://postgres:apenas_teste_local@127.0.0.1:55432/mara_meta_test'
$env:WHATSAPP_PROVIDER = 'meta'
$env:WHATSAPP_PERSISTENCE_ENABLED = 'true'
$env:WHATSAPP_REAL_SEND_ENABLED = 'false'
$env:WHATSAPP_PHONE_NUMBER_ID = '123456789012345'
$env:WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-apenas-teste-local'
$env:WHATSAPP_APP_SECRET = 'secret-apenas-teste-local'
bun run dev
```

Mesmo se a flag de envio for alterada para true, o bloqueio de código permanece. Processar no canal Meta apenas registra a reserva e o bloqueio. O banco isolado precisa de uma conta administrativa de teste e registros fictícios para validar a interface; não reutilize pacientes reais. Os testes `bun test tests/meta-stage3.test.ts` já exercitam o endpoint com HMACs e banco simulados sem abrir qualquer banco ou conexão externa.

## Configuração futura na Meta

Somente em etapa autorizada: publicar uma URL HTTPS própria, cadastrar o Callback URL e o mesmo verify token no painel da Meta e assinar o campo de mensagens/status do número de teste. Configurar App Secret e identificadores no ambiente seguro. Validar primeiro o GET e o POST assinado com fixtures locais. Não publicar um túnel para o banco atual da clínica nesta etapa.

Não registrar URLs de verificação completas no proxy, pois o protocolo leva verify token na query. Os módulos novos não possuem logs de corpo, headers, secrets ou telefone completo. Definir retenção/limpeza do inbox e monitoramento por contagens/códigos antes de produção; não há limpeza automática nesta etapa.

Referências primárias: [verificação de webhooks no repositório da Meta](https://github.com/WhatsApp/WhatsApp-Nodejs-SDK/blob/main/website/docs/api-reference/webhooks/start.md) (referência histórica; SDK arquivado não instalado) e [payloads oficiais de status da Meta](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api). O portal direto da Meta retornou HTTP 429 na consulta automatizada.

## Falta para teste real controlado

Validar as migrações/constraints/concorrência em PostgreSQL isolado; ensaiar perda de conexão, crash após reserva e commit/finalização ambíguos; revisar escopo e retenção dos webhooks. Configurar templates aprovados, número de teste, token com permissões e lista explícita de destinatários autorizados (essa lista ainda não foi implementada). Aprovar uma alteração de código para liberar somente esse teste e revisar a janela de revalidação de consentimento após o commit da reserva. Nenhuma flag remove hoje o bloqueio. Não existe retry automático, reabertura de tentativas ou rotina que transforme incerto em novo envio.
