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

O cadastro de pacientes está descrito na Fase 5 abaixo. Não há integração com WhatsApp.

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

`tests/navigation-ui.test.ts` carrega o HTML e os quatro scripts com DOM e API simulados para testar a integração sem banco ou rede. Execute `bun test`, `bun run typecheck` e `git diff --check`; a validação visual manual é separada.

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

As sugestões de retorno não geram agendamentos automaticamente. O administrador consulta um período, clica em **Agendar retorno**, escolhe horário e confirma o envio. É permitido ajustar a data sugerida para o horário disponível. Procedimentos inativos permanecem visíveis nas sugestões, com indicação da indisponibilidade. Como o schema não vincula agendamento à sugestão, ela permanece na consulta após agendar; consulte a agenda antes de repetir. Nenhuma sugestão é marcada como atendida automaticamente.

### Validar a Fase 8 no navegador

1. Execute `bun run dev`, abra http://127.0.0.1:3000 e entre com uma conta existente. Abra **Agenda**; confira o dia atual, os botões entre datas e a pesquisa por paciente.
2. Como funcionário, confira que não há seção Retornos nem ação Concluir. Como administrador, confira ambas. As restrições também são verificadas nas APIs, não apenas na tela.
3. Clique **Novo agendamento**, pesquise paciente e procedimento ativo usando os seletores paginados e escolha data e horário. **Cancelar e voltar à agenda** fecha o formulário sem gravar.
4. Testes de escrita devem usar exclusivamente um banco separado de desenvolvimento com o schema existente, configurado em `DATABASE_URL` antes de iniciar o servidor. Não insira dados fictícios no Neon da clínica.
5. Nesse banco separado, salve um agendamento e confira a confirmação e a agenda do dia escolhido. Tente repetir paciente/data/horário e confira a mensagem de duplicidade. Reagende; cancele com confirmação; como administrador, conclua um agendamento em aberto. Registros encerrados devem continuar visíveis sem ações de alteração.
6. Como administrador, consulte Retornos por período. **Agendar retorno** somente abre o formulário; escolha horário e salve explicitamente. Confira paciente/procedimento corretos. Uma sugestão com procedimento inativo deve permanecer visível, sem botão para agendar esse procedimento.
7. Teste teclado (Tab/Enter), visualização no celular, mensagens, paginação e logout. Confirme que a sessão expirada limpa a tela e que funcionários recebem 403 nas rotas de retornos e ao tentar concluir.

Arquivos principais: `src/services/agenda.service.ts`, `src/controllers/agenda.controller.ts` e `public/js/agenda.js`. `tests/agenda.test.ts` usa SQL e transações simulados, incluindo disputa concorrente pelo mesmo horário. `tests/navigation-ui.test.ts` cobre a integração da Agenda, envio explícito de retorno, cancelamento de edição, mensagens e descarte de respostas após mudança de perfil. Execute `bun test`, `bun run typecheck` e `git diff --check`, sem conexão com o Neon. A validação visual manual no navegador é separada.
