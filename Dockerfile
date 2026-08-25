FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY data ./data
COPY web ./web
ENV DATA_DIR=/data NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.js"]
