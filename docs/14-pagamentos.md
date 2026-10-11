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
O líquido é esse bruto menos a taxa. Cada participante paga somente a taxa dos
seus itens; o valor da meta soma apenas o líquido da Con Affetto.

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
indicação de retificação. O CSV de feiras contém bruto e taxa por participante,
além dos líquidos e da identificação da meta da Con Affetto. O CSV de dias inclui
líquido original e taxas corrigidas após fechamento. O backup SQLite inclui a
trilha e todos os registros originais. Ele é o arquivo para recuperação completa.

A migração v5 para v6 apenas acrescenta campos/tabela, sem recalcular os registros.
O restaurador valida backups v1 a v6 e migra uma cópia. Para usar uma versão antiga
do programa, conserve e restaure o backup v5 anterior em um novo destino; o banco
v6 não deve ser aberto pelo Flatpak antigo. Não sobrescreva um banco de uso.
