import { join } from "path";

export interface DataPaths {
  dataDir: string;
  profilesDir: string;
  dbPath: string;
  tempChromeDir: string;
}

export function getDataPaths(env: Record<string, string | undefined> = process.env): DataPaths {
  const dataDir = env.BW_USE_DATA_DIR || join(import.meta.dir, "..", "data");
  const tempChromeDir = env.BW_USE_TEMP_CHROME_DIR || join(dataDir, "temp-chrome");

  return {
    dataDir,
    profilesDir: join(dataDir, "profiles"),
    dbPath: join(dataDir, "browsers.db"),
    tempChromeDir,
  };
}
