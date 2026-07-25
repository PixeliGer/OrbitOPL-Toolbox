import * as fs from "fs/promises";
import path from "path";
import { createLogger } from "../logger";

const log = createLogger("games-list");

const PS1_GAMES_LIST_CANDIDATE_PATHS = [
  path.resolve(__dirname, "../assets/ps1-gameslist.txt"),
  path.resolve(__dirname, "../../assets/ps1-gameslist.txt"),
  path.resolve(process.cwd(), "assets/ps1-gameslist.txt"),
];

let cachedPs1GamesList: Map<string, string> | null = null;
let attemptedToLoadPs1GamesList = false;

async function loadPs1GamesList() {
  if (attemptedToLoadPs1GamesList) {
    return cachedPs1GamesList;
  }

  attemptedToLoadPs1GamesList = true;

  for (const candidate of PS1_GAMES_LIST_CANDIDATE_PATHS) {
    try {
      const content = await fs.readFile(candidate, "utf-8");
      const map = new Map<string, string>();

      content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        const [id, ...nameParts] = trimmed.split(/\s+/);
        if (!id || nameParts.length === 0) {
          return;
        }

        map.set(id.toUpperCase(), nameParts.join(" "));
      });

      if (map.size > 0) {
        cachedPs1GamesList = map;
        log.verbose(`Loaded PS1 games list (${map.size} titles) from ${candidate}`);
        return cachedPs1GamesList;
      }
    } catch (err) {
      log.verbose(`PS1 games list not at ${candidate}, trying next candidate`);
    }
  }

  cachedPs1GamesList = null;
  log.warn("PS1 games list not found in any candidate path — titles will fall back to filenames");
  return cachedPs1GamesList;
}

export async function findPs1GameName(gameId: string) {
  const list = await loadPs1GamesList();
  if (!list) {
    return undefined;
  }

  return list.get(gameId.toUpperCase());
}

const PS2_GAMES_LIST_CANDIDATE_PATHS = [
  path.resolve(__dirname, "../assets/ps2-gameslist.txt"),
  path.resolve(__dirname, "../../assets/ps2-gameslist.txt"),
  path.resolve(process.cwd(), "assets/ps2-gameslist.txt"),
];

let cachedPs2GamesList: Map<string, string> | null = null;
let attemptedToLoadPs2GamesList = false;

async function loadPs2GamesList() {
  if (attemptedToLoadPs2GamesList) {
    return cachedPs2GamesList;
  }

  attemptedToLoadPs2GamesList = true;

  for (const candidate of PS2_GAMES_LIST_CANDIDATE_PATHS) {
    try {
      const content = await fs.readFile(candidate, "utf-8");
      const map = new Map<string, string>();

      content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        const [id, ...nameParts] = trimmed.split(/\s+/);
        if (!id || nameParts.length === 0) {
          return;
        }

        map.set(id.toUpperCase(), nameParts.join(" "));
      });

      if (map.size > 0) {
        cachedPs2GamesList = map;
        log.verbose(`Loaded PS2 games list (${map.size} titles) from ${candidate}`);
        return cachedPs2GamesList;
      }
    } catch (err) {
      log.verbose(`PS2 games list not at ${candidate}, trying next candidate`);
    }
  }

  cachedPs2GamesList = null;
  log.warn("PS2 games list not found in any candidate path — titles will fall back to filenames");
  return cachedPs2GamesList;
}

export async function findPs2GameName(gameId: string) {
  const list = await loadPs2GamesList();
  if (!list) {
    return undefined;
  }

  return list.get(gameId.toUpperCase());
}
