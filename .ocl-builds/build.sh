#!/usr/bin/env bash
# Сборка локального форка opencode в .ocl-builds/{prod,dev}/opencode.
#
# Отличие prod от dev — только канал (OPENCODE_CHANNEL), зашиваемый в бинарь
# на этапе компиляции. Имя файла БД выбирается по каналу автоматически:
#   latest/prod → ~/.local/share/opencode/opencode.db
#   dev         → ~/.local/share/opencode/opencode-dev.db
#
# Использование: ocl-build [prod|dev|all]   (по умолчанию all)

set -euo pipefail

REPO="/home/vsixer/Projects/opencode"
OUT="$REPO/.ocl-builds"
PKG="$REPO/packages/opencode"

usage() {
  cat <<EOF
Usage: ocl-build [prod|dev|all]
  prod  — release-сборка (канал latest,   opencode.db)
  dev   — dev-сборка     (канал dev,      opencode-dev.db)
  all   — обе версии (по умолчанию)
EOF
}

# Версию фиксируем явно из packages/opencode/package.json, иначе для канала
# latest сборщик лезет в npm-registry и бампит версию, а для preview каналов
# ставит 0.0.0-<channel>-<ts> — и то и другое бесполезно для локального форка.
pkg_version() {
  node -p "require('$PKG/package.json').version" 2>/dev/null \
    || bun -e "console.log((await Bun.file('$PKG/package.json').json()).version)"
}

# Сборка одной платформой (--single) создаёт dist/opencode-{os}-{arch}/bin/opencode.
find_binary() {
  local found
  found=$(ls "$PKG"/dist/opencode-*/bin/opencode 2>/dev/null | head -n1 || true)
  if [[ -z "$found" ]]; then
    echo "ERROR: собранный бинарь не найден в $PKG/dist" >&2
    exit 1
  fi
  echo "$found"
}

build_channel() {
  local channel="$1" dest="$2" version
  version="$(pkg_version)"
  echo "==> Сборка канала '$channel' (версия $version) → $dest"
  rm -rf "$PKG/dist"
  (cd "$PKG" && OPENCODE_CHANNEL="$channel" OPENCODE_VERSION="$version" bun run script/build.ts --single)
  local bin
  bin="$(find_binary)"
  mkdir -p "$dest"
  cp -f "$bin" "$dest/opencode"
  chmod +x "$dest/opencode"
  echo "    готово: $dest/opencode ($(du -h "$dest/opencode" | cut -f1))"
}

main() {
  case "${1:-all}" in
    prod) build_channel latest "$OUT/prod" ;;
    dev)  build_channel dev    "$OUT/dev"  ;;
    all)
      build_channel latest "$OUT/prod"
      build_channel dev    "$OUT/dev"
      ;;
    -h|--help|help) usage ;;
    *) echo "Неизвестный аргумент: $1" >&2; usage; exit 1 ;;
  esac
}

main "$@"
