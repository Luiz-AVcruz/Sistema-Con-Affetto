# Guia de estudo

Esta documentação explica o funcionamento do programa para permitir leitura, depuração, alteração e reconstrução. O código é uma implementação de referência; entender uma decisão exige acompanhar a entrada, a regra e a evidência que verifica o resultado.

Leia nesta ordem:

1. [Escopo e regras do caixa](01-dominio.md): o que o programa deve representar.
2. [Arquitetura e caminho de uma venda](02-arquitetura.md): quem assume cada responsabilidade.
3. [Dados, dinheiro e transações](03-dados.md): o que deve permanecer correto mesmo quando algo falha.
4. [Contrato HTTP](04-api.md): como interface e backend conversam.
5. [Roteiro de estudo e exercícios](05-estudo.md): como trabalhar no projeto sem delegar a implementação inteira.
6. [Reconstrução do backend em Rust](06-desafio-rust.md): critérios de equivalência e sequência do desafio.
7. [Versionamento local](08-git.md): como conferir, selecionar e registrar mudanças sem incluir os dados do caixa.
8. [Importação de histórico](09-importacao-historico.md): como migrar pedidos e fechamentos sem duplicar estoque ou inventar horários.

Depois de mudar um comportamento, atualize a regra correspondente e o teste que a demonstra. Registre decisões específicas em [Decisões e pendências](07-decisoes.md), com o motivo e a condição que justificaria revisá-las.

Os dados reais não fazem parte da documentação versionada. Exemplos usam produtos e participantes fictícios. A planilha extraída e os bancos de teste ficam separados do banco de uso.
