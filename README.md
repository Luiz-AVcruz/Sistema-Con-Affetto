# Caixa da feira

Aplicativo local em **Tauri**, **Angular + TypeScript**, **Node + Express** e **SQLite**. Atende um operador no notebook e funciona sem internet depois da instalação. A prioridade é facilitar o caixa do comércio, preservar o histórico e permitir exportação e recuperação.

O Tauri abre uma janela própria e gerencia o backend local. A interface web permanece disponível para desenvolvimento e validação. A documentação de estudo anterior é secundária; reconstruir regras em outra linguagem não é requisito para usar o caixa.

## Estado da primeira versão

Registra pedidos mistos, pagamentos, pendências, permutas, brindes, cancelamentos, exclusão de lançamentos acidentais, estoque conhecido ou `A contar`, descontos/taxas por item, fechamento diário, meta e encerramento de feiras, histórico de eventos, exportação CSV e backup SQLite.

No **Histórico**, **Cancelar pedido** mantém o registro como cancelado. **Excluir pedido** pede confirmação e retira um lançamento acidental do histórico, dos totais e dos CSVs. Se estava pago, devolve as quantidades ao estoque; pendentes ou já cancelados não provocam nova devolução. Não é permitido excluir pedidos de feira encerrada nem com dia do pedido ou recebimento fechado. O backup completo mantém os registros internos de exclusão para impedir reenvios ou reimportações que recriem o lançamento.

O catálogo, os pedidos e os fechamentos podem ser extraídos da última versão **salva** da planilha. A migração inicial preserva pedidos já feitos no aplicativo e não baixa novamente o estoque das vendas antigas. O histórico abre com todos os dias visíveis. Pedidos do aplicativo mostram data e hora de registro; pedidos da planilha indicam que o horário não foi registrado na origem.

Antes de usar o aplicativo como caixa principal: conferir o catálogo, o histórico e a contagem atual; validar os cenários de atendimento; ensaiar backup/restauração; implementar um procedimento de retificação de dias fechados se esse recurso for necessário. A primeira versão bloqueia alterações financeiras em dias fechados.

## Executar

Para o aplicativo desktop, consulte [instalação e operação local](docs/11-desktop.md).
Para instalar o pacote pronto no EndeavourOS ou Zorin, sem compilar em cada
máquina, consulte [Flatpak privado](docs/12-flatpak.md). O banco é restaurado
separadamente e não é incluído no pacote. O fluxo abaixo executa a interface
web de desenvolvimento/validação.

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

## Histórico da planilha

Depois de extrair a planilha e inicializar o catálogo, feche a janela do aplicativo (ou use `Ctrl+C` no modo web) e execute:

```bash
npm run import:history
npm run build
npm start
```

O comando cria um backup completo em `data/backups/` antes de atualizar o esquema ou importar. Ele confere os totais por participante e pagamento, os fechamentos e a compatibilidade do estoque. Se houver divergência, os registros da importação são desfeitos juntos. Não execute `seed` novamente se o catálogo já existe.

Se o saldo salvo mudou porque a planilha recebeu novas vendas depois do catálogo inicial, ensaie em uma cópia e use a conciliação explícita:

```bash
npm run import:history -- --reconcile-stock
```

Ela registra os ajustes necessários no saldo atual, considerando os movimentos nativos do aplicativo, sem baixar novamente todo o histórico. Saldos desconhecidos não são convertidos automaticamente. Faça a migração antes de encerrar a primeira feira. Consulte [metas, feiras e exportações](docs/10-feiras.md).

A repetição da mesma origem não duplica pedidos nem desfaz recebimentos, cancelamentos ou exclusões feitos no programa. O modo padrão recusa linhas novas, removidas ou alteradas no ODS depois da migração. Para uma inclusão pontual de vendas reais acrescentadas ao final da planilha, existe `npm run import:history -- caminho/do/historico-planilha.json --append`: confira as linhas ausentes, ensaie em uma cópia e encerre o aplicativo antes de aplicar. Esse modo preserva os registros antigos, baixa apenas as novas vendas e exige que totais e estoque final coincidam com a origem. Não sincroniza dois caixas em uso paralelo. O detalhe e o roteiro de conferência estão em [docs/09-importacao-historico.md](docs/09-importacao-historico.md).

## Verificar

```bash
npm run check
npm run test:e2e
```

`check` executa testes de regras, importação, restauração e HTTP com SQLite real, além da compilação de Angular e Node. Quando os JSONs privados extraídos existem, também compara os cálculos e a importação com os valores salvos da planilha. Os testes usam bancos isolados; não lançam vendas no banco do caixa.

`test:e2e` abre um navegador automatizado e percorre o atendimento em um banco temporário. Neste notebook usa o Brave existente. Em outro ambiente, configure `BROWSER_PATH` ou instale o Chromium do Playwright com `npx playwright install chromium`.

## Dados e recuperação

O banco de uso é `data/caixa.sqlite`. O SQLite pode criar arquivos `-wal` e `-shm` enquanto o programa está aberto. Esses arquivos fazem parte do funcionamento do banco. Não copie apenas o arquivo principal como backup de um programa em execução.

Na aba **Histórico**, use **Baixar backup**. O arquivo baixado contém um snapshot completo do SQLite. O CSV é uma exportação para consulta, não substitui o backup. Ele inclui as colunas `Recebido` e `Líquido recebido`, que zeram pedidos pendentes ou cancelados, e `Origem` e `Registrado em (UTC)`. O instante fica vazio nas linhas da planilha, pois o horário original é desconhecido.

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
