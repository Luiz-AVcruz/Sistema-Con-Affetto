# Nightly local

O atalho **Caixa da Feira — Nightly** abre uma janela Tauri a partir dos fontes
locais. Ao iniciar, recompila Angular/Node e atualiza o executável Rust quando
seus fontes ou o compilador mudam. Guarda a identificação desses arquivos para
reutilizar a janela já compilada nas outras aberturas. Não cria nem instala um
Flatpak. Feche e reabra para aplicar edições; a janela aberta não recarrega
automaticamente. A preparação pode levar alguns
segundos. Mudanças nas dependências exigem instalá-las antes; o Cargo do atalho
usa o modo offline.

Neste notebook, os fontes estão em `~/Projetos/Sistema-Con-Affetto` e o banco
principal durante o desenvolvimento é `data/nightly/caixa.sqlite`. Ele foi
inicializado com uma cópia consistente do caixa anterior. Depois da cópia,
Nightly e Flatpak têm históricos independentes: não há sincronização nem união
automática. Os dados da Nightly são reais enquanto ela for usada no atendimento;
testes fictícios continuam exigindo outro banco.

O atalho mantém uma trava durante a preparação e a execução. Uma segunda
abertura não recompila os recursos de uma janela em uso. Feche a outra variante
do Caixa antes de abrir a Nightly. O perfil WebKit da Nightly também é separado,
para não compartilhar rascunhos com o Flatpak.

Para recriar o atalho sem substituir o banco existente:

```bash
npm run nightly:install
```

O menu usa `~/.local/share/applications/caixa-da-feira-nightly.desktop`.
O diagnóstico fica em `~/.local/state/caixa-da-feira-nightly/nightly.log`.
Se mover o repositório, execute o instalador novamente. Para escolher outro
banco já restaurado, use `CAIXA_DB=/caminho/absoluto/caixa.sqlite npm run nightly:install`.

Instale o atalho com Node 24.15 ou posterior da série 24. Ele guarda o caminho
desse runtime e o usa para recompilar os recursos em cada abertura, mesmo que
o menu de aplicativos encontre outra versão do Node no sistema. Mantenha esse
runtime instalado; se mudar seu caminho, recrie o atalho com a nova instalação.

Faça backups pela aba Histórico. Ao passar para o Flatpak, feche o caixa,
restaure esse backup em um arquivo novo usando o restaurador da versão de
destino e confira os registros antes de selecioná-lo. O restaurador recusa
esquemas futuros incompatíveis e destinos existentes. Não sobrescreva o banco
da outra versão nem copie somente um SQLite aberto com WAL.

O Flatpak pode ser construído ao final do dia com `npm run flatpak:build`.
Atualizar o pacote não transfere os dados lançados na Nightly.

## Histórico

Na primeira abertura, o histórico mostra somente pedidos e recebimentos da
data de trabalho selecionada, com os mais recentes primeiro. **Mostrar todos
os dias** inclui também pedidos e pendências anteriores da feira consultada.
O seletor **Ordenar pedidos** permite consultar do maior valor para o menor,
do menor para o maior, do mais recente para o mais antigo e no sentido inverso.
O valor é o total exibido no pedido. A data usa o dia do pedido e seu horário
de registro quando conhecido; pedidos importados não ganham uma hora fictícia.

O período e a ordenação escolhidos ficam salvos no perfil local da Nightly,
inclusive ao trocar de seção ou reabrir o aplicativo. Essas preferências não
alteram vendas, totais, CSVs ou o banco SQLite e não integram seu backup.
Esta atualização é aplicada ao código local; o Flatpak instalado conserva
sua versão anterior até uma nova compilação e instalação explícitas.

## Sumário dos dias fechados

A seção **Sumário** lista os dias fechados da feira selecionada, do mais recente
para o mais antigo. Cada linha mostra bruto recebido, taxas, líquido e o resultado
da conferência de dinheiro. **Ver resumo** abre os valores daquele dia por
participante e forma de pagamento, descontos, pendências, permutas/brindes,
conferência e observação guardadas. Para ver dias de uma feira anterior, selecione
essa feira no topo do aplicativo.

O aplicativo não completa os intervalos do calendário. Consultar uma data não
cria registros, e encerrar a feira fecha apenas a data inicial e as datas que têm
pedidos, recebimentos ou conferências salvas. Um fechamento inteiramente vazio
fica oculto por padrão; **Mostrar fechamentos vazios** permite consultá-lo sem
apagar o registro. Contagem explicitamente informada, inclusive zero, troco,
entrada, retirada, observação, pendência, permuta, brinde ou pedido cancelado
mantêm o dia visível. Não existe bloqueio de segunda a quinta: um registro real
nesses dias continua disponível, inclusive em feiras futuras.

**Produtos vendidos neste dia** mostra unidades, bruto recebido, taxas e líquido
por produto e participante, da maior quantidade para a menor. **Comparação dos
produtos** e **Comparação dos participantes** colocam os períodos escolhidos lado
a lado. Em **Escolher comparações**, marque os dias na lista de fechamentos e
escolha produtos, participantes ou ambos; unidades, bruto recebido, taxas,
líquido ou unidades junto do líquido; maior/menor quantidade ou líquido primeiro.
Os totais e a ordenação são recalculados somente com os dias marcados.

O agrupamento **Por semana** reúne as datas escolhidas de segunda a domingo,
sem criar dias intermediários. Para os fins de semana de outubro de 2026, permite
comparar 09–11, 16–18 e 23–25/10 conforme cada dia for fechado e selecionado.
O intervalo no cabeçalho vai do primeiro ao último dia escolhido do grupo; um dia
desmarcado dentro desse intervalo não entra na soma. As escolhas ficam no perfil
local, separadas por feira, inclusive ao trocar de seção ou reabrir. Não integram
o backup do banco. Selecionar todos mantém novos fechamentos incluídos; selecionar
datas específicas mantém esse conjunto até escolher outras datas.

**Escolher produtos e participantes** contém os filtros de linhas. Participantes
filtram as duas tabelas; produtos filtram somente a tabela de produtos. Esses
filtros não mudam o resumo individual do dia nem o **Resumo geral dos períodos
escolhidos**, que mostra unidades vendidas, pedidos pagos, bruto, taxas, líquido
e ticket médio de toda a feira nas datas escolhidas. Ticket médio é o bruto
recebido dividido pelos pedidos pagos, arredondado apenas para exibição. Sem
pedido pago, aparece **Sem venda paga**. Limpar todos os dias não recupera todos
implicitamente: a página informa que não há comparação selecionada.

As vendas pagas entram no dia do recebimento, como no fechamento. Pagamentos
divididos contam os itens uma única vez. Pedidos cancelados ou ainda pendentes,
permutas e brindes não contam como produtos vendidos; as duas últimas categorias
continuam separadas no resumo do dia. Produtos sem vendas pagas nos dias fechados
não aparecem nas tabelas. Um produto vendido em outros dias fechados permanece
comparável com zero quando não vendeu nas datas escolhidas. Zero não comprova
baixa procura: a página não informa disponibilidade ou falta de estoque no período.
São usados nome, participante e valores históricos
dos itens; mudar preço ou participante no cadastro não reatribui vendas antigas.
O bruto recebido já considera descontos; o líquido desconta taxas de pagamento.
Custos de produção não são registrados, portanto líquido não é lucro.

O resumo usa o registro guardado no fechamento. Uma taxa retificada depois do
fechamento aparece nos valores ajustados, com indicação do líquido original e
da diferença acrescentada; o registro original continua preservado. Pendências
mostram a situação no fechamento, mesmo quando recebidas posteriormente.

**Ver pedidos deste dia** abre o Histórico filtrado por pedidos ou recebimentos
naquela data. Essa consulta não altera a data de trabalho nem o dia de lançamento
de uma venda. **Usar data de trabalho** remove a consulta específica e salva a
preferência de mostrar somente esse dia. Abrir o Histórico pelo menu sem escolher
essa opção recupera seu filtro habitual e suas preferências salvas.

**Exportar dias desta feira** usa o CSV de fechamentos existente, limitado à feira
consultada. O arquivo inclui todos os dias registrados, inclusive dias ainda
abertos e fechamentos vazios; escolhas e filtros da comparação não limitam esse
CSV. A página Sumário mostra somente fechamentos guardados. A conferência
e as vendas continuam sendo feitas nas seções Fechamento e Vender.

## Meta e pagamentos desta feira

A meta considera somente o líquido da **Con Affetto**. No Fechamento e no
Histórico, bruto, taxas e líquido ficam separados por participante.
As opções comuns de cartão usam aproximação no celular; **inserido** identifica
a maquininha e sua taxa. Dinheiro e Pix não têm taxa nesta configuração.
As taxas e a retificação autorizada dos pedidos anteriores estão descritas em
[Pagamentos e retificações](14-pagamentos.md).

Para um atendimento pago de duas formas, marque **Dividir em duas formas de
pagamento**, escolha as formas e informe o valor da primeira. O aplicativo calcula
o restante da segunda e registra um único pedido. A regra de rateio está em
[Pagamentos](14-pagamentos.md).

Essa versão usa banco v7. O Flatpak anterior usa v5 e permanece com seu banco
separado. Para retornar ao código antigo, restaure o backup anterior à atualização
em outro arquivo; versões v5/v6 recusam um banco v7. Não copie o banco da Nightly
para a instalação antiga.
