# Sistema Mara Guerra Estética Avançada

Sistema de gestão desenvolvido como projeto de extensão universitária. Reúne pacientes, procedimentos, histórico de atendimentos, agenda, retornos sugeridos e preparação de notificações. Usa Bun 1.3.14, TypeScript, PostgreSQL e HTML/CSS/JavaScript em um monólito servido pela mesma aplicação HTTP.

**WhatsApp:** cliente Cloud API, persistência e webhooks implementados e testados com mocks e PostgreSQL isolado. **O envio real ainda não foi validado e depende da configuração, permissões/liberação da conta da clínica e autorização explícita.** A fila e a interface continuam bloqueadas por código para envios externos; credenciais ou flags não removem esse bloqueio. Nenhuma migração desta integração foi aplicada no Neon de produção.

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [Documentação técnica atual](docs/documentacao-tecnica.md) | Arquitetura, funcionalidades, permissões, APIs, estados e pendências |
| [Validação e resultados](docs/validacao.md) | 576 testes padrão, PostgreSQL real isolado, comandos e limites da evidência |
| [Resumo para o artigo de extensão](docs/resumo-extensao.md) | Objetivo, funcionalidades, desenvolvimento, resultados observados e trabalho futuro |
| [Teste manual WhatsApp](docs/whatsapp-teste-manual.md) | Configuração privada, conferências na Meta e autorização de envio |
| [Etapa 4: PostgreSQL isolado](docs/whatsapp-etapa4.md) | Cluster exclusivo, migrações 001–004, concorrência e timeout corrigido |
| [Histórico das fases](docs/implementacao-fases.md) | Registro detalhado anterior; não substitui o estado consolidado |

Os documentos de [limitações da Fase 9](docs/fase9-limitacoes.md), [Etapa 2](docs/whatsapp-etapa2.md) e [Etapa 3](docs/whatsapp-etapa3.md) preservam decisões históricas e indicam sua relação com o estado atual.

## Execução local

Requisito: Bun **1.3.14**, definido em `.bun-version` e `package.json`.

```powershell
bun install
Copy-Item .env.example .env
# Edite o .env local: use um banco de desenvolvimento autorizado e isolado.
bun run dev
```

Não sobrescreva um `.env` existente. Abra http://127.0.0.1:3000; `HOST` e `PORT` ajustam o endereço. `bun start` executa sem observação de arquivos. Login e operações de negócio exigem `DATABASE_URL` e usuário existente. O servidor não aplica migrações nem cria usuários ao iniciar. `bun run admin:create` grava no banco configurado: execute somente com autorização específica.

Não faça testes de escrita, migrações ou inserções fictícias no Neon da clínica. Exemplos versionados não contêm credenciais reais. Mantenha `.env` e os diretórios locais de teste privados.

## Verificar sem acessar produção ou enviar mensagens

```powershell
bun --no-env-file test
bun --no-env-file run typecheck
git diff --check
```

A suíte padrão tem **576 testes aprovados**; a suíte PostgreSQL é opt-in e fica ignorada sem sua flag. `--no-env-file` evita carregar o `.env` da aplicação. Não use `bun run db:test` para essa validação: ele consulta o banco configurado no `.env`.

Para os 14 testes adicionais PostgreSQL, use exclusivamente o [cluster isolado](docs/whatsapp-etapa4.md), nunca a conexão de produção. O código valida endereço e diretório do servidor antes de criar um banco sintético.

## Antes de um teste real WhatsApp

O arquivo privado `.local/whatsapp-manual/config.json` foi preparado a partir de um exemplo; seu preenchimento não foi inspecionado nesta revisão. Não compartilhe tokens em mensagens ou logs. `bun --no-env-file run whatsapp:test --check` valida somente a configuração local, sem comprovar validade do token, permissões ou liberação da conta Meta. Nenhum envio manual foi executado; siga o [guia específico](docs/whatsapp-teste-manual.md) e obtenha autorização antes da opção de envio.
