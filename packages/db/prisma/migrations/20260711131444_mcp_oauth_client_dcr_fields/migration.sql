-- AlterTable
ALTER TABLE "McpOAuthClient" ADD COLUMN     "grantTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "responseTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "scope" TEXT,
ADD COLUMN     "tokenEndpointAuthMethod" TEXT NOT NULL DEFAULT 'none';
