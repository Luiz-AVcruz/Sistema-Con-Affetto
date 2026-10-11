# Desafio: reconstruir o backend em Rust

Este roteiro foi escrito quando o Rust era um exercício de estudo. A migração para uso operacional começou em 11/10/2026 pelo núcleo financeiro. Consulte [Migração incremental para Rust](15-migracao-rust.md) para o estado atual e a sequência de adoção. O restante deste documento permanece como material de estudo.

## Objetivo

Implementar um backend Rust que atenda à interface Angular e preserve as regras do caixa. A primeira versão em Node oferece comportamento observável, testes e exemplos. O desafio não é traduzir instruções linha por linha; é representar essas responsabilidades na outra linguagem e provar os resultados.

Mantenha o Angular no primeiro ciclo. Trocar a interface, linguagem do backend e comportamento financeiro ao mesmo tempo dificulta descobrir a origem de uma diferença.

Crie um projeto Rust separado e use um banco temporário. Preserve a implementação Node e o banco do comércio. A migração de um banco existente é outro exercício, com backup, compatibilidade de schema e prova de preservação.

## Conhecimentos a construir

Aprenda o necessário para representar o domínio: structs, enums, ownership/borrowing, referências, `Option`, `Result`, módulos, testes, serialização JSON e acesso a SQLite. O estoque desconhecido se relaciona naturalmente com `Option`; rejeições de negócio e falhas de infraestrutura precisam de representação explícita.

Escolha bibliotecas HTTP e SQLite ao iniciar o desafio, verificando sua documentação e compatibilidade. Usar uma biblioteca não dispensa entender a duração da conexão, o escopo da transação ou quando uma operação foi concluída.

Não há necessidade inicial de threads adicionais, filas, serviços distribuídos ou outro banco. Aumentar a complexidade muda o problema que os testes precisam verificar.

## Sequência de implementação

1. Defina structs/enums que representem os pedidos e itens do contrato, mantendo os nomes JSON esperados pelo Angular.
2. Implemente cálculos de item e resumo sem HTTP. Use os exemplos de desconto, taxa, permuta e pedido misto.
3. Crie SQLite e leia um catálogo fictício. Represente `A contar` sem convertê-lo em zero.
4. Implemente o registro transacional: preço histórico, participante, quantidade e estoque precisam permanecer coerentes se o segundo item falhar.
5. Implemente idempotência. Repita o mesmo comando sem duplicar efeitos e rejeite a mesma chave com valores diferentes.
6. Exponha as rotas do contrato. Preserve validação em tempo de execução, códigos de erro, nomes de campos e valores em centavos.
7. Implemente pendência, recebimento posterior e cancelamento. Teste datas inválidas e ausência de estoque antes de conectar a interface.
8. Implemente conferência, snapshot de fechamento, CSV e backup restaurável.
9. Rode os testes de contrato e, por último, o fluxo Angular usando somente o backend Rust.

Depois de o Rust cumprir o contrato, altere apenas o destino do proxy ou a configuração de início do servidor para comparar implementações. Os testes não devem precisar saber qual linguagem fez a transação.

## Prova de equivalência

`apps/api/test/api.test.ts` pode conectar a uma API externa de teste por `CAIXA_TEST_URL`. Ele envia HTTP real e usa dados fictícios próprios. A porta 3333 é recusada para reduzir o risco de usar o caixa principal. A API de teste deve usar um banco vazio e descartável.

```bash
# Depois de iniciar o seu backend Rust de estudo em uma porta de teste livre:
CAIXA_TEST_URL=http://127.0.0.1:3437 node --import tsx --test apps/api/test/api.test.ts
```

Esse teste cobre parte do contrato, não todas as regras. Os cenários de `register.test.ts` precisam ser implementados em testes Rust ou ampliados pela fronteira HTTP. O teste do navegador também precisa iniciar o servidor Rust com um banco temporário; ajuste esse mecanismo somente depois de concluir as regras.

Critérios mínimos: mesmos totais por pagamento e participante; mesmos efeitos de estoque; mesmas recusas de entrada inválida; pedido inteiro ou nenhum item após uma falha; reenvio sem duplicação; fechamento preservado; backup que reabre e mantém os dados.

## Uso da IA durante o desafio

Antes de pedir ajuda, escreva a regra, tente uma implementação e produza um caso que mostre a dúvida. Pedidos úteis são explicar uma mensagem do compilador, confrontar uma hipótese sobre lifetimes ou revisar uma transação que você já escreveu.

Se a IA fornecer uma solução, explique por que ela funciona e faça uma mudança pequena que não esteja no exemplo. Não considere o trecho dominado apenas porque ele compilou.

O desafio termina quando você consegue implementar, depurar e explicar o caminho de um pedido, além de provar a equivalência nas regras escolhidas. Desempenho não é um critério de superioridade sem medições comparáveis.

Referência inicial: [The Rust Programming Language](https://doc.rust-lang.org/book/).
