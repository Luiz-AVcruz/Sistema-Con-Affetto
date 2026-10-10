# Instruções do projeto

- Responder em português do Brasil, de forma direta, com resultados e limites sustentados por evidência.
- Este é um aplicativo local, de operador único. Preservar Angular, Node/TypeScript e SQLite até uma mudança explícita de escopo.
- Manter documentação de estudo: explicar regra, responsabilidade, decisão e teste. Atualizar o documento correspondente quando mudar comportamento ou contrato.
- O backend em Rust é um desafio futuro da pessoa desenvolvedora. Não implementar essa versão inteira automaticamente; seguir o escopo explicitamente pedido em cada exercício.
- Não modificar a planilha do comércio nem inserir vendas de teste no banco de uso. Testes e exercícios devem usar bancos temporários ou um `CAIXA_DB` separado.
- Preservar centavos inteiros, transações completas, idempotência, dados históricos dos itens e snapshots dos dias fechados.
- Alterações de esquema exigem migração explícita, prova de preservação e caminho de recuperação. Não remover proteção existente sem entender o que ela impede.
- Versionar cada conjunto coerente de mudanças após a validação adequada. Conferir `git diff --cached` e o resultado de `git status`; não incluir mudanças alheias.
- Manter bancos, backups, referências da planilha, dependências e artefatos de compilação fora dos commits. `.gitignore` não remove arquivos já rastreados.
- Usar somente o Git local. Não criar remotes, enviar ao GitHub ou publicar sem instrução explícita.
- Ao concluir, informar o comportamento implementado, verificações executadas, limitações relevantes e commit criado.

Comandos e método de versionamento: [docs/08-git.md](docs/08-git.md). Documentação do sistema: [docs/README.md](docs/README.md).
