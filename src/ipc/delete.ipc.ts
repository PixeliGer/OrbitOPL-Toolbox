import { ipcMain } from "electron";
import { deleteGameAndRelatedFiles } from "../services/delete.service";
import {
  deleteApp,
  deleteAppWithProgress,
} from "../services/apps.service";

export function registerDeleteIpc(): void {
  ipcMain.handle(
    "delete-game-and-related-files",
    async (
      event,
      gamePath: string,
      artDir: string,
      gameId: string,
      launcherFolder?: string,
      bootName?: string
    ) => {
      return deleteGameAndRelatedFiles(gamePath, artDir, gameId, launcherFolder, (entry) => {
        event.sender.send("delete-ps1-progress", entry);
      }, bootName);
    }
  );

  ipcMain.handle(
    "delete-app",
    async (_event, oplRoot: string, folder: string) => {
      return deleteApp(oplRoot, folder);
    }
  );

  ipcMain.handle(
    "delete-app-with-progress",
    async (event, oplRoot: string, folder: string, bootName: string) => {
      return deleteAppWithProgress(oplRoot, folder, bootName, (entry) => {
        event.sender.send("delete-app-progress", entry);
      });
    }
  );
}
