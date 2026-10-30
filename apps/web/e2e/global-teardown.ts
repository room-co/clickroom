import { prisma } from './helpers/db'

/** Release the shared Prisma connection opened by helpers/db.ts's fixtures. */
export default async function globalTeardown(): Promise<void> {
  await prisma.$disconnect()
}
