import { PrismaClient, type Prisma } from "@prisma/client";
import { isDev } from "./env";
import { logger } from "./logger";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const log: Array<Prisma.LogLevel | Prisma.LogDefinition> = isDev
  ? [{ emit: "event", level: "query" }, "warn", "error"]
  : ["error"];

const created = new PrismaClient({ log });

if (isDev) {
  created.$on("query", (event) => {
    if (event.duration > 200) {
      logger.warn({ durationMs: event.duration, query: event.query }, "slow prisma query");
    }
  });
}

export const prisma = globalForPrisma.prisma ?? created;

if (isDev) {
  // Hot reload in tsx would otherwise open a new pool on every save.
  globalForPrisma.prisma = prisma;
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
