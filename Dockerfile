FROM node:20-slim

WORKDIR /app

# Install server deps
COPY package.json package-lock.json* ./
RUN npm install --production

# Install client deps and build
COPY client/package.json client/package-lock.json* ./client/
RUN cd client && npm install
COPY client/ ./client/
RUN cd client && npm run build

# Copy server
COPY server/ ./server/

# Create uploads directory
RUN mkdir -p uploads

EXPOSE 4000
CMD ["node", "server/index.js"]
