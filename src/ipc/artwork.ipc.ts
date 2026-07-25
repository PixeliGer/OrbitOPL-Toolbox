import { ipcMain } from "electron";
import { downloadArtByGameId, checkArtFilesExist } from "../services/artwork.service";

export function registerArtworkIpc(): void {
  ipcMain.handle(
    "download-art-by-gameid",
    async (_event, dirPath: string, gameId: string, system?: "PS1" | "PS2", saveAsName?: string) => {
      return downloadArtByGameId(dirPath, gameId, system || "PS2", saveAsName);
    }
  );

  ipcMain.handle("check-art-files-exist", async (_event, artDir: string, filenames: string[]) => {
    return checkArtFilesExist(artDir, filenames);
  });
}
