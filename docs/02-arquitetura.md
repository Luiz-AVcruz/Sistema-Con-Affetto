# Arquitetura e caminho de uma venda

## Composição

O projeto usa npm workspaces para manter três pacotes relacionados no mesmo repositório:

```text
apps/web/          interface Angular
apps/api/          servidor Node e regras de aplicação
packages/shared/  tipos e nomes de pagamento compartilhados
packages/caixa-core/ núcleo financeiro Rust em validação, sem acesso ao banco
scripts/          extração, recuperação e infraestrutura de teste
docs/             explicação e exercícios
data/             banco e referências privadas, fora do Git
```

Angular oferece componentes, injeção de dependências e formulários. Node permite desenvolver o backend aproveitando a experiência existente em JavaScript. SQLite concentra a persistência em um banco local, sem administrar um serviço externo. Express cuida do HTTP; Zod valida os dados recebidos; better-sqlite3 executa SQL e transações.

Essa estrutura atende um processo e um operador. Não há autenticação, sincronização, implantação pública ou múltiplas feiras simultâneas. Para operar por uma rede ou internet, seria necessário revisar segurança, usuários, concorrência e operação do banco antes de mudar o endereço de escuta.

Em uso normal, Node serve a interface Angular compilada e a API pela porta 3333, apenas em `127.0.0.1`. No desenvolvimento, Angular usa a porta 4200 e um proxy para a API. Os endereços são locais; não representam um servidor na nuvem.

## Caminho de um pedido

1. `SalesComponent` monta o carrinho com os preços exibidos e os ajustes por item.
2. `CashStore.saveSale` envia o JSON e bloqueia submissões simultâneas pela interface.
3. `app.ts` recebe o HTTP. O schema em `validation.ts` verifica tipos, inteiros, limites, datas e campos permitidos.
4. `CashRegister.createSale` verifica chave de reenvio, dia aberto, produtos, preços e regras financeiras.
5. `calculateItem` determina os valores de cada item em centavos.
6. Uma transação grava o pedido, seus itens e as baixas de estoque. Qualquer falha desfaz esse conjunto.
7. A API confirma o pedido somente depois de a transação retornar com sucesso.
8. A interface limpa o rascunho confirmado e atualiza catálogo e resumos.

TypeScript verifica o programa antes da execução. Ele não valida JSON enviado por um navegador: uma pessoa pode chamar a API sem usar a interface. Essa é a razão de existir validação em tempo de execução com Zod.

O frontend mostra uma previsão do total; o backend decide o que pode ser salvo. Desabilitar um botão ajuda o atendimento, mas não protege o banco contra uma requisição inválida.

## Estado na interface

`CashStore` é um serviço injetado nos componentes. Ele mantém dados, data selecionada, mensagens e estado de carregamento em signals. Os componentes de Vender, Produtos, Fechamento e Histórico assumem seus próprios formulários.

`HttpClient` produz Observables. Nesta primeira versão, `firstValueFrom` transforma uma resposta única em Promise para permitir uma sequência clara com `await`. Streams, cancelamento com `switchMap` e roteamento podem ser estudados depois de existir uma necessidade concreta.

A leitura do bootstrap usa uma sequência numérica para ignorar respostas antigas. Uma resposta lenta da data anterior não deve substituir os dados de uma data selecionada depois.

O carrinho é um rascunho no `localStorage`, associado a uma data e a uma chave de envio. Ele não é uma venda. Os registros financeiros ficam no SQLite. Recarregar a página preserva o rascunho; uma confirmação da API permite limpá-lo.

## Limites e evolução

Não foram adicionados contêineres, filas, microsserviços ou ORM. A fronteira HTTP já permite trocar o backend por Rust sem reescrever a interface. Os tipos TypeScript ajudam esta implementação, mas o contrato em JSON é a fronteira que a outra linguagem terá de respeitar.

As consultas de leitura percorrem o histórico completo, adequado ao protótipo. Se medições mostrarem lentidão com o volume real, a evolução é paginar histórico e agregar pelo SQL. A troca deve preservar os mesmos resultados; não há justificativa para fazê-la apenas por preferência arquitetural.

A migração para Rust começou pelo núcleo financeiro de `packages/caixa-core`, que também oferece um executável para comparação por JSON. A aplicação de uso continua chamando Node; não há duas implementações gravando no mesmo banco. A biblioteca não depende de HTTP, SQLite ou Tauri e poderá ser usada diretamente pelo desktop. Estado, comandos de verificação e critérios de passagem estão em [Migração incremental para Rust](15-migracao-rust.md).

Fontes técnicas: [compatibilidade do Angular](https://angular.dev/reference/versions), [signals](https://angular.dev/guide/signals), [formulários reativos](https://angular.dev/guide/forms/reactive-forms), [versões do Node](https://nodejs.org/en/about/previous-releases) e [API do better-sqlite3](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md).
