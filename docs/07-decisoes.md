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
| Migração inicial com identidade das linhas | Trazer pedidos e fechamentos, preservando o saldo já importado e os pedidos nativos. | Se for necessário conciliar alterações posteriores de duas fontes em uso. |
| Horário de registro com origem explícita | Mostrar o instante conhecido sem atribuir a vendas antigas o horário da importação. | Se a origem passar a registrar o instante real da venda. |

## Evidência obtida durante a construção

O teste de reconciliação usa uma extração privada da última versão salva do ODS. Reproduz as vendas em um banco temporário e confere participantes, pagamentos, descontos, taxas, pendências e estoques. Isso verifica esse snapshot, sem afirmar que ele contém alterações ainda abertas e não salvas no Calc.

A revisão independente encontrou o risco de salvar estoque antigo de outra aba e de receber pendência antes de sua origem. Foram adicionadas proteção de versão e validação de data, com regressões que verificam que a recusa não altera dinheiro ou estoque.

Um teste de backup confundia desserialização de Buffer em memória com restauração de arquivo WAL. O SQLite exportado reabriu por arquivo; o teste foi corrigido para verificar esse fluxo real. O banco de uso permanece em WAL.

O bloqueio de banco de versão futura foi movido para antes dos pragmas persistentes. O teste compara os bytes e o modo de journal antes e depois de uma recusa.

A proteção de edição alterou o esquema dos produtos. A revisão encontrou que bancos v1 antigos ainda seriam aceitos sem a coluna necessária. A abertura agora migra v1 para v2 em transação, preservando os registros e snapshots. A restauração valida as colunas e migra somente uma cópia, mantendo o backup original.

A revisão também reproduziu a reaplicação de um WAL antigo no destino de restauração: integridade válida não garantia que os registros vinham do backup escolhido. O restaurador passou a recusar destinos com qualquer auxiliar existente; a regressão usa um WAL real e confere que a recusa preserva os arquivos.

A compilação Angular inseria um evento `onload` inline para carregar o CSS; a política de scripts do servidor bloqueava esse evento e deixava o CSS em modo de impressão. A otimização de CSS crítico foi desativada, mantendo a política. O teste de navegador confere o estilo carregado e erros do console.

O primeiro carregamento do catálogo não trouxe os pedidos ou fechamentos do ODS. A migração acrescentou vínculos estáveis por posição física da linha, snapshots de preço/participante e conferência dos resumos antes de confirmar a transação. O hash do arquivo completo identifica a evidência lida; ele não cria uma nova identidade de venda a cada salvamento. O hash da linha original permanece separado do estado atual do pedido, permitindo repetir a importação depois de receber ou cancelar sem desfazer essas ações.

O cancelamento no histórico permanece sujeito à confirmação e ao bloqueio de pagamentos de dias fechados. A ação aparece no rodapé do pedido, com botão contornado e separação visual do recebimento de pendências. Em tela estreita, as ações se acomodam em linhas distintas.

## Antes da troca definitiva

- Conferir catálogo e estoque disponível na data de adoção; o snapshot importado pode envelhecer enquanto a planilha continua recebendo vendas.
- Ensaiar atendimento, ajustes, cancelamento e fechamento com as situações reais da feira.
- Conferir os pedidos e fechamentos migrados contra o snapshot salvo e definir o momento de passar a lançar em uma única fonte.
- Definir retificação de dia fechado, devolução/estorno parcial ou outras situações que forem necessárias na operação real.
- Guardar um backup e provar sua recuperação em outro arquivo.

A migração de histórico é um comando explícito com backup. Não há sincronização contínua nem data definida para abandonar a planilha. O critério é a conferência do comportamento e dos dados necessários ao uso real.
