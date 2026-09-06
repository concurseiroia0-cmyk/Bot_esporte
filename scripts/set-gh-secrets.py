"""Configura secrets do GitHub Actions via API (roda uma vez, local)."""
import base64
import json
import sys
import urllib.request

from nacl import encoding, public

TOKEN = sys.argv[1]
REPO = "concurseiroia0-cmyk/Bot_esporte"
SECRETS = {
    "API_FOOTBALL_KEY": sys.argv[2],
    "API_FOOTBALL_KEY_2": sys.argv[3],
}

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Accept": "application/vnd.github+json",
}


def gh(url, data=None, method="GET"):
    req = urllib.request.Request(url, data=data, method=method, headers=HEADERS)
    return urllib.request.urlopen(req)


# 1. Chave pública do repo
pub = json.load(gh(f"https://api.github.com/repos/{REPO}/actions/secrets/public-key"))
pk = public.PublicKey(pub["key"].encode(), encoding.Base64Encoder())
sealed = public.SealedBox(pk)

# 2. Criar/atualizar cada secret
for name, value in SECRETS.items():
    enc = sealed.encrypt(value.encode())
    body = json.dumps({
        "encrypted_value": base64.b64encode(enc).decode(),
        "key_id": pub["key_id"],
    }).encode()
    resp = gh(f"https://api.github.com/repos/{REPO}/actions/secrets/{name}", body, "PUT")
    print(f"{name}: HTTP {resp.status}")

print("Secrets configurados!")
