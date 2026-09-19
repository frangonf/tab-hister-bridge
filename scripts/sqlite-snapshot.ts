import { constants } from "node:fs";
import { copyFile, rm, stat } from "node:fs/promises";
import { backup, DatabaseSync } from "node:sqlite";

interface FileIdentity {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

async function fileIdentity(path: string): Promise<FileIdentity | null> {
  try {
    const value = await stat(path, { bigint: true });
    return {
      size: value.size,
      mtimeNs: value.mtimeNs,
      ctimeNs: value.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameFileIdentity(
  before: FileIdentity | null,
  after: FileIdentity | null,
): boolean {
  return (
    before?.size === after?.size &&
    before?.mtimeNs === after?.mtimeNs &&
    before?.ctimeNs === after?.ctimeNs
  );
}

async function copyStableWalSnapshot(
  sourcePath: string,
  snapshotPath: string,
): Promise<void> {
  const sourceWal = `${sourcePath}-wal`;
  const snapshotWal = `${snapshotPath}-wal`;

  for (let attempt = 0; attempt < 8; attempt++) {
    const databaseBefore = await fileIdentity(sourcePath);
    const walBefore = await fileIdentity(sourceWal);
    if (!databaseBefore)
      throw new Error(`SQLite database not found: ${sourcePath}`);

    await rm(snapshotPath, { force: true });
    await rm(snapshotWal, { force: true });
    await copyFile(sourcePath, snapshotPath, constants.COPYFILE_FICLONE);
    if (walBefore) {
      await copyFile(sourceWal, snapshotWal, constants.COPYFILE_FICLONE);
    }

    const [databaseAfter, walAfter] = await Promise.all([
      fileIdentity(sourcePath),
      fileIdentity(sourceWal),
    ]);
    if (
      sameFileIdentity(databaseBefore, databaseAfter) &&
      sameFileIdentity(walBefore, walAfter)
    ) {
      const snapshot = new DatabaseSync(snapshotPath);
      try {
        const check = snapshot.prepare("PRAGMA quick_check").get() as
          { quick_check?: string } | undefined;
        if (check?.quick_check !== "ok") {
          throw new Error("SQLite snapshot failed its integrity check");
        }
      } finally {
        snapshot.close();
      }
      return;
    }
  }

  throw new Error(
    "places.sqlite changed continuously while creating its snapshot",
  );
}

export async function backupSqliteDatabase(
  sourcePath: string,
  snapshotPath: string,
): Promise<void> {
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    await backup(source, snapshotPath);
    return;
  } catch {
    // Firefox keeps places.sqlite in exclusive locking mode. In that case the
    // SQLite backup API cannot acquire a read lock, so take a verified copy of
    // the database and its WAL instead.
  } finally {
    source?.close();
  }

  await copyStableWalSnapshot(sourcePath, snapshotPath);
}
