FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY pm2.json ./
COPY models/ ./models/

CMD ["sh", "-c", "npm run build && (npx tsc --watch &) && npx pm2-runtime pm2.json"]
