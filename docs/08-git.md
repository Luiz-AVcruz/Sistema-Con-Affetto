# Versionamento local

## O que o Git registra

O repositório fica na raiz deste projeto. O Git registra versões do código, testes, documentação, configuração de compilação e lockfile das dependências. Cada commit deve representar uma mudança coerente e explicar sua finalidade.

O banco do comércio e a planilha continuam fora do histórico. `data/`, `*.sqlite*`, `node_modules/`, `dist/`, resultados de testes e `.env` estão ignorados. Um commit não é um backup das vendas.

O repositório inicial é local, sem remote. Nenhum passo de desenvolvimento exige enviar o código a um serviço. O primeiro commit automatizado usa a identidade `Codex <codex@localhost>` caso não haja uma identidade Git configurada. Isso registra a autoria da implementação de referência sem atribuir a você uma identidade inventada.

## Ciclo de uma alteração

Antes de editar:

```bash
git status --short
git log --oneline -5
```

Defina o comportamento esperado, altere os arquivos responsáveis e execute a verificação necessária. Para uma mudança financeira ou de persistência, use os testes de regras/HTTP e um banco descartável. Para uma alteração na interação, percorra também o fluxo relevante no navegador.

Antes de criar o commit:

```bash
git diff
git add caminho/do/arquivo-alterado
git diff --cached
git status --short
git commit -m "feat: filtra produtos por participante"
```

O `git add` seleciona a versão que entrará no commit. Se editar o arquivo depois, a alteração posterior permanece fora dessa seleção até um novo `git add`. Por isso, ler o diff do índice importa: ele mostra o conteúdo efetivo do próximo commit.

Depois do commit, confira `git status --short`. Arquivos de trabalho pendentes precisam ter uma explicação; não devem desaparecer da conclusão da tarefa. Evite juntar uma mudança de cálculo com várias alterações sem relação em uma mesma revisão.

Mensagens possíveis: `feat: registra recebimento de pendência`, `fix: impede edição com estoque desatualizado`, `docs: explica o fechamento diário`, `test: verifica recuperação de backup`. O prefixo ajuda a localizar a finalidade; a descrição precisa dizer o que mudou.

## Identidade das suas alterações

Para configurar a autoria apenas neste repositório, execute com seus dados:

```bash
git config user.name 'Seu nome'
git config user.email 'seu-email'
```

Esses comandos não alteram a configuração dos outros projetos. A identidade fica no histórico local mesmo que nenhum arquivo seja enviado a um serviço.

## Verificar a exclusão de dados

```bash
git check-ignore data/caixa.sqlite data/catalogo-planilha.json
git ls-files data
```

O segundo comando deve listar somente `data/.gitkeep`. Acrescentar uma regra ao `.gitignore` não retira um arquivo já incluído em commits anteriores. Se ocorrer inclusão indevida, interrompa a publicação e trate o histórico; não considere que apagar apenas o arquivo atual resolveu.

## Estudo e desafio Rust

Guarde uma mudança pequena por commit, com o teste que demonstra seu efeito e a documentação correspondente. Ao iniciar a versão Rust, preserve a referência Node e use um banco separado. Uma branch pode isolar o experimento, mas não torna o banco real seguro para exercícios: a proteção vem do caminho de dados separado e da conferência do comando executado.
