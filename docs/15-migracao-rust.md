# Migração incremental do backend para Rust

## Objetivo e estado

O objetivo operacional é manter Angular e Tauri, portando o backend em etapas até poder retirar o runtime Node do aplicativo distribuído. A ampliação futura do sistema não exige mudar agora o banco ou a interface.

Em 11/10/2026 foi iniciada a primeira etapa: o núcleo financeiro Rust em `packages/caixa-core`. Ele é uma biblioteca independente e um executável de comparação por JSON. A Nightly, o Flatpak e a API ainda usam o backend Node. Esta etapa não proporciona redução de tamanho ou RAM do aplicativo em uso; esses ganhos dependem de substituir o backend e retirar seus recursos do pacote.

Nenhum esquema foi alterado, nenhum banco real foi aberto pela implementação Rust e nenhuma dependência do desktop foi modificada. O código Rust não possui acesso a SQLite, arquivos do caixa, estoque ou snapshots. O caminho de retorno continua sendo o aplicativo atual.

## Responsabilidades já portadas

- Cálculo de item com preço esperado, produto ativo e expectativas de nome/participante.
- Desconto, taxa manual, bruto, cobrado e líquido em centavos.
- Taxas de cartão: débito/crédito por aproximação ou inserido; demais meios sem taxa automática.
- Arredondamento único por pedido e rateio pelos maiores restos, com desempate pela ordem dos itens.
- Aplicação das taxas por item sem modificar os valores de entrada.
- Resumo por pagamento e participante, pendências, permutas e brindes.
- Filtro do dia pela data do recebimento para pedidos pagos e pela data do pedido para pendências.

O resumo utiliza as taxas fornecidas pelo leitor, incluindo retificações já aplicadas. Não calcula novamente taxas antigas, não seleciona feiras e não reconstrói snapshots fechados. A seleção da feira, exclusões e leitura do histórico continuam sendo responsabilidades do backend.

`FinancialSale` é uma projeção dos campos financeiros de `Sale`; não é um novo formato de banco nem o contrato de gravação de pedido. Metadados como IDs, origem, horários e marcadores de retificação não são necessários para somar valores e não são devolvidos pelo comando de resumo. `calculateItem` conserva os campos opcionais de expectativa recebidos e omite os ausentes.

## Dinheiro e limites

Valores armazenados no núcleo são inteiros de 64 bits. Produtos, ajustes e quantidades no cálculo de item respeitam os limites numéricos atuais da API. Intermediários de multiplicação e arredondamento usam inteiros de 128 bits; não há `float` no cálculo financeiro.

Nenhum resultado financeiro pode exceder `Number.MAX_SAFE_INTEGER`, pois o contrato atual é consumido por JavaScript. Um total acima desse limite é recusado, sem arredondamento silencioso. Essa proteção é deliberadamente mais forte que os acumuladores sem limite explícito da referência TypeScript; a equivalência é exigida dentro do intervalo exato do contrato.

A fronteira JSON aceita representações integrais como `2000.0`, `2e3` e `-0`, assim como `JSON.parse`. Um visitante Serde converte apenas números integrais e seguros para `i64`; frações, strings numéricas e inteiros inseguros são recusados. `serde_json` usa `float_roundtrip` para conservar a conversão correta também nos limites de representação. A leitura JSON pode usar ponto flutuante ao interpretar essas formas textuais, mas os valores entregues ao domínio e todos os cálculos são inteiros. Os testes enviam JSON bruto para impedir que `JSON.stringify` esconda essa diferença.

Datas são filtros fornecidos como texto, sem conversão de fuso. A validação de data ISO, autenticação local/HTTP, estoque, idempotência, transações e regras de fechamento ainda precisam ser portadas antes de gravar pedidos com Rust. O executável desta etapa não deve ser tratado como uma API completa.

## Verificar a etapa

Na raiz do projeto:

```bash
npm run test:rust
```

O comando compila os tipos compartilhados, verifica `cargo fmt`, roda testes Rust, compila o executável e envia comandos ao processo Rust real para comparar com a referência Node. Os casos exercitam taxas, quantidades, descontos, conflitos do catálogo, valores grandes, data de recebimento, cancelamentos, exclusões e retificações. Os cenários de histórico criam SQLite em memória. Não se deve fornecer o banco do comércio aos testes.

Requisitos: Node/npm já usados pelo projeto, Rust/Cargo 1.90 ou posterior e `rustfmt`. As dependências têm um `Cargo.lock` próprio. Os comandos Cargo usam `--locked --offline`: depois de obter as dependências, a verificação não precisa de rede. Em uma máquina nova, execute antes:

```bash
cargo fetch --locked --manifest-path packages/caixa-core/Cargo.toml
```

O teste usa a pasta de artefatos informada pelo Cargo, inclusive quando `CARGO_TARGET_DIR` estiver definido. `target/` está fora do Git e não entra na seleção de fontes do Flatpak.

## Executar o núcleo sem Node

O binário recebe um comando JSON por linha na entrada padrão e escreve uma resposta por linha. Não aceita um caminho de banco nem abre portas. Exemplo fictício:

```bash
cargo run --locked --offline --manifest-path packages/caixa-core/Cargo.toml <<'JSON'
{"operation":"calculatePaymentFees","amounts":[1900,2000],"method":"Cartão crédito","entry":"Aproximação"}
JSON
```

Resposta:

```json
{"ok":true,"result":[59,62]}
```

Os quatro comandos são `calculatePaymentFees`, `calculateItem`, `applyPaymentFees` e `summarize`. Erros de negócio retornam `ok: false` com `error.status` e `error.message`. Uma linha inválida recebe uma resposta de erro e não impede a leitura da próxima. Erros de entrada/saída do processo encerram com código diferente de zero. Os status são dados de comparação; não existe servidor HTTP nesta etapa.

## Próximas fronteiras e condição de passagem

1. Portar a abertura e leitura do SQLite em banco temporário/cópia: catálogo, feira selecionada, histórico, exclusões, retificações e snapshots imutáveis. Comparar o bootstrap completo.
2. Portar gravações e transações: pedido inteiro ou nenhum item, estoque, recebimento, reenvio com hash compatível, cancelamento e exclusão. Testar falhas e retries na fronteira real do SQLite.
3. Portar fechamentos, encerramento da feira, CSV, backup e recuperação. Demonstrar preservação dos bancos anteriores e snapshots.
4. Conectar Angular ao backend Rust no Tauri e testar o atendimento completo em banco separado. Somente depois retirar o processo Node e seus recursos do pacote.

Não há adoção automática de uma etapa posterior. A substituição da operação exige equivalência funcional, ensaio de recuperação e pacote/atalho que conserve o banco escolhido. O backend Node permanece disponível até essa prova. O formato de transporte final pode ser comandos Tauri ou HTTP; ele não interfere nas regras puras implementadas aqui e será decidido na integração, sem adicionar dois transportes agora.

Referências: [Serde](https://docs.rs/serde/latest/serde/) e [Visitor](https://docs.rs/serde/latest/serde/de/trait.Visitor.html) para o contrato JSON e [inteiros de 128 bits do Rust](https://doc.rust-lang.org/std/primitive.i128.html) para cálculos exatos com intermediários maiores.
