FROM docker.io/smallstep/step-cli:latest AS step-cli

FROM docker.io/node:22-bookworm-slim

WORKDIR /app

COPY --from=step-cli /usr/local/bin/step /usr/local/bin/step
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV ADMIN_APP_HOST=127.0.0.1
ENV ADMIN_APP_PORT=8080

EXPOSE 8080
CMD ["npm", "start"]
