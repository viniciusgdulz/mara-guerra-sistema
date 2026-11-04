# Histórico de implementação por fases

Registro preservado das Fases 4–9 e das etapas iniciais da integração. Alguns trechos descrevem o estado na época, incluindo pendências já resolvidas. Para o estado consolidado atual, consulte [documentação técnica](documentacao-tecnica.md), [validação](validacao.md) e [README](../README.md).

# Sistema Mara Guerra Estética Avançada

Projeto de extensão universitária. Monólito simples com backend TypeScript e frontend HTML, CSS e JavaScript puro, servidos pelo mesmo processo HTTP.

## Execução local

Requisito: **Bun 1.3.14**, indicado em `.bun-version`, `packageManager` e `engines`.

```powershell
bun --version
bun install
Copy-Item .env.example .env
bun run dev
```

Abra http://127.0.0.1:3000. O Bun carrega `.env` automaticamente. A cópia é opcional se os valores padrão forem suficientes; `HOST` e `PORT` configuram o endereço local.

Para iniciar sem observar alterações, use `bun start`.

## Arquivos

- `src/app.ts`: rotas HTTP e lista explícita dos arquivos públicos permitidos.
- `src/server.ts`: validação de porta e inicialização com `Bun.serve()`.
- `public/index.html`: página inicial em português.
- `public/css/styles.css`: estilos responsivos.
- `public/js/app.js`: autenticação, cadastro, pesquisa e listagem de pacientes.
- `tests/server.test.ts`: testes HTTP com o executor nativo do Bun e porta temporária.
- `package.json`: scripts e dependências apenas de desenvolvimento.
- `bun.lock`: versões resolvidas das dependências.
- `tsconfig.json`: TypeScript estrito, sem emissão de arquivos.
- `.gitignore`: exclui dependências, segredos locais e arquivos gerados.
- `.env.example`: configuração local e exemplo comentado para PostgreSQL futuro.
- `.bun-version`: versão esperada do runtime.

Novos arquivos públicos devem ser registrados em `src/app.ts`.

## Rotas e verificações

- `GET /` e `GET /index.html`: página inicial.
- `GET /css/styles.css` e `GET /js/app.js`: arquivos estáticos.
- `GET /api/health`: `{"status":"ok","message":"Servidor funcionando"}`.

As rotas também aceitam `HEAD`. Caminhos desconhecidos retornam 404 e métodos não suportados retornam 405.

```powershell
bun test
bun run typecheck
```

Os testes verificam saúde, HTML, CSS, JavaScript, respostas 404/405 e HEAD através de um servidor HTTP real.

## Futuras implementações

PostgreSQL no Neon é acessado pelo cliente SQL nativo do Bun em `src/db/connection.ts`.
Os arquivos SQL versionados são revisados e executados separadamente; o servidor não aplica migrações automaticamente.

A autenticação utiliza Argon2id nativo via `Bun.password`, selecionando explicitamente o algoritmo `argon2id`, sem biblioteca de hash adicional.

O cadastro de pacientes está descrito na Fase 5 abaixo. A Fase 9 prepara notificações WhatsApp em modo exclusivamente simulado, sem envios reais.

## Autenticação e execução local

As tabelas de autenticação estão definidas em `sql/002_create_auth_tables.sql`.
O servidor não executa SQL de criação nem cadastra usuários ao iniciar.
Configure `DATABASE_URL` no `.env` da raiz, mantenha esse arquivo fora do Git e execute:

```powershell
bun run dev
```

Abra http://127.0.0.1:3000. A página permite entrar, consultar nome/perfil e sair.
Para testar o login bem-sucedido é necessária uma conta previamente criada de forma autorizada.
Nenhuma conta é fornecida por padrão. Sem conta, é possível revisar a tela e suas mensagens;
os testes automatizados verificam o fluxo completo com SQL simulado, sem acessar o Neon.

O comando abaixo é uma operação separada que **grava no banco configurado**.
Execute-o somente quando autorizar a criação real do primeiro administrador:

```powershell
bun run admin:create
```

O script exige um terminal interativo, solicita nome/e-mail e senha com confirmação oculta,
não aceita argumentos e recusa a criação se já houver administrador, inclusive inativo.
Usa o serviço de cadastro existente e uma transação com bloqueio contra execuções concorrentes.
Não há cadastro público. Não coloque senhas em comandos, arquivos ou logs.

### Rotas e proteção

- `POST /api/auth/login`: verifica senha e usuário ativo e cria a sessão.
- `POST /api/auth/logout`: remove a sessão e limpa o cookie.
- `GET /api/auth/me`: verifica a sessão e retorna somente id, nome, e-mail e perfil.
- `/api/admin` e seus subcaminhos: exigem sessão e perfil administrador;
  retornam 404 após autorização, pois ainda não existem funcionalidades administrativas.
- `/api/health` e os arquivos públicos do login continuam acessíveis sem sessão.

Controllers futuros devem verificar sessão e `temPerfil()` antes de consultar dados de negócio.
`temPerfil(usuario, ["administrador"])` permite somente administradores;
`temPerfil(usuario, ["administrador", "funcionario"])` permite os dois perfis.
As rotas de pacientes permitem cadastro e consulta para os dois perfis. O histórico de atendimentos é exclusivo de administradores, conforme a Fase 7.

Senhas usam Argon2id. Tokens aleatórios de 32 bytes ficam somente no cookie HttpOnly,
SameSite=Strict; o banco armazena seu SHA-256. Não se usa localStorage.
O servidor verifica usuário ativo, expiração absoluta de 8 horas e inatividade de 30 minutos
ao validar a sessão. A sessão não é renovada por consultas periódicas da interface.
Logout exclui a sessão; um novo login substitui a sessão enviada pelo mesmo navegador.
Sessões expiradas não autorizam acesso, mesmo que seus registros ainda existam no banco.

Login e logout exigem o cabeçalho Origin correspondente à aplicação; login exige JSON,
com limite de 4 KiB. Há limite de 5 tentativas por e-mail em 15 minutos e 60 tentativas
globais por minuto. O limitador fica em memória, reinicia com o processo e é adequado
a uma instância; antes de usar várias instâncias, será necessário compartilhar esses limites.

### Produção

Configure `NODE_ENV=production` e `APP_ORIGIN` com a origem HTTPS pública exata,
por exemplo `https://clinica.example`, sem barra final. Use HTTPS no acesso público
(diretamente ou no proxy da hospedagem). A origem é configurada explicitamente;
o servidor não confia em cabeçalhos encaminhados para decidir a origem autorizada.
Em produção o cookie usa `Secure` e o prefixo `__Host-`, sem atributo Domain.
Em desenvolvimento HTTP local, o cookie não usa Secure. Não use esse modo em produção.

Os testes de autenticação e primeiro administrador usam clientes SQL simulados e hashes
locais do Bun. Eles não criam contas nem sessões no Neon. Execute `bun test` e
`bun run typecheck` para verificar o projeto.

Referências oficiais: [servidor HTTP do Bun](https://bun.sh/docs/runtime/http/server) e [Bun.password](https://bun.sh/reference/bun/password).

## Fase 5 — Cadastro de pacientes

Utiliza a tabela `pacientes` definida em `sql/001_create_tables.sql`, sem alterar o schema.
O schema foi conferido no arquivo versionado; esta implementação não consultou nem gravou no Neon.

- `POST /api/pacientes`: nome e telefone obrigatórios; e-mail e data de nascimento opcionais. Retorna 201.
- `GET /api/pacientes?nome=Maria&pagina=1`: pesquisa parcial por nome, sem distinguir maiúsculas e minúsculas. Nome vazio lista todos.
- A resposta da consulta contém `pacientes`, `pagina` e `temMais`, com até 50 pacientes por página, ordenados por nome e id.
- Ambas exigem sessão válida e perfil `administrador` ou `funcionario`. O cadastro exige Origin autorizado, JSON e corpo de até 4 KiB.
- Nome: 1–150 caracteres após remover espaços das extremidades. Telefone: 8–15 dígitos, até 20 caracteres, permitindo espaços, `+`, parênteses, ponto e hífen.
- E-mail: até 254 caracteres, normalizado para minúsculas. Opcionais ausentes, nulos ou vazios são armazenados como NULL.
- Nascimento: `AAAA-MM-DD`, data existente e não futura, considerando o dia de São Paulo.
- SQL parametrizado, seleção explícita de dados cadastrais e respostas sem cache. Não retorna histórico clínico.
- Não há edição, exclusão ou detecção de duplicidade nesta versão. Consentimento WhatsApp mantém os valores padrão do banco.

Os arquivos principais são `src/services/pacientes.service.ts`, `src/controllers/pacientes.controller.ts`
e `tests/pacientes.test.ts`. Os testes usam SQL simulado e não acessam o Neon.

### Testar no navegador

1. Com o `.env` já configurado e uma conta existente, execute `bun run dev` e abra http://127.0.0.1:3000.
2. Entre como administrador ou funcionário e abra **Pacientes** no menu. A listagem e a pesquisa aparecem primeiro; **Novo paciente** abre o cadastro.
3. Confira a busca por nome, a mensagem de lista vazia e a navegação quando houver mais de 50 resultados.
4. Para testar a gravação, use um banco separado de desenvolvimento com o schema existente. Configure seu `DATABASE_URL` antes de iniciar o servidor. Clicar em **Cadastrar paciente grava no banco configurado**; não use dados fictícios no Neon da clínica.
5. No banco de desenvolvimento, cadastre somente nome e telefone; depois teste os opcionais. Confira a confirmação e a atualização da lista. Nome vazio, telefone inválido, e-mail inválido ou nascimento futuro devem ser recusados com mensagem clara.
6. Saia da conta: formulário e lista são limpos. Sem sessão, chamadas à API retornam 401. Repita com o outro perfil para conferir acesso equivalente.

Validação automatizada: `bun test` e `bun run typecheck`. Nenhum comando de migração ou de inserção no Neon é necessário para esses testes.

## Fase 6 — Cadastro de procedimentos

Utiliza a tabela `procedimentos` de `sql/001_create_tables.sql`, conferida no schema versionado antes da implementação. Não há migração nem execução de comandos no Neon durante a implementação ou nos testes automatizados.

- Administrador: cadastra, consulta todos os procedimentos (ativos e inativos), edita e inativa.
- Funcionário: consulta somente os ativos; o filtro é aplicado no SQL com base no perfil da sessão, independentemente de parâmetros enviados pelo cliente.
- `GET /api/procedimentos?nome=teste&pagina=1`: pesquisa parcial sem distinguir maiúsculas/minúsculas. Nome vazio lista o catálogo permitido. Até 50 registros por página, ordenados por nome e id; resposta com `procedimentos`, `pagina` e `temMais`.
- `POST /api/procedimentos`: cadastra como ativo, com `{ "nome": "Nome", "descricao": null, "intervalo_retorno_dias": null }`. Retorna 201.
- `PUT /api/procedimentos/:id`: substitui nome, descrição e intervalo, preservando o status atual. Retorna 200 ou 404 para registro ausente.
- `POST /api/procedimentos/:id/inativar`: define `ativo = false`. Repetir a operação mantém o registro inativo. Retorna 200 ou 404.
- Não há exclusão permanente nem reativação nesta versão. Editar um inativo não o reativa. Não há detecção de duplicidade.

Nome obrigatório com 1–150 caracteres após remover espaços das extremidades. Descrição opcional com limite de aplicação de 4000 caracteres. Intervalo opcional, inteiro entre 1 e 2147483647 (limite de INTEGER do PostgreSQL), em dias. Opcionais ausentes ou nulos são armazenados como NULL; descrição vazia também. No JSON, intervalo deve ser número ou null, sem strings. Na edição, opcionais omitidos são limpos. Campos adicionais são rejeitados; o status só muda pela rota de inativação.

Todas as rotas verificam sessão e perfil no backend. Operações de escrita exigem origem autorizada; cadastro e edição exigem JSON com corpo de até 32 KiB. As consultas são parametrizadas, retornam somente campos do catálogo e não são armazenadas em cache. Cookies, prazos de sessão e autenticação existentes foram preservados.

Implementação em `src/services/procedimentos.service.ts`, `src/controllers/procedimentos.controller.ts` e `public/js/procedimentos.js`. Os testes em `tests/procedimentos.test.ts` usam SQL simulado, sem conexão com o Neon.

### Testar procedimentos no navegador

1. Execute `bun run dev` e abra http://127.0.0.1:3000 com uma conta existente. Abra **Procedimentos** no menu.
2. Como administrador, confira a pesquisa, os status e as ações de edição/inativação; **Novo procedimento** abre o formulário. Como funcionário, confira que somente o catálogo ativo e a pesquisa aparecem.
3. Para testar gravações, configure previamente `DATABASE_URL` para um banco separado de desenvolvimento com o schema existente. Os botões de cadastro, edição e inativação gravam no banco configurado; não insira procedimentos fictícios no Neon da clínica.
4. No banco de desenvolvimento, cadastre somente o nome e depois teste descrição e intervalo. Confira as mensagens de sucesso, a atualização da lista, os erros para nome vazio e intervalos zero, negativos ou fracionários.
5. Edite um registro e salve; teste também **Cancelar edição**. Inative um ativo e confirme a ação. Ele deve continuar visível ao administrador como Inativo e desaparecer para funcionários. Editar um inativo deve preservar esse status.
6. Confira pesquisa, lista vazia e paginação com mais de 50 resultados. Saia da conta e confirme que o catálogo e o formulário são limpos. Sem sessão, a API retorna 401; funcionário tentando escrita diretamente recebe 403.

Execute `bun test`, `bun run typecheck` e `git diff --check` para validar sem acessar o banco. A verificação visual manual da Fase 6 no navegador deve ser realizada separadamente.

## Fase 7 — Histórico de atendimentos

Reutiliza `atendimentos`, conferida em `sql/001_create_tables.sql`, sem mudanças no schema. A implementação e os testes não conectam ao Neon nem inserem dados nele.

Somente administradores podem registrar, consultar ou ajustar o retorno de atendimentos. A autorização ocorre no backend antes de acessar dados clínicos, incluindo subcaminhos e o catálogo de seleção. Funcionários continuam podendo consultar pacientes e procedimentos pelas rotas cadastrais, sem receber histórico clínico.

- `POST /api/atendimentos`: recebe `paciente_id`, `procedimento_id`, `data_atendimento` (`AAAA-MM-DD`) e, opcionalmente, `data_retorno_sugerida`. Retorna 201 com `atendimento`.
- Sem o campo de retorno, calcula a data somando o intervalo atual do procedimento à data do atendimento. Sem intervalo configurado, salva NULL. O cálculo usa dias de calendário em UTC, sem deslocamento por horário de verão.
- O retorno pode ser informado manualmente, inclusive para procedimentos sem intervalo. `null` remove a sugestão; string vazia não é aceita na API. A interface converte o campo manual vazio em null.
- `PATCH /api/atendimentos/:id/retorno`: recebe somente `data_retorno_sugerida` (data ou null) e permite ajustar registros existentes, inclusive de procedimentos posteriormente inativados. Retorna 200 ou 404.
- `GET /api/atendimentos?paciente_id=UUID&pagina=1`: retorna `atendimentos`, `pagina`, `temMais`; até 50 por página, do mais antigo ao mais recente, com desempate por id. Paciente inexistente retorna 404; paciente sem registros retorna lista vazia.
- `GET /api/atendimentos/procedimentos?nome=texto&pagina=1`: catálogo paginado de seleção, sempre limitado a procedimentos ativos, mesmo para administradores. A seleção de pacientes reutiliza a busca paginada existente.

Datas devem existir e estar entre os anos 0001 e 9999. Atendimento não pode ser futuro (dia de São Paulo); retorno não pode ser anterior ao atendimento. Intervalo automático que ultrapasse o ano 9999 retorna erro claro e permite escolha manual. UUIDs e campos extras são validados. Escritas exigem JSON, corpo de até 4 KiB e origem autorizada. SQL parametrizado e respostas com `Cache-Control: no-store` preservam as proteções existentes.

O registro usa transação com bloqueios de leitura do paciente e procedimento: recusa paciente ausente ou procedimento inativo/ausente e impede alteração/inativação concorrente do procedimento até concluir a inserção. O ajuste de retorno bloqueia o atendimento enquanto valida e atualiza somente essa data. Não há edição de paciente/procedimento/data do atendimento, exclusão ou envio de notificações nesta fase.

O histórico consulta procedimentos ativos e inativos, sem recalcular o retorno salvo ao alterar intervalos do catálogo. O nome exibido é o nome atual do procedimento; o schema existente não possui cópia histórica do nome. A interface limpa os dados ao sair ou perder o perfil administrador e descarta respostas atrasadas. Não consulta o histórico periodicamente.

### Validar a Fase 7 no navegador

1. Execute `bun run dev`, abra http://127.0.0.1:3000 e entre como administrador. Abra **Atendimentos** no menu para consultar o histórico; **Registrar atendimento** abre o formulário.
2. Pesquise um paciente, selecione-o e confira o histórico ou a mensagem de lista vazia. Use a paginação das opções para encontrar registros além da primeira página.
3. Pesquise um procedimento ativo, selecione a data e confira a prévia do retorno. Sem intervalo, deve aparecer a indicação de retorno não configurado. **Ajustar retorno manualmente** permite uma data própria ou nenhum retorno.
4. Para testar registro, ajuste e inativação, use exclusivamente um banco separado de desenvolvimento com o schema existente, configurado em `DATABASE_URL` antes de iniciar o servidor. Esses botões gravam no banco configurado; não faça testes de escrita no Neon da clínica.
5. No banco de desenvolvimento, registre e confira a confirmação com o retorno efetivamente calculado no backend. Teste mudança de mês/ano, retorno manual e recusa de datas inválidas, futuras ou retorno anterior ao atendimento.
6. Use **Ajustar retorno** em uma linha do histórico: informe `AAAA-MM-DD` ou deixe vazio para remover. Confira a atualização. Inative o procedimento no catálogo: ele deve sair da seleção de novos atendimentos, mas permanecer no histórico anterior.
7. Entre como funcionário: a seção deve desaparecer. Uma chamada direta a `/api/atendimentos?paciente_id=UUID` deve retornar 403; sem sessão, 401. Saia da conta e confira que dados e seleções foram limpos.

Execute `bun test`, `bun run typecheck` e `git diff --check`. Os testes novos usam transações SQL simuladas e uma interface DOM simulada para verificar a limpeza de dados e o descarte de respostas após logout ou mudança de perfil. A validação manual em navegador é separada.

## Navegação da interface

Após o login, o sistema abre **Início**, com o nome do usuário e os atalhos **Novo paciente** e **Consultar pacientes**. Administradores também veem **Registrar atendimento** e a opção **Atendimentos** no menu.

O menu alterna uma tela por vez, sem recarregar a página ou fazer novas requisições somente pela troca de tela. O item ativo usa destaque visual e `aria-current`. Botões nativos permitem navegação por Tab e acionamento por Enter/Espaço. Ao mudar de tela, o foco vai para o título; ao abrir um formulário, para seu primeiro campo. No celular, o menu se organiza em duas colunas.

- **Pacientes:** abre pesquisa e lista. **Novo paciente** ou o atalho inicial abre o cadastro. Cancelar limpa os campos e retorna à lista. Cadastro confirmado fecha o formulário, atualiza a lista e mantém a mensagem de sucesso; erro mantém o formulário disponível.
- **Procedimentos:** abre o catálogo. Administradores podem abrir cadastro ou edição; cancelar e salvar retornam à consulta. Funcionários continuam apenas com o catálogo ativo. Inativação continua na listagem com confirmação.
- **Atendimentos:** abre consulta e seleção de paciente. O registro só aparece após **Registrar atendimento**. **Voltar ao histórico** mantém paciente, pesquisa, página do histórico e rascunho do registro. Salvar fecha o registro e atualiza o histórico. A seleção de paciente fica disponível também durante o cadastro.

Ao trocar de tela pelo menu, os editores são fechados e as consultas preservadas. A revalidação da sessão ao retornar à janela mantém a tela atual. Logout limpa os dados e o próximo login volta a Início. A navegação não modifica regras do backend, cookies, prazos de sessão ou proteção de origem.

Para validar no navegador, execute `bun run dev` e abra http://127.0.0.1:3000:

1. Entre nos dois perfis e confira o menu, os atalhos e uma única tela visível por vez.
2. Em Pacientes, abra e cancele o cadastro; repita pelo atalho de Início. Em Procedimentos, como administrador, abra e cancele o cadastro e a edição.
3. Em Atendimentos, selecione um paciente, abra o registro e volte ao histórico; confirme que a seleção e a consulta permanecem. Alterne entre telas e retorne à janela para conferir que nenhum formulário abre sozinho.
4. Confira mensagens de erro/sucesso e retorno à consulta após salvar somente em banco separado de desenvolvimento. Não teste escritas no Neon da clínica.
5. Use Tab, Enter e Espaço para navegar. Reduza a janela à largura de celular e confira menu, botões, campos e rolagem das tabelas.
6. Como funcionário, confirme a ausência de gerenciamento de procedimentos e do menu/atalho Atendimentos. As restrições também continuam verificadas nas APIs.

`tests/navigation-ui.test.ts` carrega o HTML e os scripts com DOM e API simulados para testar a integração sem banco ou rede. Execute `bun test`, `bun run typecheck` e `git diff --check`; a validação visual manual é separada.

## Fase 8 — Agendamentos e retornos

Schema conferido em `sql/001_create_tables.sql`: `agendamentos` tem paciente obrigatório, procedimento opcional no banco, horário TIMESTAMPTZ e status restritos; `atendimentos` armazena a data sugerida de retorno. A aplicação exige procedimento ativo para novos agendamentos e reagendamentos. Não há migração nem execução de comandos no Neon durante a implementação ou nos testes.

A tela **Agenda** fica disponível aos dois perfis e inicia em consulta do dia atual. A primeira abertura carrega a agenda; a navegação entre as outras telas permanece sem recarga. Há botões de dia anterior, próximo dia e hoje, pesquisa por nome do paciente, paginação de 50 registros e formulários abertos somente sob demanda. Datas e horários são interpretados e exibidos em `America/Sao_Paulo`, independentemente do fuso do navegador/servidor. Horários são informados com precisão de minutos; horários inexistentes durante mudanças históricas de fuso são recusados.

| Ação | Administrador | Funcionário |
| --- | --- | --- |
| Criar, consultar, reagendar e cancelar | Sim | Sim |
| Concluir agendamento | Sim | Não |
| Consultar e agendar sugestões de retorno | Sim | Não |
| Consultar histórico clínico | Sim, nas rotas da Fase 7 | Não |

O backend verifica sessão, perfil e origem em cada operação. A agenda comum retorna somente campos do agendamento, nome e telefone do paciente e nome do procedimento; não consulta atendimentos. As rotas de retornos são exclusivas de administradores, inclusive acesso direto pela API. Escritas exigem JSON, até 4 KiB, campos conhecidos e dados válidos. Consultas são parametrizadas e respostas usam `Cache-Control: no-store`. A autenticação existente foi preservada.

### Status e regras

- **Agendado** corresponde a `pendente`. Registros existentes `confirmado` aparecem como **Agendado (confirmado)** e continuam podendo ser reagendados, cancelados ou concluídos.
- **Concluído** corresponde a `realizado`; **Cancelado** a `cancelado`. Registros existentes `nao_compareceu` são exibidos como **Não compareceu**.
- Somente registros em aberto (`pendente` ou `confirmado`) podem ser reagendados ou encerrados. Não há reabertura ou exclusão permanente. Repetir o mesmo encerramento é idempotente.
- Reagendar mantém o paciente e o status, permite escolher outro procedimento ativo e altera data/horário. Agendamentos antigos sem procedimento ou com procedimento hoje inativo permanecem consultáveis; para reagendar, selecione um procedimento ativo.
- Duplicidade é o mesmo paciente no mesmo instante, em qualquer procedimento, exceto agendamentos cancelados. Registros concluídos e de não comparecimento continuam ocupando esse instante para o paciente. Outros pacientes podem ter o mesmo horário: não há controle de sala/profissional/duração nesta fase.
- Cadastro, reagendamento e criação por sugestão usam transações e bloqueio do paciente (`FOR UPDATE`), com conferência de duplicidade antes de gravar. A checagem de procedimento ativo usa `FOR SHARE`. Isso serializa as operações realizadas por estas rotas, inclusive requisições concorrentes. O schema não tem restrição UNIQUE de horário; gravações externas que ignorem esse protocolo não recebem essa garantia.
- Concluir não cria atendimento clínico automaticamente. O registro clínico continua sendo realizado separadamente por administrador em Atendimentos. Não há envio de WhatsApp ou criação de notificações.

### Rotas

- `GET /api/agenda?data=AAAA-MM-DD&nome=texto&pagina=1`: consulta por dia de São Paulo e pesquisa parcial por nome. Resposta: `agendamentos`, `pagina`, `temMais`.
- `POST /api/agenda`: recebe `paciente_id`, `procedimento_id`, `data` (`AAAA-MM-DD`) e `hora` (`HH:MM`). Retorna 201 com `agendamento`, status inicial `pendente`.
- `PUT /api/agenda/:id`: recebe `procedimento_id`, `data` e `hora`. Retorna 200.
- `PATCH /api/agenda/:id/status`: recebe somente `status` (`cancelado` ou `realizado`). Retorna 200; `realizado` exige administrador.
- `GET /api/agenda/procedimentos?nome=texto&pagina=1`: catálogo ativo de seleção para ambos os perfis.
- `GET /api/agenda/retornos?inicio=AAAA-MM-DD&fim=AAAA-MM-DD&pagina=1`: exclusivo de administrador, período de até 366 dias. Retorna `retornos`, `pagina`, `temMais`; cada sugestão inclui identificador, paciente, procedimento, data sugerida e indicação de procedimento ativo.
- `POST /api/agenda/retornos/:sugestao_id/agendar`: exclusivo de administrador; recebe somente `data` e `hora`. Paciente e procedimento são obtidos no backend a partir da sugestão existente. Exige que o procedimento continue ativo. Retorna 201.

Datas devem existir, entre os anos 0001 e 9999, e horários devem estar entre 00:00 e 23:59. É possível registrar/reagendar datas passadas para organizar a agenda existente; não há bloqueio de antecedência nesta fase. Ausência de paciente/agendamento/sugestão retorna 404; conflito de horário ou status encerrado retorna 409; validação retorna 400. Falhas inesperadas retornam mensagem segura.

As sugestões de retorno não geram agendamentos automaticamente. O administrador consulta um período, clica em **Agendar retorno**, escolhe horário e confirma o cadastro. É permitido ajustar a data sugerida para o horário disponível. Procedimentos inativos permanecem visíveis nas sugestões, com indicação da indisponibilidade. A Fase 9 acrescenta indicação de possível agendamento correspondente (mesmo paciente/procedimento entre a data sugerida e os 30 dias seguintes); a sugestão continua visível, mas sem botão para repetir a reserva a partir daquela linha. Esse critério é aproximado e não substitui um vínculo explícito no schema. Nenhuma sugestão é marcada como atendida automaticamente.

### Validar a Fase 8 no navegador

1. Execute `bun run dev`, abra http://127.0.0.1:3000 e entre com uma conta existente. Abra **Agenda**; confira o dia atual, os botões entre datas e a pesquisa por paciente.
2. Como funcionário, confira que não há seção Retornos nem ação Concluir. Como administrador, confira ambas. As restrições também são verificadas nas APIs, não apenas na tela.
3. Clique **Novo agendamento**, pesquise paciente e procedimento ativo usando os seletores paginados e escolha data e horário. **Cancelar e voltar à agenda** fecha o formulário sem gravar.
4. Testes de escrita devem usar exclusivamente um banco separado de desenvolvimento com o schema existente, configurado em `DATABASE_URL` antes de iniciar o servidor. Não insira dados fictícios no Neon da clínica.
5. Nesse banco separado, salve um agendamento e confira a confirmação e a agenda do dia escolhido. Tente repetir paciente/data/horário e confira a mensagem de duplicidade. Reagende; cancele com confirmação; como administrador, conclua um agendamento em aberto. Registros encerrados devem continuar visíveis sem ações de alteração.
6. Como administrador, consulte Retornos por período. **Agendar retorno** somente abre o formulário; escolha horário e salve explicitamente. Confira paciente/procedimento corretos. Uma sugestão com procedimento inativo deve permanecer visível, sem botão para agendar esse procedimento.
7. Teste teclado (Tab/Enter), visualização no celular, mensagens, paginação e logout. Confirme que a sessão expirada limpa a tela e que funcionários recebem 403 nas rotas de retornos e ao tentar concluir.

Arquivos principais: `src/services/agenda.service.ts`, `src/controllers/agenda.controller.ts` e `public/js/agenda.js`. `tests/agenda.test.ts` usa SQL e transações simulados, incluindo disputa concorrente pelo mesmo horário. `tests/navigation-ui.test.ts` cobre a integração da Agenda, envio explícito de retorno, cancelamento de edição, mensagens e descarte de respostas após mudança de perfil. Execute `bun test`, `bun run typecheck` e `git diff --check`, sem conexão com o Neon. A validação visual manual no navegador é separada.

## Fase 9 — Preparação de notificações WhatsApp

**O fluxo da Fase 9 permanece exclusivamente simulado, sem envio real ou exigência de credenciais.** O cliente real isolado, descrito ao final deste documento, não é utilizado por esse fluxo. O schema foi conferido em `sql/001_create_tables.sql`. Nenhuma migração, conexão ou gravação no Neon foi executada durante a implementação e os testes.

### Consentimento explícito

Em **Pacientes**, a ação **Consentimento WhatsApp** consulta o estado atual. Administrador e funcionário podem registrar a manifestação explícita de autorização ou revogação; a confirmação começa desmarcada e é obrigatória para ambas as ações. Cadastro, telefone, agendamento e atendimento não concedem autorização automaticamente.

- `GET /api/pacientes/:id/consentimento-whatsapp`: retorna somente id, estado atual e data da autorização.
- `PATCH /api/pacientes/:id/consentimento-whatsapp`: recebe `consentimento_whatsapp` booleano e `confirmacao_explicita: true`. A data é gerada pelo servidor e mantida em autorizações repetidas.
- Revogar limpa a data e cancela notificações `pendente`/`falhou` do paciente na mesma transação. A constraint existente exige timestamp NULL quando o consentimento é falso; o banco não guarda data de revogação ou histórico de consentimentos.

### Notificações administrativas

Somente administradores veem o menu **Notificações** e acessam suas APIs. A tela começa em consulta, tem filtro de status, paginação de 50 registros, prévia discreta, diagnóstico atual e ações de gerar/atualizar fila, simular preparação e cancelar. Funcionários continuam sem acesso a notificações, sugestões de retorno e histórico clínico.

- `GET /api/notificacoes?status=pendente&pagina=1`: retorna `notificacoes`, `pagina`, `temMais` e `modo: simulado`. Status vazio lista todos. Status permitidos: `pendente`, `enviada`, `cancelada`, `falhou`.
- `POST /api/notificacoes/gerar`: recebe `{}` e retorna contagens de geradas, atualizadas e canceladas.
- `POST /api/notificacoes/:id/simular`: recebe `{}` e prepara um payload usando o provedor simulado. Não exige aguardar a previsão: serve para validar a preparação antecipadamente, sem envio.
- `POST /api/notificacoes/:id/cancelar`: recebe `{}` e cancela somente registros ainda não enviados.

Escritas exigem origem autorizada, JSON de até 4 KiB e campos conhecidos. Nenhuma rota permite escolher arbitrariamente `status` ou `data_envio`. SQL parametrizado, sessão, perfis e respostas sem cache preservam as proteções existentes.

### Critérios e segurança da fila

- Agendamentos em aberto (`pendente`/`confirmado`) nas próximas 48 horas, estritamente futuros, geram `lembrete_agendamento`. A previsão é 24 horas antes do horário ou agora, se esse limite já passou.
- Retornos com sugestão entre hoje e os próximos 7 dias de São Paulo, procedimento ativo e sem possível reserva correspondente geram `lembrete_retorno`. A previsão é às 09h do dia sugerido, ou agora quando já passou esse horário.
- Ambos exigem consentimento verdadeiro com data preenchida. Uma notificação usa exatamente uma origem, conforme as FKs e checks do banco.
- A geração também reconcilia a fila pendente/falha: cancela origem encerrada/vencida, consentimento revogado, procedimento de retorno inativo ou retorno provavelmente já agendado; atualiza a previsão quando necessário. A simulação revalida esses critérios antes de chamar o provedor. A consulta mostra o diagnóstico sem escrever no banco.
- Um único advisory lock transacional PostgreSQL serializa geração, preparação, cancelamento e alteração de consentimento. A geração consulta existência por tipo/origem sem filtrar status: não duplica em execuções concorrentes das rotas, não reabre canceladas e não cria lembrete adicional após revogação e nova autorização. Escritores externos precisam seguir o mesmo protocolo, pois ainda não existe UNIQUE no schema.
- A mensagem usa somente o primeiro nome; lembrete de agendamento inclui dia/horário, e contato de retorno convida a falar com a recepção. Não inclui procedimento, data de atendimento, diagnóstico ou histórico clínico. Telefone brasileiro de 10/11 dígitos recebe código 55; números internacionais devem ter código do país explícito. A validação é de formato, sem consulta externa para saber se o número possui WhatsApp.
- Sucesso simulado permanece `pendente` e `data_envio = NULL`; não significa envio, entrega ou aprovação de template. Falha de telefone/provedor pode gravar `falhou`, também sem data de envio. Registros `enviada` existentes são apenas consultados, nunca criados ou alterados por simulação. Falhas não expõem erro bruto do provedor.

A preparação simulada usa o contrato `ProvedorWhatsApp` e payloads de template em `src/integrations/whatsapp.ts`. Os nomes de template são rascunhos locais. Esse fluxo não lê tokens nem variáveis WhatsApp, não usa SDK e não chama a Graph API.

### Limitações e propostas sem migração

Veja [docs/fase9-limitacoes.md](fase9-limitacoes.md) para as propostas sujeitas a aprovação: histórico de consentimentos e data da revogação; tentativas/diagnósticos e idempotência de envio; índices UNIQUE de tipo/origem; vínculo explícito entre agendamento e atendimento de origem.

O schema não guarda corpo/payload nem detalhe de falha. As prévias e os diagnósticos são recalculados dos dados atuais e não representam histórico imutável. A indicação de retorno já agendado é conservadora e aproximada: uma reserva não cancelada/não marcada como ausência do mesmo paciente/procedimento, entre a data sugerida e os 30 dias seguintes. Pode gerar falso positivo ou não identificar troca de procedimento; confira a agenda. Não foi adicionada nenhuma associação artificial usando `notificacoes`.

### Validar a Fase 9 no navegador

1. Execute `bun run dev` e abra http://127.0.0.1:3000. Com conta existente, abra Pacientes e **Consentimento WhatsApp**. Confira estado, data, confirmação inicialmente desmarcada e botão de voltar.
2. Para testar qualquer escrita (consentimento, revogação, geração, simulação ou cancelamento), configure previamente `DATABASE_URL` para um banco separado de desenvolvimento com o schema existente. Esses botões gravam nesse banco, mesmo sem enviar WhatsApp. Não teste escritas no Neon da clínica e não registre autorização fictícia de paciente real.
3. No banco isolado, registre autorização explícita de um registro de teste. Como administrador, abra Notificações e clique **Gerar / atualizar fila (sem envio)**. Somente origens no horizonte e com consentimento devem aparecer. Repetir a geração não deve duplicar linhas.
4. Confira as prévias e **Simular preparação**: sucesso deve continuar Pendente e informar que nada foi enviado. Telefone incompatível deve gerar Falhou com mensagem segura. Nenhuma credencial deve ser solicitada.
5. Revogue o consentimento e atualize a fila: notificações pendentes/falhas devem estar Canceladas. Cancelar/encerrar o agendamento ou alterar o retorno exige nova geração/simulação para reconciliar a fila; a consulta já mostra o diagnóstico atual.
6. Como funcionário, confira que é possível registrar a manifestação de consentimento, mas não existe menu Notificações. Chamadas diretas às APIs de notificações retornam 403; sem sessão, 401.
7. Na Agenda, confira a indicação **Possível retorno já agendado**, preservando a sugestão e o histórico. Verifique também Tab/Enter, tela de celular, mensagens, paginação, logout e descarte de respostas atrasadas.

Os testes em `tests/notificacoes.test.ts` usam SQL/transações e provedor simulados, com disputa concorrente pelo mesmo evento. Os testes de navegação exercitam consentimento, fila administrativa, preparação sem envio e limpeza após logout. Execute `bun test`, `bun run typecheck` e `git diff --check`; a validação visual manual no navegador é separada.

## Cliente isolado — WhatsApp Cloud API da Meta

`src/integrations/whatsapp-meta.ts` implementa a camada de comunicação real. Na Etapa 2, ela é referenciada pelo seletor de provedores, mas seu transporte permanece bloqueado no fluxo da fila. O `provedorSimulado` permanece como padrão e a ação de simulação continua rejeitando provedores cujo modo seja `real`. Configurar credenciais não ativa envios, cria tarefas ou altera o banco.

O cliente é criado explicitamente por `criarProvedorMetaDoAmbiente()` ou por `criarProvedorMeta(config, http)`. A criação apenas valida/captura a configuração. Somente uma chamada explícita a `enviarTemplate({ destinatario, nome, idioma, parametros })` realiza comunicação. Não há rota HTTP de envio nesta etapa.

| Variável | Finalidade |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | Token autorizado para o número da empresa; não incluí-lo no repositório ou logs. |
| `WHATSAPP_PHONE_NUMBER_ID` | Identificador numérico do número empresarial, não o telefone do paciente nem o WABA ID. |
| `WHATSAPP_GRAPH_API_VERSION` | Versão explícita no formato `vN.N`, suportada pela Meta. Não há versão escolhida automaticamente. |
| `WHATSAPP_TIMEOUT_MS` | Prazo total, incluindo leitura do corpo: 1–120000 ms, padrão 10000 ms. |

`.env.example` contém somente exemplos comentados. Nos testes, a configuração é passada diretamente com dados fictícios e o transporte HTTP é injetado como mock; não se usam credenciais do ambiente. Não execute chamadas manuais de envio durante esta etapa.

### Contrato de comunicação

- `POST https://graph.facebook.com/{versao}/{phone-number-id}/messages` com Bearer no cabeçalho e corpo JSON de template. O host é fixo e versão/id são validados, sem URL arbitrária por ambiente. Redirecionamentos são recusados para não encaminhar autorização.
- `destinatario`: número internacional com código do país, somente dígitos; `nome` e `idioma` devem corresponder ao template aprovado; `parametros` são strings posicionais do corpo, na ordem do template. Sem parâmetros, `components` é omitido. O cliente não renomeia templates nem traduz idiomas.
- Sucesso retorna `{ messageId, status: "aceita" }`, extraindo `messages[0].id` com prefixo `wamid`. Aceitação HTTP não é confirmação de entrega ou leitura; isso depende de webhooks futuros.
- `ErroWhatsAppMeta` informa categoria, mensagem fixa segura, status HTTP e códigos numéricos Meta/subcódigo quando presentes. Não inclui token, destinatário, parâmetros, mensagem bruta da API, stack do transporte, `fbtrace_id` ou `cause` original. O módulo não escreve logs.
- HTTP 401/403 e códigos de autenticação (190/102) são classificados como autenticação/permissão. O código 130497 recebe categoria `restricao_meta` e orientação para conferir restrições da conta/país no suporte da Meta, sem presumir uma correção automática. HTTP 429 é limite; demais falhas preservam status/código sem propagar texto remoto.
- Timeout aborta a requisição e também cobre corpo de resposta que não termina. Falhas de rede, timeout, HTTP 5xx e sucesso sem ID válido indicam resultado potencialmente incerto. Não há retries automáticos, pois repetir uma mensagem já aceita pode duplicar o envio. Um chamador futuro deverá tratar reconciliação/idempotência antes de retentar.

### Limites desta etapa

Suporte somente a parâmetros posicionais de **texto no corpo** de templates. Cabeçalhos de mídia, botões, parâmetros nomeados, moeda e data/hora estruturada não foram implementados. Aprovação do template, disponibilidade da versão, autorização efetiva e restrições da conta permanecem verificações da Meta. Os templates rascunho da Fase 9 não são templates aprovados.

Não há envio real habilitado, webhooks, controle de entrega/leitura ou retry automático. A Etapa 2 prepara a seleção na fila e os arquivos de persistência/migração para `messageId`, sem executar a migração. As limitações persistentes da Fase 9 continuam descritas em `docs/fase9-limitacoes.md`. A integração ponta a ponta e qualquer envio de teste real ficam para uma etapa autorizada separadamente.

`tests/whatsapp-meta.test.ts` valida endpoint/cabeçalhos/payload, idiomas/parâmetros, ID aceito, configuração inválida, HTTP, autenticação, 130497, rede, timeout, respostas inválidas, ausência de vazamento de dados e bloqueio do cliente real pelo fluxo simulado. Todos os envios usam mocks. Execute `bun test` e `bun run typecheck`.

Referências: [coleção oficial da Meta — envio de templates](https://www.postman.com/meta/whatsapp-business-platform/request/lwtlz1k/send-message-template-interactive) e [códigos de erro oficiais](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes). As páginas diretas do portal da Meta retornaram HTTP 429 na consulta automatizada desta etapa; não foram usados envios à API para validar a implementação.

## Etapa 2 — Seleção do provedor no processamento

A fila agora tem seleção explícita por `WHATSAPP_PROVIDER=simulado|meta` (padrão `simulado`) e flag adicional `WHATSAPP_REAL_SEND_ENABLED=false`. **Mesmo com flag true, seleção Meta e credenciais, chamadas externas permanecem bloqueadas por código nesta etapa.** Credenciais sozinhas não ativam nada.

`POST /api/notificacoes/:id/processar`, com `{}`, usa o canal escolhido no servidor e compartilha as validações de consentimento, telefone, elegibilidade e bloqueio de reenvio da simulação. A ação `/simular` continua fixada no provedor simulado. Ambas são exclusivas de administrador e exigem a proteção de origem existente. A consulta e a interface exibem o provedor e o bloqueio sem expor credenciais.

O arquivo `sql/003_prepare_meta_notifications.sql` propõe estados separados de tentativa Meta e campos para `wamid`/instantes. **Não foi aplicado.** As funções em `src/services/notificacoes-meta.repository.ts` preparam reserva atômica e persistência de aceitação/falha usando mocks; ainda não são chamadas pelas rotas. Aceitação não altera status para entregue, não confirma entrega/leitura e não libera reenvio. Leituras da fila funcionam com o schema anterior via campos opcionais em JSON.

Decisões, estados, limitações, pré-requisitos de um teste real e validação no navegador estão em [docs/whatsapp-etapa2.md](whatsapp-etapa2.md). O despacho real ainda precisa integrar reserva durável, revalidação, comunicação, persistência e reconciliação antes de qualquer remoção do bloqueio. Nenhuma migração, chamada real à Meta ou operação no Neon foi executada nesta etapa.

## Etapa 3 — Persistência durável e webhooks

O processamento Meta agora confirma uma reserva atômica no banco antes de chamar o canal e persiste o resultado em outra transação. O canal real continua bloqueado por código; os caminhos de aceitação/falha são testados somente com mocks. Para usar a persistência, `WHATSAPP_PERSISTENCE_ENABLED=true` exige antes validar/aplicar as migrações **em banco local isolado**, sem usar o Neon atual.

`sql/003_prepare_meta_notifications.sql` foi revisada (ainda não aplicada) e `sql/004_create_meta_webhook_events.sql` prepara o inbox durável e os estados de entrega. `GET /api/webhooks/whatsapp` verifica o token/challenge; `POST` exige assinatura HMAC-SHA256 sobre os bytes originais, App Secret e o Phone Number ID configurado. Não exige sessão da clínica e não altera as permissões das outras APIs.

Eventos `sent`, `delivered`, `read` e `failed` são deduplicados e reconciliados por `wamid`; a correlação UUID prepara a recuperação de timeouts sem ID persistido. Eventos desconhecidos não geram respostas ou envios. Reservas expiradas viram `incerto`, nunca novo envio. `POST /api/notificacoes/reconciliar` é administrativo e exige origem; a interface mostra o estado verificado e oferece reconciliação sem reenvio quando a persistência está habilitada.

Guia completo de configurações, estados, limitações, assinatura, banco local isolado e próximos passos: [docs/whatsapp-etapa3.md](whatsapp-etapa3.md). As instruções de migração são manuais e não foram executadas nesta implementação. Aceitação HTTP não é entrega. Não há chamadas reais à Meta, migrações ou operações no Neon, retry automático ou liberação de envio real.

## Etapa 4 — Validação PostgreSQL isolada

Teste manual da Cloud API preparado separadamente, sem liberação da fila: [configuração, autorização e comando](whatsapp-teste-manual.md). A verificação `bun --no-env-file run whatsapp:test --check` é offline; o envio exige autorização e confirmação interativa.

As migrações 001–004 foram aplicadas somente em um cluster PostgreSQL 18.3 exclusivo de testes. O Neon e o `.env` não foram utilizados. A suíte opt-in cobre concorrência, constraints, persistência e quedas de conexão. O timeout foi corrigido aguardando a rejeição da operação antes de usar o matcher `rejects.toThrow()` do Bun 1.3.14, mantendo e reforçando o teste. Ambiente, reprodução e resultados: [docs/whatsapp-etapa4.md](whatsapp-etapa4.md).
