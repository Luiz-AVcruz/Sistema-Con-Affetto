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
