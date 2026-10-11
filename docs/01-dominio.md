# Escopo e regras do caixa

## Problema

A planilha distribui dados entre Vendas, Produtos, Fechamento do dia, Total da feira e Histórico. Um atendimento pode reunir produtos de participantes diferentes e usar um ou dois pagamentos. O aplicativo representa esse pedido como uma unidade, preservando a parte de cada participante. A divisão em dois pagamentos está descrita em [Pagamentos](14-pagamentos.md).

Exemplo: um produto de R$ 15,00 da participante A e outro de R$ 40,00 da participante B formam um pedido de R$ 55,00. Há um recebimento, dois itens e duas partes. Somar R$ 55,00 para cada participante duplicaria a receita.

## Vocabulário

| Termo | Significado |
| --- | --- |
| Participante | Pessoa ou marca a quem pertence a parte de um item vendido. |
| Produto | Cadastro atual: nome, descrição, participante, preço e estoque. |
| Pedido | Conjunto de itens de um atendimento, com situação e pagamento. |
| Item | Produto, quantidade, preço praticado, desconto, taxa e participante guardados no pedido. |
| Recebido | Valor cobrado em pedidos pagos; exclui permutas e brindes. |
| Líquido | Recebido menos taxas. É o valor distribuído entre participantes. |
| Estoque disponível | Quantidade atualmente disponível, quando conhecida. |
| A contar | Quantidade desconhecida, armazenada como `null`. Não significa zero. |
| Fechamento | Registro imutável dos números de um dia, com contagem opcional. |

## Situação e estoque

| Operação | Recebimento | Estoque |
| --- | --- | --- |
| Registrar pago | Soma os itens após descontos. | Baixa as quantidades. |
| Registrar pendente | Soma apenas em valores a receber. | Mantém a quantidade. |
| Receber pendência | Soma na data escolhida para o recebimento. | Baixa nesse momento. |
| Registrar permuta | Zero. Conta unidades de permuta. | Baixa as quantidades. |
| Registrar não cobrado | Zero. Conta unidades de brinde. | Baixa as quantidades. |
| Cancelar pago | Retira a receita dos resumos atuais. | Devolve uma vez a quantidade. |
| Cancelar pendente | Retira dos valores a receber. | Mantém a quantidade. |

Cancelar um pedido pago pressupõe que os produtos retornaram ou que a saída foi lançada por engano. Devolução parcial, estorno parcial e produto devolvido sem condição de revenda não estão modelados nesta versão.

O programa recusa estoque negativo quando a quantidade é conhecida. Estoque desconhecido permite registrar a saída e permanece `A contar`. Não há reserva de estoque para pendências, reproduzindo a regra da planilha: um pagamento pendente poderá falhar se não houver quantidade disponível no momento de recebê-lo.

## Descontos e taxas

Os ajustes pertencem ao item. Para cada item:

```text
bruto = quantidade × preço unitário
cobrado = bruto − desconto
líquido = cobrado − taxa
```

O desconto não pode superar o bruto; a taxa não pode superar o cobrado. Em um pedido misto, cada participante recebe a soma dos líquidos dos seus itens. Esta versão não reparte automaticamente um desconto global: isso exigiria uma regra de rateio que ainda não foi definida.

Permutas e brindes mantêm o preço de catálogo no histórico, mas têm cobrança e líquido zero. Não aceitam ajustes financeiros nem situação pendente.

## Cancelar ou excluir um pedido

Cancelar uma venda desfeita mantém o pedido no histórico com situação `Cancelado`, remove sua receita e devolve o estoque se havia baixa. Excluir serve para um lançamento acidental que não precisa constar nos relatórios: o pedido desaparece do histórico, dos CSVs e dos resumos. A confirmação ocorre na própria interface, com valor e itens do pedido.

Uma exclusão de pedido pago devolve o estoque uma única vez. Pedidos pendentes não baixaram estoque; pedidos já cancelados já foram tratados. Excluí-los não altera novamente as quantidades. Estoque `A contar` permanece desconhecido.

O dia do pedido e, quando houver, o dia do recebimento precisam estar abertos. Uma feira encerrada também impede excluir. O programa conserva um marcador interno e os dados do comando para que repetir o envio original ou a importação da planilha não recrie um pedido excluído. Esses registros fazem parte do backup SQLite, embora não sejam apresentados no histórico ou nos CSVs.

## Datas e fechamentos

O pedido guarda a data de origem. O recebimento guarda outra data quando uma pendência é quitada posteriormente. Uma pendência registrada no dia 10 e paga no dia 11 entra no dinheiro do dia 11. O fechamento já guardado do dia 10 conserva os números conhecidos quando foi fechado, incluindo as pendências existentes naquele momento.

O total da feira é calculado sobre os pedidos atuais, sem somar novamente os snapshots de fechamento. Assim, fechar um dia não duplica as vendas.

Um dia fechado bloqueia novos recebimentos para essa data, alterações na contagem e cancelamento de pagamentos daquele dia. Pendências podem ser recebidas em outro dia aberto. A primeira versão não oferece reabertura ou retificação de fechamento.

Contagem vazia significa `Fechado sem contagem`. Contagem `0,00` significa que houve contagem e nenhum dinheiro foi encontrado. A diferença, inclusive quando não é zero, fica guardada.

## Limite da substituição

A primeira versão permite testar atendimento e fechamento. A troca definitiva depende de conferir o catálogo e a contagem atual, validar os casos reais, decidir como trazer o histórico e ensaiar recuperação do banco. Enquanto isso, a planilha permanece como referência independente.
