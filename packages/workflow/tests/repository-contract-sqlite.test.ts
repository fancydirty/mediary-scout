import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createSqliteWorkflowRepository, SqliteWorkflowRepository } from "../src/sqlite.js";
import { runRepositoryContract } from "./repository-contract.js";

runRepositoryContract("SQLite", {
  make: () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-sqlite-"));
    return createSqliteWorkflowRepository({ path: join(dir, "test.db") });
  },
  teardown: (repo) => {
    (repo as SqliteWorkflowRepository).close();
  },
});
