FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY fullshippingbackfill.py fullordersrebuild.py neworders.py updates.py run.sh discord.sh ./
RUN chmod +x /app/run.sh /app/discord.sh

ENTRYPOINT ["/app/run.sh"]
