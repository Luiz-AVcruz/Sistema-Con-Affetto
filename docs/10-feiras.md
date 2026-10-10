# Metas, encerramento e histórico de feiras

O programa mantém uma feira em andamento por vez. Cada feira tem nome, data inicial, meta financeira opcional, pedidos e fechamentos próprios. O cadastro de participantes, produtos e o estoque continuam compartilhados para a feira seguinte.

## Uso

Na seção **Feiras**, informe um nome e, se quiser, uma meta em reais. O progresso usa o **líquido recebido**, depois das taxas. Pedidos pendentes, cancelados, permutas e brindes não acrescentam dinheiro à meta. Deixar a meta vazia remove somente a meta; os valores registrados continuam iguais.

**Fechar dia** guarda a conferência daquele dia. **Encerrar feira** guarda o resumo definitivo do evento inteiro. São operações distintas. Antes de encerrar a feira, receba ou cancele todos os pedidos pendentes, inclusive pedidos cujo valor seja zero. A data de encerramento não pode preceder pedidos, recebimentos ou conferências já registrados.

Ao encerrar, os dias ainda abertos são fechados com as conferências **já salvas**. A contagem física continua opcional: ausência de contagem não é zero contado. Os snapshots de dias já fechados permanecem intactos. Valores digitados em um formulário e ainda não salvos não participam desse procedimento.

A feira encerrada fica disponível para consulta. Seus pedidos, recebimentos, metas e fechamentos não podem ser alterados. Uma correção financeira posterior exige um procedimento específico, ainda não implementado; não se deve editar o SQLite manualmente.

Quando não houver feira ativa, use **Iniciar próxima feira**. É permitido encerrar uma feira e iniciar outra na mesma data: os dias são identificados pelo par `(fair_id, date)`, portanto o fechamento anterior não bloqueia o novo caixa. A nova data inicial precisa ser igual ou posterior ao encerramento da feira anterior.

O seletor no cabeçalho permite consultar outra feira. O carrinho é guardado por feira, incluindo a data e o UUID de reenvio. Trocar de feira não transfere itens nem descarta o carrinho anterior. Um rascunho de feira encerrada pode ser consultado e limpo; não pode ser registrado como uma nova venda nela.

## Exportação e recuperação

- **Exportar pedidos desta feira**: CSV com uma linha por item, dados praticados, situação, recebimento e identificação da feira.
- **Exportar fechamentos**: CSV dos dias, incluindo valores atuais de dias ainda abertos e snapshots dos dias fechados. Contagem desconhecida é campo vazio.
- **Exportar todas** na lista de feiras: CSV dos eventos, datas, metas, recebido/líquido, ajustes, pendências, pagamentos e partes por participante.
- **Baixar backup**: SQLite completo com todas as feiras, catálogo, estoque, pedidos, fechamentos e vínculos com a planilha.

Os CSVs usam UTF-8 com BOM, ponto e vírgula e vírgula decimal, para abertura no LibreOffice Calc. Textos potencialmente interpretados como fórmula são escapados. CSV é consulta; o backup SQLite é o arquivo de recuperação completa.

## Migração de bancos antigos

O esquema v4 cria a **Feira atual** e vincula todos os registros anteriores a ela. A data inicial é a menor data existente. As tabelas de dias e origens importadas são reconstruídas com a identificação da feira; preços, participantes, hashes de reenvio, saldos e snapshots não são recalculados. A migração usa transação e confere referências antes de confirmar.

O restaurador aceita bancos v1, v2, v3 e v4. Ele valida e migra somente uma cópia, recusando destino existente ou com arquivos auxiliares. O backup original permanece disponível.

O histórico do ODS precisa ser migrado antes de encerrar a primeira feira ou criar outra. Caso a planilha tenha recebido vendas desde o seed, a conciliação inicial explícita usa seu saldo salvo e desconta os pedidos pagos no aplicativo. A conferência padrão considera os ajustes já registrados, mas a conciliação automática de divergências é recusada em produtos com contagem manual: ela pode já incluir as vendas novas da planilha. Mudanças permitidas de saldo incrementam a versão do produto e ficam registradas. A importação nunca lança as vendas antigas como novas saídas de estoque.

## Contrato da API

`GET /api/bootstrap?date=YYYY-MM-DD&fairId=N` retorna `fair`, `fairs` e `activeFairId`, além dos dados já existentes. Sem `fairId`, usa a feira ativa ou, se todas estiverem encerradas, a mais recente.

`POST /api/fairs` recebe `{name,targetCents,startDate}`. `PUT /api/fairs/:id` recebe `{name,targetCents}`. `POST /api/fairs/:id/close` recebe `{date}`. As três operações retornam a feira resultante. A meta é `null` ou um inteiro positivo em centavos.

Pedidos novos incluem `fairId`. Receber, cancelar e alterar/fechar dia usam o parâmetro `?fairId=N`. O backend valida o contexto: não basta bloquear botões. Um UUID antigo não pode ser reaproveitado numa feira nova; o reenvio idêntico dirigido à feira original pode confirmar o registro anterior sem alterar dinheiro ou estoque.

`GET /api/export/sales.csv` e `GET /api/export/days.csv` aceitam o filtro opcional `fairId`. Sem filtro, incluem todas as feiras. `GET /api/export/fairs.csv` sempre inclui todos os resumos. O backup contém o banco inteiro.
