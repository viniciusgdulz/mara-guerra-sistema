# Síntese do sistema para o artigo de extensão

Texto de apoio para redação futura, sem dados de pacientes, depoimentos ou medidas sobre a rotina da clínica. Testes de software e aprovação visual não equivalem a avaliação de impacto. Antes de publicação, completar contexto institucional, participantes, datas, método e autorizações aplicáveis.

## Objetivo e público

O projeto desenvolveu um sistema de apoio à organização administrativa da Mara Guerra Estética Avançada. A proposta reúne cadastro de pacientes, catálogo de procedimentos, registro de atendimentos, retornos e agenda em uma interface simples para a equipe, com permissões distintas para administração e funcionários.

## Funcionalidades

- Login com sessões e perfis; funcionário consulta dados necessários à recepção sem acesso ao histórico clínico.
- Cadastro, listagem e pesquisa de pacientes por nome, com nome/telefone obrigatórios e e-mail/nascimento opcionais.
- Procedimentos com descrição e intervalo de retorno; administração pode editar/inativar, preservando os registros anteriores.
- Histórico cronológico de atendimentos por paciente, exclusivo da administração, com cálculo e ajuste de retorno sugerido.
- Agenda por dia, pesquisa por paciente, criação, reagendamento, cancelamento e conclusão administrativa, com prevenção transacional de duplicidade do mesmo paciente/horário.
- Consulta administrativa de retornos e criação explícita de agendamento, sem marcação automática; sinalização de possíveis retornos já agendados.
- Navegação por telas, formulários sob demanda, mensagens claras, adaptação a celular e recursos básicos de teclado/foco.
- Registro/revogação de consentimento WhatsApp e fila administrativa de preparação de lembretes discretos, sem conteúdo clínico sensível.

## Desenvolvimento e proteção de dados

Construção incremental com Bun, TypeScript, PostgreSQL e HTML/CSS/JavaScript. Regras verificadas no backend, SQL parametrizado, validação, senhas Argon2id, sessões com expiração e proteção de origem. A separação entre controllers, services e integrações permitiu substituir banco/transporte por simuladores nos testes.

A integração WhatsApp evoluiu da preparação simulada para cliente da API oficial, seleção de provedor, reservas duráveis e webhooks assinados. O envio permaneceu bloqueado na aplicação. Um comando manual foi preparado para um futuro teste restrito ao número de teste Meta e destinatário pessoal autorizado, mediante configuração e confirmação explícita.

## Evidências

Fases anteriores tiveram aprovação visual no navegador relatada pelo responsável. A suíte padrão alcançou **576 testes automatizados aprovados**, incluindo 19 do comando manual. A validação adicional utilizou PostgreSQL 18.3 real em cluster exclusivo, com dados sintéticos, para verificar migrações, constraints, concorrência, expiração, rollback, reconciliação e recuperação após falha de conexão. Resultados e distinção entre suítes: [validação](validacao.md).

Os testes demonstram comportamento técnico dos cenários exercitados. Não demonstram redução de faltas, produtividade, satisfação, adesão ou eficácia clínica: essas conclusões exigem coleta/análise próprias. Não foram utilizados pacientes reais na validação isolada nem realizadas migrações no Neon de produção.

## Limitações e continuidade

**O envio WhatsApp real ainda não foi validado.** Depende de configuração, permissões/restrições e liberação da conta da clínica, template disponível/aprovado e autorização para teste. Entrega, leitura e operação junto à Meta permanecem sem comprovação real.

Pendências adicionais: auditoria histórica do consentimento, vínculo explícito retorno/agendamento, operação de backups/segredos/monitoramento e avaliação com a equipe. Não descrever como prontuário clínico completo nem automação WhatsApp já implantada. Atendimentos registram vínculos, datas e retornos no escopo implementado.

No artigo, separar problema e levantamento com a instituição, etapas de desenvolvimento, testes técnicos, avaliação de usuários, resultados mensuráveis, limitações e melhorias. Não incluir tokens, telas com telefones reais ou informações clínicas identificáveis.
