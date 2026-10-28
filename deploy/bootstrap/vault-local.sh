#!/usr/bin/env bash
# Local Vault for OrbStack, set up like loncha's production one: Vault + Vault Secrets Operator,
# KV-v2 secret/local/voxel-vault, a read policy and a Kubernetes-auth role bound to the chart's
# ServiceAccount. Then the chart (values.local.yaml, secrets.source=vso) gets its Secret from VSO.
# Secrets live only here (Vault); non-secret configuration is `env:` in values*.yaml.
#
#   ./deploy/bootstrap/vault-local.sh        (Telegram secret from the Keychain or TELEGRAM_CLIENT_SECRET)
#
# Vault runs in dev mode: in memory, unsealed, root token "root". Disposable and local only —
# after the vault-0 pod restarts the KV is empty: run this script again (it is idempotent).
set -euo pipefail

CONTEXT=${KUBE_CONTEXT:-orbstack}
APP_NS=${APP_NAMESPACE:-voxel-vault}
RELEASE=${RELEASE:-voxel-vault}
FULLNAME=${FULLNAME:-$RELEASE-voxel-vault}               # the chart's fullname
SERVICE_ACCOUNT=${SERVICE_ACCOUNT:-$FULLNAME}
ROLE=voxel-vault-local
MOUNT=${VAULT_MOUNT:-secret}                               # the shared KV-v2 mount, as loncha
KV_PATH=local/voxel-vault

# The Telegram secret: from the environment, or from the macOS Keychain (so it never has to be
# typed on a command line). Store it once with:
#   security add-generic-password -a "$USER" -s voxel-vault-telegram -w
TELEGRAM_CLIENT_SECRET=${TELEGRAM_CLIENT_SECRET:-$(security find-generic-password -a "$USER" -s voxel-vault-telegram -w 2>/dev/null || true)}
: "${TELEGRAM_CLIENT_SECRET:?no Telegram secret: set TELEGRAM_CLIENT_SECRET or store it in the Keychain (see above)}"

k() { kubectl --context "$CONTEXT" "$@"; }
vault() { k -n vault exec -i vault-0 -- env VAULT_TOKEN=root vault "$@"; }

echo "→ Vault (dev) and the Secrets Operator"
# Never install over someone else's Vault: an existing release that is not this dev setup may hold
# real data (file storage, its own unseal keys). Then do the setup by hand against that Vault.
if helm status vault --kube-context "$CONTEXT" -n vault >/dev/null 2>&1; then
  dev=$(helm get values vault --kube-context "$CONTEXT" -n vault -o json 2>/dev/null \
    | python3 -c 'import json,sys; v=json.load(sys.stdin) or {}; print(str(((v.get("server") or {}).get("dev") or {}).get("enabled", False)).lower())')
  if [ "$dev" != "true" ]; then
    echo "✗ A Vault release already exists in ns vault and it is not dev mode — not touching it." >&2
    echo "  Create the policy, the role $ROLE and $MOUNT/$KV_PATH on that Vault with an admin token instead." >&2
    exit 1
  fi
fi
helm repo add hashicorp https://helm.releases.hashicorp.com >/dev/null 2>&1 || true
helm repo update hashicorp >/dev/null
helm upgrade --install vault hashicorp/vault --kube-context "$CONTEXT" -n vault --create-namespace \
  --set server.dev.enabled=true --set server.dev.devRootToken=root --set injector.enabled=false --wait
helm upgrade --install vault-secrets-operator hashicorp/vault-secrets-operator --kube-context "$CONTEXT" \
  -n vault-secrets-operator-system --create-namespace --wait
k -n vault wait --for=condition=Ready pod/vault-0 --timeout=120s

echo "→ Kubernetes auth"
vault auth list -format=json | grep -q '"kubernetes/"' || vault auth enable kubernetes
vault write auth/kubernetes/config kubernetes_host="https://kubernetes.default.svc" >/dev/null

echo "→ KV-v2 mount $MOUNT/"
vault secrets list -format=json | grep -q "\"$MOUNT/\"" || vault secrets enable -path="$MOUNT" -version=2 kv   # dev mode has it already

echo "→ Read policy and role $ROLE (SA $APP_NS/$SERVICE_ACCOUNT)"
vault policy write "$ROLE" - <<POLICY
path "$MOUNT/data/$KV_PATH" { capabilities = ["read"] }
POLICY
vault write "auth/kubernetes/role/$ROLE" \
  bound_service_account_names="$SERVICE_ACCOUNT" bound_service_account_namespaces="$APP_NS" \
  policies="$ROLE" audience="" ttl=1h >/dev/null
# Bound to the SA and namespace, no audience pinning (as in loncha). `audience=""` is explicit on
# purpose: writing an existing role only updates the fields given, an old audience would stay.

echo "→ $MOUNT/$KV_PATH (every secret env of the chart)"
# Keep the database password across runs: dev Vault forgets it on restart, the Postgres volume does not.
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-$(k -n "$APP_NS" get secret voxel-vault-secrets -o jsonpath='{.data.POSTGRES_PASSWORD}' 2>/dev/null | base64 -d || true)}
# A database first created by the old chart keeps the password from its <fullname>-postgres Secret.
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-$(k -n "$APP_NS" get secret "$FULLNAME-postgres" -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || true)}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-$(openssl rand -hex 24)}
# Non-secret parts come from values.yaml `env:`; keep them in sync if you change them there.
DB_USER=${POSTGRES_USER:-voxel} DB_NAME=${POSTGRES_DB:-voxel_vault}
DATABASE_URL="postgres://$DB_USER:$POSTGRES_PASSWORD@$FULLNAME-postgres:5432/$DB_NAME?sslmode=disable"
# Locally Identity and Security share the one database; the peer token is the gateway's INTERNAL_TOKEN.
IDENTITY_DATABASE_URL=$DATABASE_URL SECURITY_DATABASE_URL=$DATABASE_URL
GATEWAY_INTERNAL_TOKEN=$(k -n "$APP_NS" get secret voxel-vault-gateway-secrets -o jsonpath='{.data.INTERNAL_TOKEN}' | base64 -d)
# JSON through stdin: no secret ever appears in a process list or shell history.
TELEGRAM_CLIENT_SECRET=$TELEGRAM_CLIENT_SECRET POSTGRES_PASSWORD=$POSTGRES_PASSWORD DATABASE_URL=$DATABASE_URL \
  IDENTITY_DATABASE_URL=$IDENTITY_DATABASE_URL SECURITY_DATABASE_URL=$SECURITY_DATABASE_URL GATEWAY_INTERNAL_TOKEN=$GATEWAY_INTERNAL_TOKEN \
  python3 -c 'import json, os; print(json.dumps({k: os.environ[k] for k in ("POSTGRES_PASSWORD", "DATABASE_URL", "IDENTITY_DATABASE_URL", "SECURITY_DATABASE_URL", "GATEWAY_INTERNAL_TOKEN")}))' \
  | vault kv put -mount="$MOUNT" "$KV_PATH" - >/dev/null

echo "✓ Vault ready. Now:"
echo "  helm upgrade --install $RELEASE ./deploy/helm/voxel-vault -f ./deploy/helm/voxel-vault/values.local.yaml \\"
echo "    --kube-context $CONTEXT --namespace $APP_NS --create-namespace"
echo "  kubectl --context $CONTEXT -n $APP_NS get vaultstaticsecret $FULLNAME; kubectl --context $CONTEXT -n $APP_NS get secret voxel-vault-secrets"
