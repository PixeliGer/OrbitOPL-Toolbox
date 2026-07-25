import { ipcMain } from "electron";
import {
  AppSettings,
  getSettings,
  setSetting,
  directoryExists,
} from "../services/settings.service";
import { checkForUpdates } from "../services/update.service";

export function registerSettingsIpc(): void {
  ipcMain.handle("get-settings", async () => {
    return getSettings();
  });

  ipcMain.handle(
    "set-setting",
    async <K extends keyof AppSettings>(
      _event: unknown,
      key: K,
      value: AppSettings[K]
    ) => {
      return setSetting(key, value);
    }
  );

  ipcMain.handle("directory-exists", async (_event, dirPath: string) => {
    return directoryExists(dirPath);
  });

  ipcMain.handle("check-for-updates", async () => {
    return checkForUpdates();
  });
}
