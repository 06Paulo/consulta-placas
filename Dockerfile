FROM node:20-slim

# Instalar Chromium + Tesseract OCR + dependencias del sistema
RUN apt-get update && apt-get install -y \
    chromium \
    tesseract-ocr \
    tesseract-ocr-spa \
    tesseract-ocr-eng \
    fonts-liberation \
    fonts-dejavu \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Variables para Puppeteer — usar Chromium del sistema, no descargar uno propio
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

# Instalar dependencias Node primero (capa cacheada)
COPY package*.json ./
RUN npm install --omit=dev

# Copiar código fuente
COPY . .

# Crear carpeta pública para screenshots/documentos
RUN mkdir -p public

EXPOSE 8080
ENV PORT=8080

CMD ["node", "server.js"]
