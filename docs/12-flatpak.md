# Flatpak privado no Linux

O pacote foi preparado para Linux x86_64, para uso no PC EndeavourOS e no
notebook Zorin OS 18.1. Mantém a janela Tauri, a API Node e o SQLite. Usa o runtime GNOME 49;
o Node 24 vem do SDK, e o módulo nativo do SQLite é compilado nele contra
esse Node. O addon está fixado em `better-sqlite3 13.0.3`, que usa Node-API;
os prebuilds são excluídos para usar o binário compilado no SDK. Ambos
acompanham o aplicativo. Não é necessário instalar Node, npm, Rust ou SDKs
na máquina que apenas vai usar o pacote.

O Flatpak não contém o banco do comércio, os JSONs extraídos, a planilha ou
o histórico Git. O aplicativo e os dados são transferidos separadamente.
Não há publicação no Flathub nem sincronização entre computadores.

## Instalar o pacote pronto

Copie o arquivo `.flatpak` e seu `.sha256` de `dist/flatpak/`. No diretório
que recebeu os dois arquivos:

```bash
sha256sum -c caixa-da-feira-0.1.0-x86_64.flatpak.sha256
flatpak install --user ./caixa-da-feira-0.1.0-x86_64.flatpak
```

A primeira instalação pode precisar de internet para obter o runtime GNOME
49. O arquivo `.flatpak` contém o aplicativo, mas não o runtime. Depois da
instalação completa, a operação é offline. Para distribuição sem internet,
incluindo dependências, o Flatpak oferece `flatpak create-usb`.

Abra **Caixa da Feira** pelo menu ou execute:

```bash
flatpak run br.com.caixadafeira.local
```

Sem restaurar um backup, a primeira abertura cria um banco vazio. O banco
padrão desta versão fica em:

```text
~/.var/app/br.com.caixadafeira.local/data/br.com.caixadafeira.local/caixa.sqlite
```

Atualizar o aplicativo preserva essa pasta. Não use `flatpak uninstall
--delete-data` se quiser conservar os dados e carrinhos locais.

## Trazer o banco da transferência

Com o aplicativo fechado, antes de sua primeira abertura, execute na raiz do
projeto que contém `data/caixa.sqlite`:

```bash
flatpak run --filesystem="$PWD/data:ro" \
  --command=caixa-restaurar-backup br.com.caixadafeira.local \
  "$PWD/data/caixa.sqlite"
```

O acesso à pasta de origem é somente leitura e vale apenas para essa chamada.
O restaurador usa o Node/SQLite empacotado, verifica integridade, esquema e
referências, migra somente uma cópia e recusa um destino já existente ou com
auxiliares SQLite, inclusive links simbólicos quebrados. O arquivo completo é
publicado de forma atômica, sem sobrescrever um destino criado durante a cópia.
O banco da transferência permanece intacto.

Para um backup baixado pela interface, conceda acesso somente à pasta que
contém o arquivo e passe seu caminho absoluto. Se o destino padrão já existe,
restaure em um arquivo novo dentro da pasta privada; não apague o banco em uso
para contornar a recusa. O restaurador aceita esse destino no segundo argumento.
Para tornar a nova cópia o banco das próximas aberturas pelo menu, com o caixa
fechado, use seu caminho absoluto no override da conta:

```bash
flatpak override --user --env=CAIXA_DB="/caminho/absoluto/na/pasta/privada/novo.sqlite" br.com.caixadafeira.local
```

Esse comando escolhe o banco; não concede acesso a outras pastas. Confira o
caminho e conserve a cópia anterior para recuperação.

Uma interrupção abrupta pode deixar uma pasta `.caixa-restauracao-*` junto ao
destino. Ela contém o staging, não bloqueia uma nova tentativa e deve ser
removida manualmente apenas depois de confirmar que não há restauração em
andamento. Se ocorrer falha de sincronização do diretório depois da publicação,
o comando retorna erro, mas conserva o arquivo final completo. Nesse caso,
verifique esse arquivo antes de repetir; a recusa de sobrescrita permanece.

Ao alternar de computador, faça um backup pela interface, feche o caixa e
restaure a cópia no destino. Mantenha uma única cópia em uso por vez: o pacote
não une vendas lançadas independentemente nos dois computadores. Carrinhos
ainda não registrados ficam no WebKit local e não fazem parte do backup SQLite.

## Construir novamente

Na máquina de desenvolvimento, configure o Flathub na conta e instale as
ferramentas. Estes downloads são de compilação, não requisitos do notebook:

```bash
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub org.flatpak.Builder org.gnome.Sdk//49 \
  org.freedesktop.Sdk.Extension.node24//25.08 \
  org.freedesktop.Sdk.Extension.rust-stable//25.08
node scripts/flatpak-build.mjs
```

Também existe `npm run flatpak:build`. O Node do host apenas seleciona os
fontes e chama o Flatpak; a compilação usa o Node 24 e o Rust do SDK. O script
aceita `flatpak-builder` nativo quando disponível e, caso contrário, usa
`org.flatpak.Builder`. As dependências JavaScript e Rust seguem os lockfiles;
a compilação privada acessa a internet para baixá-las. As branches dos SDKs
recebem atualizações, portanto o procedimento não promete identidade binária
entre builds feitos com revisões diferentes do SDK.

No Zorin, o builder nativo também precisa de `elfutils` no host para finalizar
os binários (`eu-strip`). Instale-o com `pkexec apt-get install elfutils`.

O resultado fica em `dist/flatpak/caixa-da-feira-0.1.0-x86_64.flatpak`, com
checksum ao lado. Fontes, caches, build e repositório OSTree também ficam em
`dist/flatpak/`, ignorado pelo Git. O build executa testes de regras/API,
restauração, empacotamento e Rust em bancos temporários. As comparações com
JSONs reais são puladas porque os dados privados não entram no build.

## Isolamento e validação

O aplicativo não recebe acesso geral à home nem à rede externa. O backend e
o WebKit comunicam-se por `127.0.0.1` na rede privada do Flatpak; sua API não
fica exposta no host. A compilação tem rede para obter dependências. A janela
recebe acesso gráfico Wayland/X11 e GPU; exportações usam o portal de arquivos.

Os testes de lógica e backend não provam o funcionamento da janela ou do
diálogo gráfico de arquivos. Na máquina de destino, confira abertura, registro de pedido em banco
de teste, reabertura, exportação CSV/backup para uma pasta escolhida e
encerramento. Não faça lançamentos fictícios no banco de operação. Use apenas
uma variante do caixa por vez: o desktop nativo e o Flatpak mantêm o mesmo ID
do aplicativo e a proteção de instância única.

Com o pacote instalado, o teste de backend empacotado pode ser repetido sem
abrir janela e sem escrever no banco de uso:

```bash
node scripts/flatpak-runtime-smoke.mjs
```

Ele usa uma pasta temporária dentro da sandbox e verifica o módulo SQLite
nativo realmente carregado, 10 mil ciclos de coleta de wrappers SQLite,
a rede privada IPv4/IPv6, o frontend servido, pedido/reenvio/estoque,
CSV, backup/restauração, preservação do arquivo completo diante de falha após
publicação e o término real do servidor após SIGTERM. Não concede rede ou
filesystem extra.

Na validação de 11/10/2026, o build passou em 78 testes de regras/API, quatro
de empacotamento e cinco de Rust; duas comparações com dados privados foram
puladas. O diagnóstico acima passou no pacote instalado no PC, com Node
24.21.0 e SQLite nativo 13.0.3. Um teste sem janela do portal de documentos
também confirmou criação e substituição de arquivo, conteúdo completo no
host e recusa de escrita sem permissão. A janela Tauri e o diálogo gráfico de
arquivos no Flatpak ainda precisam de conferência manual.

No Zorin OS 18.1, em 11/10/2026, o pacote foi compilado, instalado e passou
no mesmo diagnóstico de runtime. A restauração preservou todas as tabelas,
registros e snapshots da cópia inicial. A janela local Nightly foi aberta,
reaberta com cache e usada no atendimento; sua verificação de abertura duplicada
preservou os recursos da instância ativa. O ensaio gráfico do Flatpak foi
interrompido pela instância Nightly em uso, antes de qualquer pedido de teste.
Os bancos continuam independentes. Consulte [Nightly local](13-nightly.md).

Referências: [conceitos do Flatpak](https://docs.flatpak.org/en/latest/basic-concepts.html),
[pacotes de arquivo único](https://docs.flatpak.org/en/latest/single-file-bundles.html),
[portais](https://docs.flatpak.org/en/latest/portals.html) e
[Tauri no Flatpak](https://v2.tauri.app/distribute/flatpak/).
