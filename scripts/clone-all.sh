#!/usr/bin/env bash
# Clona los repos de Planazo como hermanos de este directorio (../planazo-<servicio>).
# Usa `gh repo clone` si está instalado y autenticado; si no, `git clone` por HTTPS.
# Los que ya existen se saltan.
set -euo pipefail

ORG="planazo-team"
REPOS=(planazo-frontend planazo-api-gateway planazo-booking planazo-promo planazo-game planazo-realtime)

# Directorio padre de planazo-infra, independientemente de desde dónde se invoque.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARENT="$(cd "$HERE/.." && pwd)"

use_gh=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  use_gh=1
fi

for repo in "${REPOS[@]}"; do
  dest="$PARENT/$repo"
  if [ -d "$dest/.git" ]; then
    echo "· $repo ya existe en $dest, se salta"
    continue
  fi
  echo "→ clonando $ORG/$repo en $dest"
  if [ "$use_gh" = 1 ]; then
    gh repo clone "$ORG/$repo" "$dest"
  else
    git clone "https://github.com/$ORG/$repo.git" "$dest"
  fi
done

echo
echo "Listo. Estructura esperada en $PARENT:"
for repo in planazo-infra "${REPOS[@]}"; do
  if [ -d "$PARENT/$repo" ]; then echo "  ✔ $repo"; else echo "  ✘ $repo (falta)"; fi
done
