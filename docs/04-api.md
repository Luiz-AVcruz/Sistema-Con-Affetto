# Contrato HTTP

A API recebe JSON em UTF-8. Dinheiro é expresso em centavos inteiros; datas de negócio usam `YYYY-MM-DD`; instantes de gravação usam ISO 8601. Textos de pagamento e situação são exatamente os definidos em `packages/shared/src/index.ts`.

Uma requisição mutável exige `Content-Type: application/json`. O servidor aceita acesso apenas pelo Host local e rejeita origens externas. A interface de produção e a API usam a mesma origem. No desenvolvimento, o proxy do Angular evita precisar configurar CORS.

## Rotas

| Método e caminho | Entrada | Resultado |
| --- | --- | --- |
| `GET /api/health` | Nenhuma. | Estado e versão do aplicativo. |
| `GET /api/bootstrap?date=YYYY-MM-DD` | Data válida. | Participantes, produtos, pedidos, dia, total da feira e fechamentos. |
| `POST /api/owners` | `{ "name": "Participante A" }` | Participante criada ou já existente com esse nome. |
| `POST /api/products` | Cadastro completo. | Produto criado. |
| `PUT /api/products/:id` | Cadastro completo e `expectedVersion`. | Produto atualizado se a versão ainda for a mesma. |
| `POST /api/sales` | Pedido com `requestId` e itens. | Pedido confirmado, ou o pedido existente para um reenvio idêntico. |
| `POST /api/sales/:id/receive` | Data e forma monetária de recebimento. | Pendência recebida, ou confirmação do mesmo recebimento anterior. |
| `POST /api/sales/:id/cancel` | `{}`. | Pedido cancelado. Repetir não devolve estoque duas vezes. |
| `PUT /api/days/:date` | Conferência completa. | Dia aberto com conferência salva. |
| `POST /api/days/:date/close` | Conferência completa. | Snapshot guardado. Reenvio igual retorna o mesmo fechamento. |
| `GET /api/export/sales.csv` | Nenhuma. | CSV por item, com ponto e vírgula e valores em reais. |
| `GET /api/backup` | Nenhuma. | Arquivo SQLite completo. |

`bootstrap` é uma leitura composta para simplificar a primeira interface. Ele não é uma sessão de usuário nem garante que o estoque continuará igual depois da resposta. A escrita valida novamente as condições que podem mudar.

## Cadastro

```json
{
  "name": "Produto de exemplo",
  "description": "100 g",
  "ownerId": 1,
  "priceCents": 1500,
  "stock": null,
  "active": true
}
```

A resposta inclui `id`, `ownerName` e `version`. Para atualizar, envie os mesmos campos de cadastro, acrescentando `expectedVersion` com a versão que foi lida.

Todas as mudanças no produto, incluindo vendas e devoluções de estoque, incrementam `version`. Se outra aba vendeu uma unidade desde que o editor foi aberto, salvar o formulário antigo retorna `409`. Isso impede que uma simples correção do nome reponha uma quantidade já vendida. A interface atualiza a leitura após o conflito, e o operador pode abrir a edição novamente.

## Registrar um pedido

```json
{
  "requestId": "315f3a12-a78f-433c-a96d-c9546d705fcb",
  "date": "2026-10-10",
  "paymentMethod": "Pix",
  "status": "Pago",
  "note": "",
  "items": [
    {
      "productId": 1,
      "quantity": 2,
      "expectedPriceCents": 1500,
      "discountCents": 100,
      "feeCents": 0
    }
  ]
}
```

O produto precisa existir e estar ativo. `expectedPriceCents` é o preço exibido quando o pedido foi montado. Se o cadastro mudou o preço, o servidor retorna conflito em vez de cobrar um valor que o operador não viu. Repetir o produto em mais de um item é recusado; agrupe sua quantidade.

O retorno contém `id`, `date`, `paymentDate`, `paymentMethod`, `status`, `note`, `createdAt`, itens com seus snapshots e somas `grossCents`, `discountCents`, `feeCents`, `totalCents`, `netCents`.

O UUID deve ser criado uma vez por pedido. Um reenvio com o mesmo conteúdo mantém uma única venda. A primeira versão responde `201` tanto ao registro inicial quanto à confirmação desse reenvio. O cliente usa a identidade e os valores do pedido para reconhecer a confirmação.

## Receber uma pendência

```json
{ "date": "2026-10-11", "paymentMethod": "Dinheiro" }
```

O destino precisa estar aberto e não pode ser anterior à data do pedido. A forma deve ser Dinheiro, Pix, Cartão débito ou Cartão crédito. Os preços e participantes originais continuam iguais; o estoque atual é conferido no momento da baixa.

## Conferir ou fechar um dia

```json
{
  "openingCents": 5000,
  "extraCents": 0,
  "withdrawalCents": 1000,
  "countedCents": null,
  "note": "Contagem não realizada"
}
```

`countedCents: null` é ausência de contagem; `0` é uma contagem de zero. A resposta inclui `summary`, `expectedCents`, `differenceCents` e `closedAt`. Dia aberto tem `closedAt: null`. Um fechamento já guardado retorna conflito se o novo corpo tentar mudar seus valores.

## Resumos e erros

Um `Summary` contém recebido, líquido, descontos, taxas, pendentes, contagem de pedidos pagos, unidades de permuta/brinde, partes por participante e pagamentos monetários. `paidCount` inclui pedidos pagos sem cobrança; não é uma contagem apenas de vendas monetárias.

```json
{ "error": "Estoque insuficiente: Produto de exemplo. Nenhum item do pedido foi registrado." }
```

| Código | Interpretação |
| --- | --- |
| `400` | Campos ou regra de entrada inválidos. |
| `403` | Host ou origem não autorizados. |
| `404` | Registro ou rota inexistentes. |
| `409` | Conflito com estoque, cadastro, dia fechado ou comando já registrado. |
| `415` | Tipo de conteúdo incorreto. |
| `500` | Falha inesperada. O cliente deve conferir o histórico e preservar a chave antes de repetir. |

Erros de schema também incluem `details`. A interface não depende de mensagens internas do SQLite. Os testes HTTP conferem respostas pela fronteira da API; esses cenários podem ser reaproveitados na implementação em Rust.
