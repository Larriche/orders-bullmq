FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY models/ ./models/
COPY src/ ./src/

RUN npm run build

CMD ["node", "dist/src/run/default-worker.js"]
