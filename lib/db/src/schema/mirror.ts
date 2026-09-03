import { jsonb, integer, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const mirrorJobsTable = pgTable(
  "mirror_jobs",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    status: text("status").notNull(),
    config: jsonb("config").notNull(),
    progress: jsonb("progress").notNull(),
    archiveKey: text("archive_key"),
    archiveBytes: integer("archive_bytes"),
    outputExpiresAt: timestamp("output_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("mirror_jobs_status_created_at_idx").on(table.status, table.createdAt),
    index("mirror_jobs_output_expires_at_idx").on(table.outputExpiresAt),
  ],
);

export const mirrorWorkItemsTable = pgTable(
  "mirror_work_items",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => mirrorJobsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    url: text("url").notNull(),
    depth: integer("depth").notNull().default(0),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    outcome: jsonb("outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("mirror_work_items_job_kind_url_idx").on(table.jobId, table.kind, table.url),
    index("mirror_work_items_claim_idx").on(table.status, table.leaseExpiresAt, table.createdAt),
    index("mirror_work_items_job_status_idx").on(table.jobId, table.status),
  ],
);

export type MirrorJobRow = typeof mirrorJobsTable.$inferSelect;
export type MirrorWorkItemRow = typeof mirrorWorkItemsTable.$inferSelect;