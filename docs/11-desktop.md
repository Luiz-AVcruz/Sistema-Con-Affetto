# Aplicativo desktop local

O caixa usa Tauri para abrir uma janela própria no Linux. Angular continua responsável pelas telas; Node e SQLite continuam responsáveis pelas regras e dados. O runtime Node, a API compilada e a interface são recursos do aplicativo instalado, sem precisar iniciar um terminal ou abrir navegador para atender.

## Operação

Abra **Caixa da Feira** pelo menu de aplicativos. A janela inicia maximizada para manter os produtos e o pedido lado a lado no notebook. Uma segunda abertura traz a janela existente para frente, sem iniciar outro backend. Ao fechar a última janela, o programa conclui as exportações já aceitas, solicita o encerramento do processo Node e aguarda sua conclusão, fechando o SQLite. Se o processo principal for interrompido abruptamente, o kernel sinaliza o Node filho para que ele também encerre.

A versão instalada neste notebook usa o banco do projeto em `~/Projetos/caixa-da-feira/data/caixa.sqlite`. Instalar ou recompilar o aplicativo não substitui esse banco. O atalho define `CAIXA_DB`; para testar outro banco, use um caminho separado.

O backend atende somente `127.0.0.1`. A porta normal do desktop é `3335`, mantendo a origem do armazenamento de carrinhos entre aberturas. A janela só abre depois da confirmação de escuta do processo que o aplicativo iniciou. Se a porta estiver ocupada por outro serviço, o programa informa a falha; não adota esse serviço nem muda de porta silenciosamente.

As exportações abrem um diálogo para escolher onde salvar. O CSV contém os dados para consulta; o backup SQLite contém todas as feiras e o estoque para recuperação. O programa bloqueia destinos que apontem para o banco ativo e seus arquivos auxiliares. Cada gravação usa um temporário próprio e só substitui o destino após terminar. Para restaurar em uma cópia, siga [Dados e recuperação](../README.md#dados-e-recuperação).

## Compilação e instalação local

Os pré-requisitos Linux de compilação são `build-essential`, `pkg-config`, `libwebkit2gtk-4.1-dev`, `libssl-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev` e `libxdo-dev`, além de Rust/Cargo, Node e npm. Quando for necessário instalar pacotes administrativos neste notebook, usar **pkexec** para autenticação gráfica.

Com as dependências prontas, na raiz do projeto:

```bash
npm ci
PATH="$HOME/.cargo/bin:$PATH" CARGO_BUILD_JOBS=2 npm run desktop:build
CAIXA_DB="$PWD/data/caixa.sqlite" npm run desktop:install
```

Os arquivos de compilação e recursos gerados não são versionados. O `Cargo.lock` e o `package-lock.json` fixam as dependências. O executável instalado, os recursos e o atalho ficam na área local da conta do Linux, sem exigir instalação administrativa do aplicativo.

O preparo dos recursos agrupa a API e suas dependências JavaScript, mantendo o módulo nativo do SQLite. Copia também o executável Node e o Angular compilado. A versão Node copiada precisa corresponder à ABI do `better-sqlite3`; trocar o runtime sem reconstruir/verificar o módulo nativo pode impedir a abertura do banco.

O modo web de manutenção continua disponível com `npm start` na porta 3333. Ele não deve permanecer em uso enquanto uma migração ou restauração troca o esquema/banco. `CAIXA_FRONTEND` permite apontar o servidor para a interface empacotada; `CAIXA_DESKTOP=1` habilita a confirmação de prontidão `CAIXA_READY`; `PORT=0` escolhe uma porta automática para testes isolados, enquanto o desktop usa uma porta estável.

## Verificação

Testes de API, estoque e migração usam bancos temporários. O teste de navegador verifica as telas, mas não prova por si só o comportamento do Tauri. Nunca cadastrar vendas de teste no banco de uso.

O teste de backend empacotado verifica o listener pertencente ao processo iniciado, conflito de porta e encerramento por SIGTERM:

```bash
npm run smoke:backend -w @caixa/desktop
PATH="$HOME/.cargo/bin:$PATH" cargo test --release --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Para verificar a janela real pelo protocolo WebDriver, use `webkit2gtk-driver` do sistema e `tauri-driver` (`cargo install tauri-driver --locked`). Para os diálogos GTK, o teste usa Python 3, PyGObject e a interface Atspi do sistema (`python3-gi` e `gir1.2-atspi-2.0`). Esses utilitários são apenas do teste; o aplicativo instalado não precisa de Python.

O roteiro [desktop-ui-smoke.mjs](../scripts/desktop-ui-smoke.mjs) abre o executável compilado com banco e armazenamento WebKit separados; exige as portas de teste 3336, 4448 e 4449 livres. Verifica renderização, segunda instância, carrinho após reabrir, registro de pedido/estoque, exportações CSV/SQLite pelo diálogo real, integridade do backup e encerramento normal ou abrupto. A imagem da janela fica em `test-results/desktop/tauri-webkit.png`, fora do Git.

```bash
node scripts/desktop-ui-smoke.mjs
```

Para conferir a cópia instalada, com o caixa de uso fechado:

```bash
CAIXA_TEST_DESKTOP_BINARY="$HOME/.local/share/caixa-da-feira/caixa-da-feira" node scripts/desktop-ui-smoke.mjs
```

Use o executável diretamente nesse teste. O script `launch` do atalho define o banco de uso e não deve ser usado como executável do teste.

Em 10/10/2026, a compilação release, os cinco testes Rust e o roteiro WebKit passaram neste notebook, inclusive na cópia instalada. As regras/API passaram em 47 testes com SQLite real; a importação e a restauração também foram conferidas em cópias. A planilha continua independente: os lançamentos do aplicativo não atualizam o ODS, e a importação inicial não é uma sincronização contínua.
