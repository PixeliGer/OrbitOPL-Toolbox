import { ipcMain } from "electron";
import * as fs from "fs/promises";
import { convertVcdToBin } from "../utils/cue2pops";
import { createLogger } from "../logger";

const log = createLogger("vcd-ipc");

export function registerVcdIpc(): void {
  ipcMain.handle(
    "convert-vcd-to-bin",
    async (
      event,
      vcdPath: string,
      binPath: string,
      cuePath: string,
      deleteOriginal: boolean
    ) => {
      try {
        const result = await convertVcdToBin(
          vcdPath,
          binPath,
          cuePath,
          (percent, stage) => {
            event.sender.send("vcd-to-bin-progress", { percent, stage });
          }
        );

        if (deleteOriginal) {
          await fs.unlink(vcdPath);
          log.verbose(
            `Deleted source VCD after successful conversion: ${vcdPath}`
          );
        }

        return { success: true, binPath, cuePath, ...result };
      } catch (err: any) {
        log.error(`VCD→BIN/CUE conversion failed for ${vcdPath}:`, err?.message || err);
        return { success: false, message: err?.message || String(err) };
      }
    }
  );
}
