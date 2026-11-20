FROM node:22-alpine
# Set to 1 to include LibreOffice so teachers can upload PowerPoint files (adds ~500 MB). PDF works without it.
ARG WITH_OFFICE=0
RUN if [ "$WITH_OFFICE" = "1" ]; then apk add --no-cache libreoffice font-noto-arabic ttf-dejavu; fi
WORKDIR /app
COPY package.json ./
COPY lib ./lib
COPY public ./public
COPY server.js ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
