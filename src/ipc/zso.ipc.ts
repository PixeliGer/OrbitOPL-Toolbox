import { ipcMain } from "electron";
import { compressIsoToZso } from "../services/zso.service";

export function registerZsoIpc(): void {
  ipcMain.handle(
    "compress-iso-to-zso",
    async (
      event,
      isoPath: string,
      zsoPath: string,
      deleteOriginal: boolean
    ) => {
      return compressIsoToZso(isoPath, zsoPath, deleteOriginal, (percent, stage) => {
        event.sender.send("zso-compress-progress", { percent, stage });
      });
    }
  );
}
