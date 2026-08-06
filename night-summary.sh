#!/usr/bin/env python3
import json, os, subprocess
from datetime import datetime

env_file = "/home/pwrdbyadobo/docker/workers/shopify-worker/.env"
with open(env_file) as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("'\""))

sdir    = "/home/pwrdbyadobo/docker/workers/summaries"
webhook = os.environ["DISCORD_WEBHOOK_URL"]
date    = datetime.now().strftime("%b %d")
now     = datetime.now().strftime("%H:%M %Z")

def read(name, label):
    try:
        return open(f"{sdir}/{name}.txt").read().strip()
    except FileNotFoundError:
        if os.path.exists(f"{sdir}/{name}.started"):
            return f"⏳ {label:<12} still running..."
        return f"⚠️  {label:<12} no data — did not run"

lines = [
    f"\U0001f4cb Nightly Summary — {date}", "",
    read("neworders",     "Orders"),
    read("updates",       "Updates"),
    read("zendesk",       "Zendesk"),
    read("return-intent", "Return"),
    "",
    f"Host: {os.uname().nodename} · {now}",
]

content = "\n".join(lines)
payload = json.dumps({"content": content})
subprocess.run(
    ["curl", "-sS", "-H", "Content-Type: application/json", "-d", payload, webhook],
    check=True,
)
print("Sent:", content)
