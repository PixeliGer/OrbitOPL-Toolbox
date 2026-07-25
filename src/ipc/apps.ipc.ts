import { ipcMain } from "electron";
import { getApps, getPs1Launchers } from "../services/apps.service";

export function registerAppsIpc(): void {
  ipcMain.handle("get-apps", async (_event, oplRoot: string) => {
    return getApps(oplRoot);
  });

  ipcMain.handle("get-ps1-launchers", async (_event, oplRoot: string) => {
    return getPs1Launchers(oplRoot);
  });
}
