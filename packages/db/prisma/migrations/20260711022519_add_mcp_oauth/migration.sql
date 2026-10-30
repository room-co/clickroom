-- CreateTable
CREATE TABLE "McpOAuthClient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT,
    "redirectUris" TEXT[],
    "clientSecretHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthRefreshToken" (
    "id" TEXT NOT NULL,
    "selector" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpOAuthRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthClient_clientId_key" ON "McpOAuthClient"("clientId");

-- CreateIndex
CREATE INDEX "McpOAuthClient_createdAt_idx" ON "McpOAuthClient"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthRefreshToken_selector_key" ON "McpOAuthRefreshToken"("selector");

-- CreateIndex
CREATE INDEX "McpOAuthRefreshToken_orgId_idx" ON "McpOAuthRefreshToken"("orgId");

-- CreateIndex
CREATE INDEX "McpOAuthRefreshToken_projectId_idx" ON "McpOAuthRefreshToken"("projectId");

-- CreateIndex
CREATE INDEX "McpOAuthRefreshToken_userId_idx" ON "McpOAuthRefreshToken"("userId");

-- CreateIndex
CREATE INDEX "McpOAuthRefreshToken_clientId_idx" ON "McpOAuthRefreshToken"("clientId");
