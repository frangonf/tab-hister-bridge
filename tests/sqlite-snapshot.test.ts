import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupSqliteDatabase } from "../scripts/sqlite-snapshot";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("backupSqliteDatabase", () => {
  it("includes committed rows that are still in the source WAL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tab-hister-sqlite-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.sqlite");
    const snapshotPath = join(directory, "snapshot.sqlite");
    const writer = new DatabaseSync(sourcePath);
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE items(value TEXT); INSERT INTO items VALUES ('current');",
    );

    await backupSqliteDatabase(sourcePath, snapshotPath);

    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM items").get()).toEqual({
      value: "current",
    });
    snapshot.close();
    writer.close();
  });
});
