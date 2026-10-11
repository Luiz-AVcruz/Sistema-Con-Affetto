# Pagamentos, repasses e retificação de taxas

Configuração confirmada pela operadora em 11/10/2026 para esta feira:

| Forma | Taxa |
| --- | ---: |
| Dinheiro | 0% |
| Pix | 0% |
| Cartão débito — aproximação no celular | 0,89% |
| Cartão crédito à vista — aproximação no celular | 3,09% |
| Cartão débito — inserido na maquininha | 1,99% |
| Cartão crédito à vista — inserido na maquininha | 4,98% |

As opções usuais de cartão usam aproximação. Para a maquininha, escolha a opção
**inserido**. As mesmas opções aparecem no recebimento de pendências. Se uma
pendência for paga por outra forma, o servidor recalcula a taxa com o pagamento
real e os valores históricos dos itens, sem usar preços atuais do catálogo.
Esta configuração não cobre parcelamento nem outros prazos de recebimento.

As referências públicas são [Point Tap](https://www.mercadopago.com.br/ferramentas-para-vender/point-tap)
e [Maquininhas Point](https://www.mercadopago.com.br/ferramentas-para-vender/maquininhas-point).
As taxas da Point variam por faturamento e promoção; os valores acima foram
confirmados para a conta usada nesta feira. Dinheiro/Pix com zero foram informados
pela operadora. Uma mudança futura de configuração deve preservar as taxas
efetivamente registradas em cada pedido.

## Cálculo

O bruto recebido é o preço vezes quantidade, menos descontos, antes da taxa.
O líquido é esse bruto menos a taxa. Cada participante arca com sua parte da
taxa; o valor da meta soma apenas o líquido da Con Affetto.

A taxa é arredondada uma vez no total da transação, para o centavo mais próximo
(meio centavo arredonda para cima). A distribuição começa pela parte inteira da
taxa de cada item; os centavos restantes vão para os maiores restos, com desempate
pela ordem dos itens. A soma dos itens confere com a taxa do pedido. O cálculo usa
inteiros e BigInt para evitar erros de ponto flutuante. Exemplo: R$ 20 + R$ 40 no
crédito por aproximação geram R$ 1,85 de taxa: R$ 0,62 e R$ 1,23, respectivamente.

O frontend mostra a previsão, e o backend calcula novamente ao gravar. O total
cobrado e o dinheiro físico continuam brutos. Permutas e brindes têm taxa zero.
Cancelamento e exclusão retiram o pedido dos valores recebidos e dos repasses,
mantendo as proteções dos dias e feiras fechados.

Rascunhos antigos conservam taxas manuais e o corpo de reenvio. Um pedido que
aguarda confirmação é reenviado com seu corpo original. Para um rascunho antigo
ainda editável, **Aplicar taxas atuais do Mercado Pago** ou escolher uma forma de
pagamento troca para o cálculo automático. Pedidos novos e carrinhos vazios usam
as taxas automáticas, inclusive ao remover todos os itens do rascunho anterior.

## Pedido com duas formas de pagamento

No carrinho, marque **Dividir em duas formas de pagamento**, selecione ambas as
formas e informe o valor do primeiro pagamento. O restante do segundo é calculado
automaticamente, já considerando os descontos. As duas partes precisam ser
positivas, somar exatamente o total e ter formas/leituras diferentes. Cada cartão
tem sua própria opção de aproximação ou inserido. A divisão atende somente pedidos
completamente pagos, com taxas automáticas; pendências, permutas e brindes
continuam no fluxo de pagamento único.

A taxa é calculada e arredondada uma vez por transação de cartão. A soma dessas
taxas é rateada proporcionalmente pelo valor dos produtos de cada participante,
após descontos. Primeiro distribui-se entre participantes; depois, entre seus
itens. Em cada distribuição, os centavos indivisíveis vão aos maiores restos,
com empate resolvido pela primeira ocorrência no pedido. Ter mais produtos no
carrinho não aumenta a quota da taxa de um participante. Nenhum produto é atribuído
implicitamente ao dinheiro ou ao cartão.

Exemplo fictício: produto da participante A de R$ 50 e dois produtos da Con Affetto
de R$ 20 e R$ 12, pagos com R$ 50 em dinheiro e R$ 32 em crédito por aproximação.
A taxa da transação é R$ 0,99. A participante A arca com R$ 0,60 (líquido R$ 49,40);
a Con Affetto, com R$ 0,39 (líquido R$ 31,61), distribuídos em R$ 0,24 e R$ 0,15
nos seus itens. O pedido recebe R$ 82 brutos e R$ 81,01 líquidos. O resumo registra
R$ 50 em dinheiro, R$ 32 em cartão e um pedido; o estoque é baixado uma única vez.

O histórico mostra cada parte, seu valor e taxa. Rascunhos guardam a seleção e
os valores. Depois de uma resposta perdida, o reenvio mantém exatamente o pedido
e suas duas partes. Cancelar ou excluir estorna o estoque uma vez e retira ambas
dos totais. Pedidos já lançados separadamente antes desta função permanecem como
foram registrados; não há união ou redistribuição retroativa automática.

## Correção dos cartões anteriores

O procedimento foi autorizado para esta feira: os cartões anteriores foram
pagos por aproximação e estavam com taxa zero registrada. A correção atende
pedidos pagos, visíveis, sem cálculo automático e sem taxas ou retificação prévia.
Pendências, cancelados, excluídos, pedidos automáticos e valores já ajustados são
preservados. A feira precisa continuar ativa.

`payment_fee_corrections` guarda, por item, taxa anterior, taxa corrigida, leitura,
motivo e horário. Os registros de venda, itens, hashes de reenvio, estoque e
snapshots originais continuam intactos. Repetir o procedimento não acrescenta
outra taxa. A consulta aplica essa trilha ao histórico, ao total da feira e aos
repasses.

Para um dia fechado antes da correção, `summary` permanece o original e
`adjustedSummary` contém somente as diferenças de taxa posteriores. A interface
mostra o líquido original, a diferença e o líquido ajustado. Pendências daquele
fechamento e a conferência de dinheiro permanecem como foram gravadas. Fechamentos
novos guardam o último ID de retificação incluído, impedindo desconto duplicado.

Com a Nightly fechada e os fontes compilados:

```bash
npm run build
node scripts/corrigir-taxas-cartao.mjs data/nightly/caixa.sqlite 1
node scripts/corrigir-taxas-cartao.mjs data/nightly/caixa.sqlite 1 --apply
```

Sem `--apply`, o comando corrige somente uma cópia temporária e imprime a simulação.
Com `--apply`, cria um backup completo consistente em `data/nightly/backups/` antes
de migrar/gravar, e aplica a retificação numa transação. O ID identifica a feira;
neste banco, a Oktoberfest é a feira 1. Não executar esse procedimento em outro
evento sem conferir quais cartões foram realmente cobrados dessa forma.

## Exportação e recuperação

O CSV de pedidos contém leitura do cartão, valores de taxa/líquido efetivos e
indicação de retificação. Pedidos divididos acrescentam formas, valores e taxas
dos dois pagamentos somente na primeira linha do pedido; as linhas seguintes
mantêm essas colunas vazias para impedir soma duplicada. O CSV de feiras contém bruto e taxa por participante,
além dos líquidos e da identificação da meta da Con Affetto. O CSV de dias inclui
líquido original e taxas corrigidas após fechamento. O backup SQLite inclui a
trilha e todos os registros originais. Ele é o arquivo para recuperação completa.

A migração v5 para v6 apenas acrescenta campos/tabela, sem recalcular os registros.
A migração v6 para v7 cria `sale_payments`, sem preencher pagamentos de pedidos
anteriores e sem modificar vendas, itens, hashes, retificações ou snapshots.
O restaurador valida backups v1 a v7 e migra uma cópia. Para retornar a uma versão
antiga, conserve e restaure o backup da versão compatível em um novo destino.
O banco v7 é recusado pelas versões anteriores; o Flatpak antigo mantém seu banco
independente. Não sobrescreva um banco de uso.
