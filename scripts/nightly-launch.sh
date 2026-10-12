#!/bin/bash
# O atalho executa os fontes locais; o Flatpak continua independente.
set -euo pipefail
root=${1:?Informe a raiz do projeto}
database=${2:?Informe o banco da Nightly}
node_runtime=${3:-}
state="${XDG_STATE_HOME:-$HOME/.local/state}/caixa-da-feira-nightly"
mkdir -p "$state"
exec 9>"$state/launch.lock"

message() {
  zenity "--$1" --title='Caixa da Feira — Nightly' --text="$2" 2>/dev/null || true
}

if ! flock --nonblock 9; then
  message info 'A Nightly já está aberta ou sendo preparada. Feche a janela para aplicar novas alterações.'
  exit 0
fi

exec >>"$state/nightly.log" 2>&1
trap 'message error "Não foi possível abrir a Nightly. Diagnóstico: $state/nightly.log"' ERR
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
if [[ -n "$node_runtime" ]]; then
  export PATH="$(dirname -- "$node_runtime"):$PATH"
fi
export CAIXA_DB="$database"
export CAIXA_NIGHTLY=1
export CAIXA_DESKTOP_RESOURCES="$root/apps/desktop/src-tauri/resources"
export XDG_DATA_HOME="$state/profile/data"
export XDG_CACHE_HOME="$state/profile/cache"
export XDG_CONFIG_HOME="$state/profile/config"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

# Não cria um caixa vazio se o caminho configurado estiver errado.
if [[ ! -f "$database" ]]; then
  message error "O banco da Nightly não existe: $database"
  exit 1
fi
cd "$root"

require_closed_app() {
  local answer
  answer=$(gdbus call --session --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner \
    br.com.caixadafeira.local.SingleInstance)
  if [[ "$answer" == '(true,)' ]]; then
    message info 'Feche a outra janela do Caixa da Feira antes de abrir a Nightly. Cada versão usa seu próprio banco.'
    exit 0
  fi
}

require_closed_app
native_fingerprint() {
  {
    find apps/desktop/src-tauri -type d \( -name target -o -name resources \) -prune \
      -o -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
    rustc --version
  } | sha256sum | cut -d ' ' -f 1
}
native_key=$(native_fingerprint)
node scripts/nightly-prepare.mjs
executable="$root/apps/desktop/src-tauri/target/release/caixa-da-feira-desktop"
stamp="$state/native-sources.sha256"
if [[ ! -x "$executable" || ! -f "$stamp" || "$(cat "$stamp")" != "$native_key" ]]; then
  cargo build --release --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml
  if [[ "$(native_fingerprint)" != "$native_key" ]]; then
    message error 'Os fontes Rust mudaram durante a compilação. Abra novamente a Nightly para aplicar a versão atual.'
    exit 1
  fi
  printf '%s\n' "$native_key" >"$stamp.tmp"
  mv "$stamp.tmp" "$stamp"
fi
require_closed_app
# A trava permanece no processo desktop até o encerramento real da janela.
exec "$executable"
