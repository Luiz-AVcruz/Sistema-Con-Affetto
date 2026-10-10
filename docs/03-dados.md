# Dados, dinheiro e transações

## Modelo persistido

| Tabela | Responsabilidade |
| --- | --- |
| `owners` | Participantes do catálogo. |
| `products` | Cadastro atual e estoque disponível. |
| `sales` | Identificador, chave de reenvio, datas, pagamento, situação e observação. |
| `sale_items` | Quantidades, valores e dados históricos de cada item. |
| `days` | Conferência de dinheiro e snapshot do fechamento. |
| `stock_adjustments` | Contagens manuais que alteraram um estoque já cadastrado. |

Os itens guardam nome, participante e preço praticado. Eles continuam relacionados ao produto para controlar estoque, mas um relatório financeiro não consulta o preço atual para recalcular uma venda anterior.

Os produtos são desativados, não removidos. Apagar um cadastro referenciado por itens históricos eliminaria informação necessária para entender e desfazer uma operação.

`stock_adjustments` não é um registro completo de todos os eventos do sistema. As saídas e devoluções são representadas pelos pedidos e suas situações. Um histórico completo das transições e um processo auditável de retificação continuam como evolução específica.

## Centavos e limites

R$ 12,50 é armazenado como o inteiro `1250`. JavaScript usa representação binária para números, e frações decimais podem não ser exatas. O programa evita guardar dinheiro como `12.50` e faz as contas em inteiros.

Na interface, o texto `12,50` é convertido separando reais e centavos. O parser aceita vírgula ou ponto e até duas casas; rejeita negativos, separadores de milhar e mais casas. O schema HTTP exige inteiros não negativos. A conversão para texto em reais só ocorre na apresentação ou exportação.

Preço, desconto, taxa e entradas de caixa têm limite de 100.000.000 centavos por campo. Há no máximo 100 itens por pedido e 10.000 unidades por item. Esses limites mantêm os cálculos dentro de inteiros seguros do JavaScript. Não se deve aumentar os limites sem verificar o pior caso de multiplicação e soma.

Não use `Math.round(valor * 100)` como solução automática para uma entrada já arredondada incorretamente. Primeiro defina o formato da entrada e a regra de precisão.

## Invariantes financeiras

Para pedidos pagos com cobrança:

```text
soma das partes líquidas = total recebido − taxas
soma dos pagamentos = total recebido
dinheiro esperado = troco inicial + dinheiro recebido + entradas extras − retiradas
diferença = dinheiro contado − dinheiro esperado
```

Pix e cartões não são dinheiro físico na gaveta. As taxas reduzem a parte líquida das participantes; o resumo por pagamento continua mostrando o valor cobrado do cliente. Permuta e brinde não entram nos pagamentos monetários.

As consultas mantêm uma distinção entre data do pedido e data do recebimento. O fechamento é um snapshot. O total da feira é calculado a partir do estado dos pedidos, preservando cada item histórico.

## Atomicidade

Imagine um pedido com dois produtos. O primeiro tem estoque; o segundo não tem. Se o código gravar o primeiro item e falhar no segundo, deixa um pedido parcial e um estoque incorreto.

`db.transaction` envolve gravação de pedido, itens e alterações de estoque. A exceção do segundo item desfaz também o primeiro. As atualizações exigem que a quantidade disponível seja suficiente no próprio comando SQL. Essa condição precisa estar no backend, mesmo quando a interface já conferiu a quantidade.

As transações do better-sqlite3 são síncronas. Não introduza `await` dentro desse callback: a promessa e a transação não têm o mesmo ciclo de vida. Prepare operações assíncronas fora dela; mantenha a decisão e a escrita necessárias à consistência dentro da transação.

## Reenvio e falhas de rede

Uma resposta HTTP pode se perder depois de o SQLite salvar a venda. Repetir o POST com uma nova chave faria outra venda.

O carrinho mantém `requestId` até receber confirmação. O backend usa esse UUID como identificador e guarda um hash do corpo validado. Repetir a mesma chave e o mesmo conteúdo retorna o pedido existente; usar a chave com outros valores retorna conflito. A verificação do reenvio acontece antes de conferir novamente preços ou fechamento, permitindo confirmar uma gravação anterior sem repetir seus efeitos.

Idempotência não identifica duas compras diferentes por coincidirem em produtos e valor. Dois UUIDs representam dois comandos distintos.

## Persistência e backup

SQLite usa WAL e `synchronous=FULL`. O WAL pode guardar alterações confirmadas que ainda não estão incorporadas ao arquivo principal. Por isso, copiar apenas `caixa.sqlite` enquanto ele está aberto não é o mecanismo de backup do programa.

O endpoint de backup serializa o conteúdo do banco aberto. O teste grava esses bytes em um arquivo, abre esse arquivo em outro SQLite e verifica integridade, valores e fechamento. O cabeçalho de modo WAL não é aceito pela desserialização direta em memória da dependência; abrir a cópia por arquivo corresponde ao uso real do backup. Isso comprova o snapshot lógico e sua legibilidade; não equivale a garantir sobrevivência de qualquer falha de disco ou energia.

O restaurador abre uma cópia temporária em disco, verifica versão, colunas das tabelas, integridade e chaves estrangeiras e escreve somente em um destino novo. Se a origem for v1, migra apenas a cópia. Consolida o WAL antes de copiá-la para o destino. O arquivo anterior e o backup de entrada continuam disponíveis.

O destino precisa estar livre também de `-wal`, `-shm` e `-journal`. Um WAL residual de outro banco pode ser reaplicado ao abrir o arquivo restaurado, produzindo registros diferentes mesmo com `integrity_check` igual a `ok`. O programa recusa esse caminho e preserva os auxiliares. O teste reproduz a presença de um WAL real sem o arquivo principal.

## Evolução do esquema

`PRAGMA user_version` identifica o schema. A versão 0 recebe as tabelas iniciais e passa para 2. A versão 1 foi usada no primeiro protótipo; a versão 2 acrescenta a proteção de edição por `products.version`. Ao abrir v1, uma transação adiciona a coluna com valor inicial 1 se ela estiver ausente e atualiza a versão do esquema. Se a coluna já existir, seus valores são preservados. Reabrir v2 não repete a alteração.

Os testes partem de um banco v1 com vendas, estoque e fechamento. Comparam os registros das seis tabelas antes e depois, conferem integridade e reabertura. Um banco de versão mais nova é recusado antes de mudar seu modo de journal.

O programa anterior não deve escrever no banco migrado: ele não possui a proteção de edição. Para voltar à implementação anterior, encerre o programa e use uma cópia do backup anterior à migração, preservando também o banco atual. Isso retoma o estado daquele backup; lançamentos posteriores exigem conciliação. Não existe downgrade automático ou remoção de colunas.
