-- CreateEnum
CREATE TYPE "SsoProtocol" AS ENUM ('saml', 'oidc');

-- CreateEnum
CREATE TYPE "SsoMappingTarget" AS ENUM ('org_role');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "authMethod" TEXT,
ADD COLUMN     "ssoConnectionId" TEXT;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "SsoConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "protocol" "SsoProtocol" NOT NULL,
    "displayName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "defaultOrgRole" "OrgRole" NOT NULL DEFAULT 'member',
    "attributeMapping" JSONB NOT NULL DEFAULT '{}',
    "secretsEnvelope" JSONB NOT NULL,
    "oidcIssuerUrl" TEXT,
    "oidcClientId" TEXT,
    "samlIdpEntityId" TEXT,
    "samlIdpSsoUrl" TEXT,
    "samlIdpX509Cert" TEXT,
    "samlSpEntityId" TEXT,
    "samlWantAssertionsSigned" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SsoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgDomain" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "verificationToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoGroupMapping" (
    "id" TEXT NOT NULL,
    "ssoConnectionId" TEXT NOT NULL,
    "idpGroup" TEXT NOT NULL,
    "target" "SsoMappingTarget" NOT NULL DEFAULT 'org_role',
    "orgRole" "OrgRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoGroupMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSsoIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ssoConnectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSsoIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SsoConnection_orgId_key" ON "SsoConnection"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgDomain_domain_key" ON "OrgDomain"("domain");

-- CreateIndex
CREATE INDEX "OrgDomain_orgId_idx" ON "OrgDomain"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "SsoGroupMapping_ssoConnectionId_idpGroup_key" ON "SsoGroupMapping"("ssoConnectionId", "idpGroup");

-- CreateIndex
CREATE INDEX "UserSsoIdentity_userId_idx" ON "UserSsoIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSsoIdentity_ssoConnectionId_externalId_key" ON "UserSsoIdentity"("ssoConnectionId", "externalId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_ssoConnectionId_fkey" FOREIGN KEY ("ssoConnectionId") REFERENCES "SsoConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgDomain" ADD CONSTRAINT "OrgDomain_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoGroupMapping" ADD CONSTRAINT "SsoGroupMapping_ssoConnectionId_fkey" FOREIGN KEY ("ssoConnectionId") REFERENCES "SsoConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSsoIdentity" ADD CONSTRAINT "UserSsoIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSsoIdentity" ADD CONSTRAINT "UserSsoIdentity_ssoConnectionId_fkey" FOREIGN KEY ("ssoConnectionId") REFERENCES "SsoConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
