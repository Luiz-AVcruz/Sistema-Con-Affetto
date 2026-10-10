# Roteiro de estudo

## Método

Antes de editar, escreva o resultado esperado com um exemplo numérico. Identifique o ponto que decide esse resultado. Depois reproduza o cenário, altere o código e confira tanto o novo comportamento quanto uma regra próxima que deve permanecer igual.

Use a IA para explicar um erro específico, contestar uma hipótese ou revisar um trecho que você já tentou. Para um exercício, não peça a implementação completa antes de ter escrito sua própria tentativa e entendido o teste que falhou.

Um ciclo útil de trabalho é: requisito concreto, hipótese, teste, implementação, conferência e registro da decisão. O histórico do Git pode guardar cada passo pequeno. Um teste que apenas copia a sequência do código não prova que a regra está correta.

## Etapa 1: executar e localizar

Compile, inicie e registre um pedido em um banco de estudo. Use `CAIXA_DB` para apontar a outro arquivo antes de iniciar o servidor. Não faça os exercícios no banco do comércio.

Leia `packages/shared/src/index.ts`. Explique a diferença entre `Product` e `SaleItem`, entre `stock: null` e `stock: 0`, e entre `date` e `paymentDate`.

Abra as ferramentas do navegador na aba Network e observe o POST de um pedido. Localize os mesmos campos no formulário, no schema e na tabela. Verifique que a resposta só chega depois da transação e que o pedido continua após reiniciar o Node.

Critério: conseguir acompanhar uma venda do clique até o SQLite e explicar onde o total é decidido.

## Etapa 2: Angular

Leia `app.component`, os quatro componentes de funcionalidades e `CashStore`. Observe onde há signals, onde há valores de formulário e onde há chamadas HTTP. O cadastro de produtos usa formulários reativos; o pedido usa um formulário simples para editar uma lista dinâmica.

Exercício: acrescentar um filtro por participante na tela de venda. Defina se a busca por texto continua funcionando junto com o filtro. Faça a mudança no frontend e confira que ela não altera a regra de criação dos pedidos.

Exercício: identificar quais estados devem sobreviver a uma troca de aba e quais devem sobreviver a um recarregamento. Explique por que carrinho no navegador e venda no banco têm responsabilidades distintas.

Critério: modificar um comportamento da interface sabendo qual componente ou serviço é responsável por ele.

## Etapa 3: HTTP e validação

Leia `app.ts` e `validation.ts`. Envie uma quantidade fracionária ou um desconto maior que o preço pelo HTTP, contornando a interface. Observe os códigos e confirme que o banco continua igual.

Exercício: melhorar a exibição de `details` quando houver um erro de entrada. Não exiba um sucesso quando a resposta não confirmou a operação.

Exercício: prever o resultado de dois envios com o mesmo UUID e de dois envios com UUIDs diferentes. Depois confira o resultado nos testes de HTTP e no estoque.

Critério: explicar por que tipagem TypeScript, validação do JSON e regras transacionais são proteções diferentes.

## Etapa 4: domínio e SQL

Leia `finance.ts`, depois `cash-register.ts` e `database.ts`. Faça à mão um pedido com desconto e taxa em participantes diferentes. Compare o recebido, o líquido e o dinheiro físico esperado.

Exercício: adicionar ao resumo a quantidade de unidades com cobrança, distinguindo-a da contagem de pedidos pagos e das unidades sem cobrança. Escreva um cenário com quantidade maior que um antes de implementar.

Exercício: reproduzir uma falha no segundo produto de um pedido e observar o rollback. A conferência deve verificar ausência do pedido e dos itens, além de estoque intacto; contar apenas uma chamada ao método de transação seria insuficiente.

Exercício: abrir um produto para editar, vender em outra aba e tentar salvar a edição antiga. Explique a função de `expectedVersion` e por que um botão desabilitado na primeira aba não protege a segunda.

Critério: implementar uma alteração de regra sem permitir estados parciais ou reescrever o histórico.

## Etapa 5: falhas e recuperação

Execute `npm test` e leia um caso que falha intencionalmente depois de uma mudança feita em um banco de estudo. Localize a suposição violada antes de modificar a expectativa.

Baixe um backup de teste, restaure em um caminho novo e inicie o programa com esse banco. Compare pedidos, estoque e fechamentos. Tente restaurar no mesmo destino novamente: a operação deve recusar sobrescrita.

Os testes de regra exercitam SQLite real. Os testes HTTP conferem a API. O teste do navegador percorre a interface compilada. Nenhum deles sozinho confirma a migração completa da planilha ou todos os detalhes do atendimento real.

Critério: distinguir uma falha do código, uma expectativa incorreta do teste e uma limitação do ambiente.

## Registro de aprendizado

Para cada alteração, anote no seu próprio caderno ou commit: qual problema mudou, qual hipótese estava errada, qual teste demonstrou o resultado e qual limitação permanece. Antes de considerar a mudança entendida, tente explicar o caminho sem olhar o código e então confira a explicação nos arquivos.
