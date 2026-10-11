# Decisões e pendências

## Decisões desta versão

| Decisão | Motivo | Quando revisar |
| --- | --- | --- |
| Tauri com Angular + Node/TypeScript | Abrir pelo ícone, reaproveitando telas e regras já verificadas. A prioridade passou a ser utilidade no comércio. | Se medições ou limitações de uso justificarem substituir a interface ou o backend. |
| Backend local gerenciado pelo desktop | Um operador offline, sem iniciar serviços manualmente. O modo web continua disponível para manutenção. | Se houver uso por rede ou outro dispositivo. |
| SQLite e SQL explícito | Persistência local e transações observáveis, sem administrar outro serviço. | Se medições e novos requisitos justificarem outra arquitetura. |
| Ajustes por item | Preservar a regra da planilha e evitar inventar rateio global. | Se desconto ou taxa do pedido inteiro passar a ser necessário. |
| Pendência sem reserva de estoque | Reproduzir a planilha. | Se produto separado para cliente precisar ficar indisponível para outros atendimentos. |
| Recebimento em data própria | O dinheiro entra no caixa no dia em que é recebido. | Se o relatório desejar outra convenção, mantendo clara a distinção das datas. |
| Snapshot de fechamento bloqueado | Proteger um dia já conferido contra alteração posterior silenciosa. | Quando houver procedimento de retificação com motivo, histórico e backup. |
| Versão otimista no cadastro | Impedir que formulário antigo restaure estoque já baixado por outra aba. | Ao separar operações de cadastro e contagem ou introduzir outro modelo de concorrência. |
| CSV e backup SQLite | Consulta no Calc e recuperação completa são tarefas diferentes. | Quando houver necessidade concreta de XLSX com múltiplas abas. |
| Migração inicial com identidade das linhas | Trazer pedidos e fechamentos, preservando o saldo já importado e os pedidos nativos. | Se for necessário conciliar alterações posteriores de duas fontes em uso. |
| Acréscimo explícito de vendas confirmadas | Incluir linhas novas sem reimportar registros antigos nem duplicar suas saídas de estoque. | Quando a origem e o aplicativo deixarem de poder conciliar integralmente; não remover essa proteção para manter dois caixas sincronizados. |
| Horário de registro com origem explícita | Mostrar o instante conhecido sem atribuir a vendas antigas o horário da importação. | Se a origem passar a registrar o instante real da venda. |
| Uma feira ativa, arquivos históricos imutáveis | Separar eventos futuros, metas e fechamentos, sem perder o estoque compartilhado. | Se forem necessários dois eventos simultâneos ou retificação auditável. |
| Porta desktop fixa | Preservar a origem do armazenamento de rascunhos e UUIDs entre aberturas. | Ao mover rascunhos para persistência independente da origem web. |
| Flatpak privado com runtime GNOME e Node empacotado | Usar o mesmo aplicativo Linux x86_64 no PC e no notebook, sem depender do Node, Rust ou WebKit instalados no host. O banco permanece fora do pacote. | Se outra arquitetura ou sistema operacional passar a ser necessário. |
| SQLite nativo com Node-API, fixado em 13.0.3 | Evitar o abort reproduzido na coleta de wrappers do addon anterior com Node 24.21.0; compilar no SDK e carregar somente esse binário. | Ao atualizar Node ou o addon, repetindo a regressão e o teste do pacote instalado. |

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

## Revisão geral de 10/10/2026

Uma revisão independente com `reviewer_astra` reproduziu três defeitos de operação, além da conferência financeira já realizada. As correções foram limitadas aos caminhos afetados:

- A reinstalação sem repetir `CAIXA_DB` perdia a seleção do banco. A configuração agora permanece fora da instalação substituída; o launcher e os recursos são preparados antes da troca. Testes com filesystem real verificam atualização, migração do atalho antigo e recuperação diante de falha.
- Trocar pagamento monetário com ajustes para permuta/brinde deixava desconto e taxa desabilitados no formulário, mas ainda enviados. A transição zera esses campos, mantendo a recusa correspondente no servidor.
- O carrinho restaurava o produto antigo após edição de nome, preço ou participante. A interface detecta a diferença e exige atualização explícita; o backend verifica as expectativas de nome e participante dos novos clientes antes de criar a venda. Estoque/versionamento não fazem parte dessas expectativas, evitando conflitos sem mudança nos dados apresentados.

Um corpo enviado sem confirmação fica persistido e congelado antes do POST. Somente uma resposta confirmada ou uma recusa HTTP 4xx conhecida libera essa recuperação. Falha de rede, 5xx ou leitura da resposta conserva o corpo; falha ao persistir impede novo envio. Um POST confirmado seguido de falha ao atualizar a tela continua sendo sucesso. Rascunhos anteriores mantêm o formato do payload antigo, sem campos novos que alterariam seu hash.

A recuperação reutiliza o corpo e a chave originais mesmo após mudança do catálogo, da data selecionada ou fechamento do dia/feira. A API resolve o retry por ID/hash antes de validar o estado atual; pedidos ainda inexistentes continuam sujeitos aos bloqueios. Testes de navegador gravam de fato no SQLite e só então abortam a resposta, desafiando a duplicação e as baixas de estoque.

As melhorias opcionais identificadas foram agrupar itens por pedido em uma passagem e acrescentar um atalho “Hoje”/aviso de data. Não houve lentidão observada no volume atual, e a data selecionável é necessária para consulta. Esses pontos ficaram para uma necessidade concreta; não houve mudança de arquitetura, dependências ou otimização ampla.

## Empacotamento de 11/10/2026

O Flatpak foi construído e instalado na conta do PC. O build passou em 78 testes de regras/API, quatro de seleção de fontes e cinco de Rust. Duas comparações com JSONs da planilha foram puladas porque o pacote exclui os dados privados.

O primeiro teste do pacote reproduziu um abort nativo com `better-sqlite3 12.11.1` e Node 24.21.0. A reprodução independente abriu e fechou bancos em memória sob alocações JavaScript, sem restauração nem injeção de falha. O addon 13.0.3 usa Node-API e passou nos 10 mil ciclos; a regressão entrou no build e no diagnóstico do pacote instalado. O manifesto força a compilação no SDK e remove os prebuilds para que o loader use o binário verificado.

O teste final dentro da sandbox confirmou rede privada IPv4/IPv6, addon compilado realmente carregado, frontend servido, venda/reenvio sem duplicação, estoque, CSV, backup/restauração e encerramento efetivo por SIGTERM. A restauração publica um arquivo completo sem sobrescrever destino existente: testes cobrem erro de cópia, interrupção abrupta, links simbólicos quebrados e falha de sincronização após a publicação.

Uma verificação sem janela do portal de documentos confirmou criação, substituição por arquivo temporário e recusa de escrita com permissão somente leitura, conferindo os bytes no host. Isso prova a fronteira de arquivos, mas não o diálogo gráfico Tauri. A janela, o fluxo visual de exportação e o notebook Zorin permanecem sujeitos à conferência manual descrita em [Flatpak privado](12-flatpak.md).

A cópia inicial para a pasta privada do Flatpak conservou o esquema e os 86 registros das oito tabelas do banco da transferência. Integridade e referências foram conferidas; os hashes do banco original e do ODS permaneceram iguais. A cópia privada e o banco do projeto passam a ser arquivos independentes, sem sincronização.

## Antes da troca definitiva

- Conferir catálogo e estoque disponível na data de adoção; o snapshot importado pode envelhecer enquanto a planilha continua recebendo vendas.
- Ensaiar atendimento, ajustes, cancelamento e fechamento com as situações reais da feira.
- Conferir os pedidos e fechamentos migrados contra o snapshot salvo e definir o momento de passar a lançar em uma única fonte.
- Definir retificação de dia fechado, devolução/estorno parcial ou outras situações que forem necessárias na operação real.
- Guardar um backup e provar sua recuperação em outro arquivo.

A migração de histórico é um comando explícito com backup. Não há sincronização contínua nem data definida para abandonar a planilha. O critério é a conferência do comportamento e dos dados necessários ao uso real.
