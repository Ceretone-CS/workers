FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
RUN pip install --no-cache-dir google-auth google-auth-httplib2 google-api-python-client
COPY exporter.py .
CMD ["python", "exporter.py"]
