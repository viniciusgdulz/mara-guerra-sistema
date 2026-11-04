# Teste manual controlado da WhatsApp Cloud API

Preparado, mas **nenhuma mensagem enviada**. O fluxo automático e a interface continuam bloqueados por código. O comando manual é separado, não abre conexão SQL, não importa a aplicação e não utiliza `.env` nem `DATABASE_URL`.

## O que falta conferir na conta Meta

Não há configuração local de teste fornecida nem acesso autenticado à sua conta nesta preparação. Portanto não foram verificados validade do token, permissões, remetente, destinatário ou disponibilidade do template remotamente.

1. Abra seu app no painel Meta for Developers, área WhatsApp/API Setup (o nome pode variar no painel). Selecione **o número de teste fornecido pela Meta**, nunca o número de produção da clínica. Copie o **Phone Number ID desse número**, que é diferente do telefone e do WABA ID.
2. Adicione **somente seu número pessoal autorizado** à lista de destinatários de teste e conclua a verificação solicitada pelo painel. Não use cadastro de pacientes.
3. Obtenha um token de teste válido para o mesmo app/número, com autorização de envio `whatsapp_business_messaging`. Confira validade e permissões no painel. Não envie o token pelo chat nem o grave em arquivo versionado.
4. Confira no exemplo de envio do painel a versão Graph API suportada e o template `hello_world`, idioma `en_US`, sem parâmetros. Este comando aceita somente esse template e idioma, sem texto clínico. Se ele não estiver disponível, interrompa e revise a configuração; não use outro template por tentativa.

A [coleção oficial da Meta — Send Test Message](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=folder-066d0881-3f31-4f0c-accc-d0fa2e4b2ed9) documenta `POST https://graph.facebook.com/{Version}/{Phone-Number-ID}/messages`, Bearer token e `hello_world/en_US`. O portal direto da Meta exigiu login nesta consulta. A configuração e a disponibilidade efetivas precisam ser conferidas no seu painel, sem requisições do projeto nesta etapa.

## Preparar localmente, sem enviar

Na raiz do projeto, em PowerShell:

```powershell
New-Item -ItemType Directory -Path .local/whatsapp-manual -Force
Copy-Item whatsapp-test.config.example.json .local/whatsapp-manual/config.json
```

Não sobrescreva um arquivo que já contenha sua configuração. Edite **somente o arquivo local** `.local/whatsapp-manual/config.json`:

| Campo | Valor a preencher |
| --- | --- |
| `accessToken` | Token de teste obtido no painel, sem espaços |
| `testPhoneNumberId` | ID numérico do remetente de teste da Meta |
| `graphApiVersion` | Versão do exemplo do painel, no formato `vN.N` |
| `authorizedRecipient` | Seu telefone pessoal com DDI e DDD, somente dígitos, sem `+` |
| `metaTestNumberConfirmed` | `true` somente depois de conferir que o ID pertence ao número de teste Meta |
| `personalRecipientVerifiedAndConsented` | `true` somente após verificar seu próprio número na lista e autorizar o teste |

O diretório é ignorado pelo Git. Proteja o arquivo com as permissões da sua conta local; não publique, compartilhe ou sincronize suas credenciais. Não coloque o token no exemplo, no `.env` da aplicação ou no histórico do terminal. Remova/revogue o token temporário após o teste.

Verifique a configuração **sem nenhuma chamada externa**:

```powershell
bun --no-env-file run whatsapp:test --check
```

O resultado mostra apenas o final do telefone e o template fixo. Essa verificação é local: não confirma que o token ainda é válido ou que a Meta aceitará a mensagem. Os dois campos booleanos são declarações suas; o programa não consegue comprovar offline que um ID pertence a um número de teste.

Não altere `WHATSAPP_PROVIDER`, `WHATSAPP_REAL_SEND_ENABLED` ou `WHATSAPP_PERSISTENCE_ENABLED`. Eles não são usados pelo comando manual e o bloqueio automático permanece intacto.

## Executar somente após autorização explícita

Quando a configuração estiver pronta, informe que a checagem passou e autorize expressamente **um único envio de teste**. Até lá, use apenas `--check`.

Depois da autorização, execute em terminal interativo:

```powershell
bun --no-env-file run whatsapp:test --send --authorize-one-test
```

Digite exatamente a frase solicitada: `AUTORIZO UM ENVIO DE TESTE`. Sem os argumentos, terminal interativo e frase exata, não há envio. A execução faz no máximo um POST, exclusivamente ao destinatário do arquivo local e com `hello_world/en_US`. Nunca há retry automático.

Antes do POST, cria `.local/whatsapp-manual/attempt.json` com criação exclusiva (`wx`). Uma segunda execução, inclusive concorrente, não envia. A reserva continua existindo após sucesso, falha, timeout ou interrupção; não a remova para repetir sem revisar o resultado e obter nova autorização.

O resultado registra somente estado, instante e `wamid`/código seguro, sem token, telefone completo, payload ou conteúdo clínico. HTTP aceito e `wamid` **não confirmam entrega**: confira a chegada no seu WhatsApp. Em timeout/resultado incerto, não execute de novo. Em código 130497, confira as restrições indicadas pela Meta; não tente contorná-las.

## Webhooks e banco

O primeiro teste manual não depende de migração, persistência SQL, App Secret ou webhook público. O `wamid` fica apenas no arquivo local da tentativa; a fila e o histórico da clínica não são alterados. Não configure o webhook para uma instância que use o Neon de produção.

Para testar posteriormente confirmação automática de entrega, será necessária outra preparação: endpoint HTTPS, App Secret, verify token, assinatura HMAC, inscrição no evento `messages` e persistência em banco isolado. O comando manual não cria notificação no banco nem faz reconciliação automática com a fila. Isso exige escopo e autorização separados.

## Verificação da preparação

Foram aprovados 19 testes novos, todos com provedor mock: verificação offline, argumentos de autorização, confirmações obrigatórias, destinatário/template fixos, reserva anterior ao envio, falhas e ausência de retry. A suíte completa sem PostgreSQL habilitado terminou com **576 testes aprovados, 16 itens ignorados e zero falhas**. Typecheck e `git diff --check` passaram. A execução de `--check` sem arquivo local recusou corretamente a operação, sem envio. Credenciais, conta Meta e entrega real continuam sem validação remota.
