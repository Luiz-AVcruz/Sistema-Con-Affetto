# Importação de pedidos e fechamentos

## O problema

O catálogo inicial recebe o estoque disponível salvo no ODS. Esse saldo já desconta as vendas pagas da planilha, incluindo permutas e brindes. Recriar essas vendas pelo caminho comum de registro baixaria o estoque uma segunda vez. Também recalcularia itens com o preço e participante atuais, apagando a informação que estava salva na linha.

A migração lê os valores salvos de cada venda e insere seus snapshots, preservando pedidos já feitos no aplicativo. No modo padrão, o catálogo inteiro, incluindo estoque e versão de edição, deve corresponder ao saldo esperado. A conciliação explícita descrita abaixo permite atualizar saldos numéricos de uma planilha que recebeu vendas depois do catálogo inicial. O procedimento não modifica ou recalcula a planilha.

## Caminho dos dados

1. `scripts/extrair-planilha.py` lê os bytes do ODS uma vez, calcula seu SHA-256 e interpreta `content.xml`. Células cobertas e repetições entram na posição lógica correta. Linhas vazias não entram no JSON, mas continuam contando para a posição física da linha.
2. O extrator gera `catalogo-planilha.json`, `referencia-planilha.json` e `historico-planilha.json`, privados em `data/`. O histórico inclui data, pagamento, situação, referência de pedido, observação, preço, participante, quantidade, desconto, taxa, total e líquido salvos, além dos fechamentos.
3. `apps/api/src/import-history.ts` valida o formato, cria um backup completo por `serialize()` e abre o banco com a migração de esquema necessária.
4. `historical-import.ts` valida os vínculos e a compatibilidade do estoque, agrupa os itens, insere os pedidos e confronta os resumos. A transação só confirma depois de todos os fechamentos passarem pela conferência.
5. `CashRegister.sales()` identifica a origem pelo vínculo e devolve o contrato comum ao Angular. A interface começa na data selecionada; marque **Mostrar todos os dias** para consultar todo o histórico importado. A última escolha de período e ordenação fica salva neste dispositivo.

O extrator exige vendas e fechamentos conferidos. Produto desconhecido, preço/participante ausente, quantidade inválida ou estoque salvo divergente provocam erro, em vez de descartar silenciosamente uma venda. Fórmulas não são recalculadas pelo Python: salve o ODS no Calc antes de extrair as alterações que deseja migrar. O arquivo de bloqueio serve para informar que podem existir alterações ainda não salvas.

## Identidade e agrupamento

`source_key` identifica a origem lógica. `record_key` usa `Vendas:<linha física>` ou `Histórico:<data>`. O SHA do arquivo é guardado como evidência do snapshot, sem substituir a identidade dessas linhas. `payload_hash` representa os campos originais validados de cada registro.

Se a coluna Pedido estiver preenchida, as linhas da mesma data e referência formam um pedido misto. Pagamento e situação precisam ser compatíveis; produtos repetidos no grupo exigem revisão. Sem referência, cada linha é um pedido independente: não há evidência para inferir que duas compras próximas foram o mesmo atendimento. Observações distintas são preservadas juntas.

Renomear o arquivo ou salvá-lo sem mudar os registros não duplica pedidos. No modo padrão, alterar, inserir, remover ou deslocar linhas depois da migração é recusado. O acréscimo explícito descrito abaixo permite uma inclusão pontual após conferir as novas vendas; nenhum dos modos sincroniza edição contínua da planilha com lançamentos no programa.

## Acrescentar vendas após a migração inicial

Uma venda real lançada somente no ODS depois da migração inicial ainda precisa entrar no caixa. Nesse caso, seu estoque não foi baixado no aplicativo. O modo `--append` usa o caminho normal de venda somente para essas linhas novas, dentro de uma transação que também grava os vínculos com a origem.

```bash
CAIXA_DB=/caminho/da/copia.sqlite npm run import:history -- /caminho/do/historico-planilha.json --append
```

Primeiro extraia uma cópia salva do ODS e compare as linhas ausentes com o histórico do aplicativo, para confirmar que são vendas reais ainda não lançadas. Totais agregados iguais não provam que todos os pedidos são os mesmos: diferenças entre lançamentos podem se compensar. Ensaie o comando em uma cópia do banco, confira os resultados e só então, com o aplicativo encerrado, aplique ao banco de uso. O CLI cria um backup anterior, incluindo o WAL.

As condições para o acréscimo são deliberadamente restritas:

- A primeira feira deve continuar aberta, sem outro evento criado, e as datas das novas vendas devem estar abertas.
- Todas as vendas e todos os fechamentos anteriores precisam continuar presentes, com seus hashes originais intactos. Novas linhas só podem vir depois da última linha importada.
- Uma linha nova não pode alterar um pedido antigo nem acrescentar um fechamento. Pedidos cancelados na origem exigem conferência separada.
- Produto, participante e preço das novas linhas precisam corresponder ao cadastro atual. Não há sobrescrita do cadastro para aceitar a importação.
- Recebido, líquido, descontos, taxas, pendências, permutas, brindes, rateio, pagamentos e saldo dos produtos precisam coincidir com a fonte após a inclusão.

Vendas, itens, vínculos e baixas de estoque são confirmados juntos. Qualquer divergência desfaz tudo que o acréscimo tentou gravar, inclusive versões do catálogo. Uma contagem manual que já inclua as saídas novas pode tornar o saldo incompatível; nesse caso, o comando recusa a inclusão em vez de reduzir esse saldo novamente. `--append` não pode ser combinado com `--reconcile-stock`.

Repetir a mesma origem retorna antes de gravar ou baixar estoque, mesmo se um pedido já tiver sido recebido, cancelado ou excluído no aplicativo. Esse retorno preserva o estado atual; não certifica novamente sua igualdade com os resumos da planilha. O histórico inicial e o acréscimo guardam a origem `Planilha`, sem inventar um horário de venda que o ODS não registrou.

## Estoque e fechamento

Na primeira importação, para cada estoque conhecido, a conferência é:

```text
saldo esperado no app = saldo disponível no ODS
                      − unidades de pedidos nativos atualmente pagos
                      + diferenças das contagens manuais registradas no app
```

Pendentes e cancelados não consomem esse saldo. Permuta e brinde pagos consomem unidades. Um estoque desconhecido permanece `null`. Contagens que passam entre desconhecido e conhecido exigem conciliação específica; o comando recusa esse caso sem mudar quantidades.

Esta conferência pressupõe que o catálogo foi inicializado com o saldo desse snapshot, antes dos movimentos nativos. Ela detecta divergências numéricas; não identifica uma mesma compra digitada nas duas fontes. Revise essa sobreposição antes da troca. Alterações de nome no cadastro também impedem resolver o vínculo automaticamente; dois produtos com o mesmo nome são recusados.

Se o ODS recebeu novas vendas depois do catálogo inicial, ensaie a migração em uma cópia e use `npm run import:history -- --reconcile-stock`. O mesmo saldo esperado é usado, mas diferenças entre quantidades conhecidas podem ser aplicadas na transação de importação. Cada mudança incrementa a versão de edição e gera um ajuste com motivo `Conciliação inicial do saldo salvo na planilha`. Saldos negativos ou mudanças entre conhecido e desconhecido continuam recusados. Erro financeiro ou de fechamento desfaz a importação e a conciliação juntas. Repetir os registros já importados não aplica novos ajustes.

A conciliação automática de um saldo divergente é recusada se o produto já teve contagem manual no aplicativo. A contagem pode ter incluído saídas novas do ODS, e não há informação suficiente para descontá-las de novo com segurança. O operador precisa conferir esse caso em separado; não se deve remover os ajustes para contornar a proteção.

A importação inicial só pode ocorrer na primeira feira ainda aberta, antes de criar outro evento. A menor data importada passa a compor a data inicial da feira.

Os valores das linhas são recalculados a partir dos snapshots salvos para conferir total e líquido. Depois, recebido, líquido, desconto, taxa, pendência, unidades de permuta/brinde, partes por participante e pagamentos monetários precisam reconciliar com os resumos do ODS.

O fechamento é confrontado com todos os pedidos resultantes da data, inclusive pedidos nativos. Se estes fizerem o resumo divergir do fechamento original, a importação inteira falha. Um dia já fechado ou uma conferência de caixa já cadastrada no aplicativo é preservado; o comando recusa substituí-lo. A contagem física mantém a distinção entre ausência (`null`) e zero.

## Datas e horários

Pedidos novos guardam `created_at` em UTC. O Angular mostra data e hora com segundos no fuso de São Paulo, separadas da data de negócio. Reenviar um pedido não muda o instante original.

A planilha atual guarda apenas a data da venda. O banco registra quando ela foi importada para auditoria, mas o histórico informa “Horário não registrado na planilha”. O CSV deixa o instante original vazio para a origem `Planilha`. `closed_at` de um fechamento importado também indica quando ele entrou no banco; não representa uma hora antiga que o ODS não tinha.

## Conferência, repetição e recuperação

Execute primeiro os testes com os JSONs extraídos. Para uma conferência adicional, use o restaurador para criar outro arquivo a partir de um backup, aponte `CAIXA_DB` para essa cópia e execute a importação nela. Compare pedidos, catálogo, total por participante/pagamento e fechamentos antes de aplicar no banco de uso.

Com o aplicativo encerrado, `npm run import:history` salva o estado anterior em `data/backups/`, inclusive transações que ainda estavam no WAL. Se a importação falhar, os registros dela são desfeitos. A atualização aditiva do esquema pode já ter sido concluída; isso não significa que vendas parciais ficaram gravadas.

Repetir uma origem idêntica retorna sem gravar pedidos, mexer em estoque ou atualizar fechamentos. O CLI ainda cria um backup antes da conferência. Se uma pendência importada foi recebida depois, ou um pedido foi cancelado no app, esses estados atuais são preservados: a comparação usa o hash da linha original, não o pedido atualizado.

Essa repetição compara os registros originais de vendas e fechamentos. Ela não certifica novamente o saldo ou o resumo global atual do ODS; estes já podem ter se separado do aplicativo depois da migração. A mensagem de histórico já importado confirma a repetição segura desses registros.

Para voltar ao estado anterior, preserve o banco atual e restaure o backup em outro caminho. Esse retorno recupera o estado daquele instante; movimentos posteriores precisam ser conciliados. Não há downgrade automático.

## Evidência e exercício

Os testes usam SQLite real e desafiam a preservação do catálogo completo e do pedido nativo, o agrupamento misto, preço/participante distintos do cadastro atual, repetição após recebimento/cancelamento, recusa de origem alterada, rollback após linhas válidas, conflito com um fechamento e recuperação de um backup v2. O acréscimo possui provas de baixa única, rollback de todas as tabelas, repetição após exclusão, estoque desconhecido, contagem manual, cadastro divergente e backup completo do CLI. Um teste privado importa o snapshot real somente em um banco de teste. O navegador confere histórico anterior, horário persistente, filtro de dias e cancelamento bloqueado após fechamento.

`python3 -m unittest discover -s scripts -p 'test_*.py'` verifica separadamente que linhas vazias/repetidas e células cobertas preservam as posições físicas e lógicas no leitor ODS. A extração e esses testes exigem Python 3; as dependências são apenas da biblioteca padrão.

Para estudar, explique por que `createSale()` não é o caminho adequado para os pedidos da migração inicial, mas pode registrar as vendas acrescentadas depois dela. Depois tente, em um banco descartável, alterar o pagamento de uma linha após a primeira importação e observe a recusa. Reconstrua a razão de guardar o hash original separado do estado atual antes de modificar o importador. Esse contrato também deve ser preservado se a leitura do banco e a API forem reconstruídas em Rust.
