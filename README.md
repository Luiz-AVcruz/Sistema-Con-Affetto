# Caixa da feira

Aplicativo local em **Angular + TypeScript**, **Node + Express** e **SQLite**. A primeira versão atende um operador no notebook e funciona sem internet depois da instalação das dependências. O Node serve a interface compilada e a API no mesmo endereço: `http://127.0.0.1:3333`.

O projeto também é uma referência de estudo. O desafio futuro é reconstruir o backend em Rust, preservando o comportamento verificável e reaproveitando a interface Angular.

## Estado da primeira versão

Esta versão é um protótipo para validação. Ela registra pedidos mistos, pagamentos, pendências, permutas, brindes, cancelamentos, estoque conhecido ou `A contar`, descontos/taxas por item, fechamento diário, total da feira, exportação CSV e backup SQLite.

O catálogo pode ser extraído da última versão **salva** da planilha. As vendas e os fechamentos antigos **não são importados para o banco de uso**. A referência extraída serve para testar os cálculos em um banco temporário. Os registros feitos no programa e na planilha são independentes.

Antes de usar o aplicativo como caixa principal: conferir o catálogo e a contagem atual; validar os cenários de atendimento; decidir a migração do histórico; ensaiar backup/restauração; implementar um procedimento de retificação de dias fechados se esse recurso for necessário. A primeira versão bloqueia alterações financeiras em dias fechados.

## Executar

Requisitos: Node 24 LTS, npm e um navegador atual. As versões exatas das dependências estão no `package-lock.json`. Não é necessário instalar um servidor de banco de dados.

```bash
cd ~/Projetos/caixa-da-feira
npm ci
npm run build
npm start
```

Abra `http://127.0.0.1:3333`. `Ctrl+C` no terminal encerra o programa. Compilar novamente é necessário após mudar o código; iniciar uma compilação já pronta funciona offline.

Para desenvolvimento, com atualização durante as edições:

```bash
npm run dev
```

Nesse modo, a interface fica em `http://127.0.0.1:4200`. O Angular encaminha `/api` para o Node na porta 3333.

## Catálogo da planilha

Execute a extração a partir da raiz do projeto. Ela lê o arquivo, confere as saídas de estoque e gera JSONs privados em `data/`, sem modificar o ODS.

```bash
python3 scripts/extrair-planilha.py '/caminho/Caixa da Feira.ods' --output data
npm test
npm run seed
```

`npm run seed` aceita apenas um cadastro vazio. Se já houver produtos, ele recusa a operação e preserva os registros existentes. Salve a planilha no Calc antes de extrair se quiser incluir as alterações feitas nela. O extrator informa quando encontra um arquivo de bloqueio.

Para começar sem a planilha, cadastre participantes e produtos pela interface. Deixe o estoque vazio quando a quantidade ainda não tiver sido contada.

## Verificar

```bash
npm run check
npm run test:e2e
```

`check` executa testes de regras e de HTTP com SQLite real, além da compilação de Angular e Node. Quando `data/referencia-planilha.json` existe, também compara os cálculos com os valores salvos da planilha. Os testes usam bancos isolados; não lançam vendas no banco do caixa.

`test:e2e` abre um navegador automatizado e percorre o atendimento em um banco temporário. Neste notebook usa o Brave existente. Em outro ambiente, configure `BROWSER_PATH` ou instale o Chromium do Playwright com `npx playwright install chromium`.

## Dados e recuperação

O banco de uso é `data/caixa.sqlite`. O SQLite pode criar arquivos `-wal` e `-shm` enquanto o programa está aberto. Esses arquivos fazem parte do funcionamento do banco. Não copie apenas o arquivo principal como backup de um programa em execução.

Na aba **Histórico**, use **Baixar backup**. O arquivo baixado contém um snapshot completo do SQLite. O CSV é uma exportação para consulta, não substitui o backup. Ele inclui as colunas `Recebido` e `Líquido recebido`, que zeram pedidos pendentes ou cancelados.

Para restaurar primeiro em uma cópia, com o programa encerrado:

```bash
node scripts/restaurar-backup.mjs '/caminho/backup.sqlite' data/caixa-restaurado.sqlite
CAIXA_DB="$PWD/data/caixa-restaurado.sqlite" npm start
```

O restaurador verifica a integridade e o formato do banco e recusa um destino que já tenha o arquivo principal ou auxiliares `-wal`, `-shm` e `-journal`. Confira os dados nessa cópia antes de escolhê-la para uso. A restauração não apaga o banco anterior.

`data/`, bancos, backups e referências reais estão ignorados pelo Git. Não publique dados do comércio junto com o código.

## Documentação de estudo

Comece por [docs/README.md](docs/README.md). A sequência cobre domínio, arquitetura, dados, API, leitura do código e o desafio em Rust. Ela distingue o comportamento já implementado das etapas que ainda precisam ser validadas para a substituição da planilha.

O projeto usa um repositório Git local, sem remote. O ciclo de commits está em [docs/08-git.md](docs/08-git.md); as instruções para alterações futuras estão em [AGENTS.md](AGENTS.md).
