import { ipcMain } from "electron";
import { compressIsoToZso, decompressZsoToIso } from "../services/zso.service";

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

  ipcMain.handle(
    "decompress-zso-to-iso",
    async (
      event,
      zsoPath: string,
      isoPath: string,
      deleteOriginal: boolean
    ) => {
      return decompressZsoToIso(zsoPath, isoPath, deleteOriginal, (percent, stage) => {
        event.sender.send("zso-decompress-progress", { percent, stage });
      });
    }
  );
}
