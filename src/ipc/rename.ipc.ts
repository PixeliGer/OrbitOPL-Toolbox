import { ipcMain } from "electron";
import {
  renamePs1LauncherStep1,
  renamePs1LauncherStep2,
} from "../services/rename.service";

export function registerRenameIpc(): void {
  ipcMain.handle(
    "rename-ps1-launcher-step1",
    async (
      event,
      vcdPath: string,
      gameId: string,
      newTitle: string
    ) => {
      return renamePs1LauncherStep1(vcdPath, gameId, newTitle, (percent, stage) => {
        event.sender.send("rename-ps1-progress", { percent, stage });
      });
    }
  );

  ipcMain.handle(
    "rename-ps1-launcher-step2",
    async (
      event,
      params: {
        newAppsFolder: string;
        oldElfFile?: string;
        newElfFile?: string;
        newCfgContent?: string;
        newTitle: string;
      }
    ) => {
      return renamePs1LauncherStep2(params, (percent, stage) => {
        event.sender.send("rename-ps1-progress", { percent, stage });
      });
    }
  );
}
