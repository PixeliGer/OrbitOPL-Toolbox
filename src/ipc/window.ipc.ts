import { ipcMain, BrowserWindow } from "electron";

const TILING_WMS = [
  "i3",
  "sway",
  "hyprland",
  "bspwm",
  "awesome",
  "xmonad",
  "dwm",
  "herbstluftwm",
  "qtile",
  "river",
  "labwc",
  "niri",
];

function detectWindowControls(): { canMinimize: boolean; canMaximize: boolean } {
  if (process.platform !== "linux") {
    return { canMinimize: true, canMaximize: true };
  }

  const envVars = [
    process.env.XDG_CURRENT_DESKTOP ?? "",
    process.env.DESKTOP_SESSION ?? "",
    process.env.XDG_SESSION_DESKTOP ?? "",
    process.env.GDMSESSION ?? "",
  ];

  const segments = envVars
    .flatMap((v) => v.toLowerCase().split(":"))
    .map((s) => s.trim())
    .filter(Boolean);

  const isTiling = segments.some((seg) =>
    TILING_WMS.includes(seg)
  );

  return isTiling
    ? { canMinimize: false, canMaximize: false }
    : { canMinimize: true, canMaximize: true };
}

function detectWmInfo(): { name: string; env: Record<string, string> } {
  if (process.platform !== "linux") {
    return { name: "", env: {} };
  }

  const env: Record<string, string> = {
    XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP ?? "",
    DESKTOP_SESSION: process.env.DESKTOP_SESSION ?? "",
    XDG_SESSION_DESKTOP: process.env.XDG_SESSION_DESKTOP ?? "",
    GDMSESSION: process.env.GDMSESSION ?? "",
  };

  const candidates = [
    env.XDG_CURRENT_DESKTOP,
    env.XDG_SESSION_DESKTOP,
    env.DESKTOP_SESSION,
    env.GDMSESSION,
  ];

  let name = "";
  for (const candidate of candidates) {
    if (candidate) {
      name = candidate.split(":")[0].trim();
      break;
    }
  }

  return { name, env };
}

export function registerWindowIpc(): void {
  ipcMain.handle("window-platform", () => process.platform);

  ipcMain.handle("window-can-window-controls", () => detectWindowControls());

  ipcMain.handle("window-wm-info", () => detectWmInfo());

  ipcMain.on("window-minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on("window-maximize-toggle", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.on("window-close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle("window-is-maximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
}
