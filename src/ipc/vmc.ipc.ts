import { ipcMain } from "electron";
import {
  listVmc,
  checkPopsVmc,
  createVmc,
  deleteVmc,
} from "../services/vmc.service";

export function registerVmcIpc(): void {
  ipcMain.handle("list-vmc", async (_event, oplRoot: string) => {
    return listVmc(oplRoot);
  });

  ipcMain.handle(
    "check-pops-vmc",
    async (_event, oplRoot: string, gameTitle: string) => {
      return checkPopsVmc(oplRoot, gameTitle);
    }
  );

  ipcMain.handle(
    "create-vmc",
    async (_event, oplRoot: string, name: string, sizeMb: number) => {
      return createVmc(oplRoot, name, sizeMb);
    }
  );

  ipcMain.handle("delete-vmc", async (_event, oplRoot: string, name: string) => {
    return deleteVmc(oplRoot, name);
  });
}
