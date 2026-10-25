FROM node:22-alpine

WORKDIR /app

# Copy dependency definition
COPY package*.json ./

# Copy all application files
COPY . .

# Set default port
ENV PORT=3000
EXPOSE 3000

# Start server & keep-alive monitor
CMD ["npm", "start"]
