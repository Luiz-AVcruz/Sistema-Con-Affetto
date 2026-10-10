# Decisões e pendências

## Decisões desta versão

| Decisão | Motivo | Quando revisar |
| --- | --- | --- |
| Angular + Node/TypeScript | Aproveitar experiência profissional e produzir uma referência de estudo. | Ao fazer o desafio Rust ou ao mudar explicitamente o objetivo. |
| Navegador local e Node em loopback | Um operador no notebook, sem necessidade de infraestrutura online. | Se houver uso por rede, outro dispositivo ou distribuição como programa instalado. |
| SQLite e SQL explícito | Persistência local e transações observáveis, sem administrar outro serviço. | Se medições e novos requisitos justificarem outra arquitetura. |
| Ajustes por item | Preservar a regra da planilha e evitar inventar rateio global. | Se desconto ou taxa do pedido inteiro passar a ser necessário. |
| Pendência sem reserva de estoque | Reproduzir a planilha. | Se produto separado para cliente precisar ficar indisponível para outros atendimentos. |
| Recebimento em data própria | O dinheiro entra no caixa no dia em que é recebido. | Se o relatório desejar outra convenção, mantendo clara a distinção das datas. |
| Snapshot de fechamento bloqueado | Proteger um dia já conferido contra alteração posterior silenciosa. | Quando houver procedimento de retificação com motivo, histórico e backup. |
| Versão otimista no cadastro | Impedir que formulário antigo restaure estoque já baixado por outra aba. | Ao separar operações de cadastro e contagem ou introduzir outro modelo de concorrência. |
| CSV e backup SQLite | Consulta no Calc e recuperação completa são tarefas diferentes. | Quando houver necessidade concreta de XLSX com múltiplas abas. |

## Evidência obtida durante a construção

O teste de reconciliação usa uma extração privada da última versão salva do ODS. Reproduz as vendas em um banco temporário e confere participantes, pagamentos, descontos, taxas, pendências e estoques. Isso verifica esse snapshot, sem afirmar que ele contém alterações ainda abertas e não salvas no Calc.

A revisão independente encontrou o risco de salvar estoque antigo de outra aba e de receber pendência antes de sua origem. Foram adicionadas proteção de versão e validação de data, com regressões que verificam que a recusa não altera dinheiro ou estoque.

Um teste de backup confundia desserialização de Buffer em memória com restauração de arquivo WAL. O SQLite exportado reabriu por arquivo; o teste foi corrigido para verificar esse fluxo real. O banco de uso permanece em WAL.

O bloqueio de banco de versão futura foi movido para antes dos pragmas persistentes. O teste compara os bytes e o modo de journal antes e depois de uma recusa.

A proteção de edição alterou o esquema dos produtos. A revisão encontrou que bancos v1 antigos ainda seriam aceitos sem a coluna necessária. A abertura agora migra v1 para v2 em transação, preservando os registros e snapshots. A restauração valida as colunas e migra somente uma cópia, mantendo o backup original.

A revisão também reproduziu a reaplicação de um WAL antigo no destino de restauração: integridade válida não garantia que os registros vinham do backup escolhido. O restaurador passou a recusar destinos com qualquer auxiliar existente; a regressão usa um WAL real e confere que a recusa preserva os arquivos.

A compilação Angular inseria um evento `onload` inline para carregar o CSS; a política de scripts do servidor bloqueava esse evento e deixava o CSS em modo de impressão. A otimização de CSS crítico foi desativada, mantendo a política. O teste de navegador confere o estilo carregado e erros do console.

## Antes da troca definitiva

- Conferir catálogo e estoque disponível na data de adoção; o snapshot importado pode envelhecer enquanto a planilha continua recebendo vendas.
- Ensaiar atendimento, ajustes, cancelamento e fechamento com as situações reais da feira.
- Escolher como guardar ou migrar pedidos e fechamentos antigos. A extração atual não traz esse histórico para o banco de uso.
- Definir retificação de dia fechado, devolução/estorno parcial ou outras situações que forem necessárias na operação real.
- Guardar um backup e provar sua recuperação em outro arquivo.

Não existe migração automática ou data definida para abandonar a planilha nesta versão. O critério é a conferência do comportamento e dos dados necessários ao uso real.
