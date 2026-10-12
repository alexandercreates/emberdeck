import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { isEmberdeckError, Workspace, type ItemDiff } from "@emberdeck/core";
import { initConfig } from "./init.js";
import { startStudio } from "./server.js";
import { c, confirm, printJson, table } from "./ui.js";
import { VERSION } from "./version.js";

const HELP = `${c.ember("emberdeck")} ${c.dim(`v${VERSION}`)} — Firebase Remote Config & Storage across stages

${c.bold("Usage")}
  emberdeck <command> [options]

${c.bold("Commands")}
  init                              Create emberdeck.config.ts in the current directory
  studio                            Start the local dashboard
  stages                            List configured stages
  doctor [--stage <name>]           Check credentials and permissions (all stages by default)
  types                             List configured item types
  items <type>                      List items of a type
  get <type> <id>                   Print one item as JSON
  set <type> <id> (--data <json> | --file <path>)
                                    Create or update an item
  rm <type> <id>                    Delete an item
  diff <from> <to> --type <type>    Compare items between two stages
  promote <from> <to> --type <type> [--id <id>...] [--dry-run]
                                    Copy items (and their Storage files) to another stage
  rc pull                           Print the raw Remote Config template

${c.bold("Global options")}
  -s, --stage <name>    Stage to operate on (default: first stage in the config)
  -c, --config <path>   Path to the config file (default: searched upwards from cwd)
      --json            Machine readable output
  -y, --yes             Don't ask for confirmation on protected stages
  -h, --help            Show help
  -v, --version         Show version

${c.bold("Studio options")}
  -p, --port <port>     Port (default: random free port)
      --no-open         Don't open the browser
`;

const OPTIONS = {
  stage: { type: "string", short: "s" },
  config: { type: "string", short: "c" },
  json: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  port: { type: "string", short: "p" },
  open: { type: "boolean", default: true },
  type: { type: "string", short: "t" },
  id: { type: "string", multiple: true },
  data: { type: "string" },
  file: { type: "string" },
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
} satisfies ParseArgsConfig["options"];

type Flags = {
  stage?: string;
  config?: string;
  json?: boolean;
  yes?: boolean;
  help?: boolean;
  version?: boolean;
  port?: string;
  open?: boolean;
  type?: string;
  id?: string[];
  data?: string;
  file?: string;
  "dry-run"?: boolean;
  force?: boolean;
};

class UsageError extends Error {}

function need(args: string[], index: number, name: string): string {
  const v = args[index];
  if (!v) throw new UsageError(`Missing argument <${name}>.`);
  return v;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // Opening the browser is best effort.
  }
}

const STATUS_STYLE: Record<ItemDiff["status"], (s: string) => string> = {
  added: c.green,
  removed: c.red,
  changed: c.yellow,
  unchanged: c.dim,
};

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, allowNegative: true, strict: true });
  const flags = values as Flags;
  const [command, ...args] = positionals;

  if (flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (flags.help || !command || command === "help") {
    console.log(HELP);
    return 0;
  }

  if (command === "init") {
    const path = await initConfig(process.cwd(), { force: flags.force });
    console.log(`${c.green("✔")} Created ${path}`);
    console.log(c.dim("  Next: fill in your projects, then run `emberdeck doctor`."));
    return 0;
  }

  const ws = await Workspace.load(flags.config);
  const stageName = flags.stage ?? ws.stageNames[0]!;

  const guardWrite = async (stage: string, what: string): Promise<void> => {
    if (!ws.stageConfig(stage).protected || flags.yes) return;
    if (!(await confirm(`${c.yellow("!")} ${c.bold(stage)} is protected. ${what}?`))) {
      throw new UsageError("Aborted.");
    }
  };

  switch (command) {
    case "stages": {
      const rows = ws.stageNames.map((name) => {
        const s = ws.stageConfig(name);
        return [name, s.projectId, s.bucket ?? c.dim("—"), s.credentials.type, s.protected ? c.yellow("protected") : ""];
      });
      if (flags.json) printJson(ws.config.stages);
      else console.log(table(rows, ["stage", "project", "bucket", "auth", ""]));
      return 0;
    }

    case "types": {
      if (flags.json) {
        printJson(ws.itemTypes);
        return 0;
      }
      const rows = Object.entries(ws.itemTypes).map(([name, t]) => [
        name,
        t.target.remoteConfig.key,
        t.target.remoteConfig.key.includes("{id}") ? "collection" : "singleton",
        Object.keys(t.fields).join(", "),
      ]);
      console.log(rows.length ? table(rows, ["type", "key", "kind", "fields"]) : c.dim("No item types configured."));
      return 0;
    }

    case "doctor": {
      const names = flags.stage ? [flags.stage] : ws.stageNames;
      let failed = false;
      for (const name of names) {
        console.log(c.bold(`\n${name}`) + c.dim(` (${ws.stageConfig(name).projectId})`));
        let checks;
        try {
          checks = await (await ws.stage(name)).doctor();
        } catch (err) {
          checks = [{ name: "credentials", ok: false, detail: (err as Error).message }];
        }
        for (const check of checks) {
          failed ||= !check.ok;
          console.log(`  ${check.ok ? c.green("✔") : c.red("✖")} ${check.name} ${c.dim(check.detail)}`);
        }
      }
      return failed ? 1 : 0;
    }

    case "items": {
      const type = need(args, 0, "type");
      ws.itemType(type);
      const items = await (await ws.stage(stageName)).listItems(type);
      if (flags.json) {
        printJson(items);
        return 0;
      }
      if (!items.length) {
        console.log(c.dim(`No ${type} items in ${stageName}.`));
        return 0;
      }
      const rows = items.map((i) => [
        i.id,
        i.key,
        i.conditionalValues ? Object.keys(i.conditionalValues).join(", ") : "",
        i.problems?.length ? c.red(`${i.problems.length} problem(s)`) : c.green("ok"),
      ]);
      console.log(table(rows, ["id", "key", "conditions", "status"]));
      return 0;
    }

    case "get": {
      const item = await (await ws.stage(stageName)).getItem(need(args, 0, "type"), need(args, 1, "id"));
      if (!item) {
        console.error(c.red("Item not found."));
        return 1;
      }
      printJson(item);
      return 0;
    }

    case "set": {
      const type = need(args, 0, "type");
      const id = need(args, 1, "id");
      const raw = flags.data ?? (flags.file ? await readFile(flags.file, "utf8") : undefined);
      if (!raw) throw new UsageError("Provide the item value with --data '<json>' or --file <path>.");
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new UsageError("Item value is not valid JSON.");
      }
      await guardWrite(stageName, `Save ${type}/${id}`);
      const { item } = await (await ws.stage(stageName)).saveItem(type, id, { value });
      if (flags.json) printJson(item);
      else console.log(`${c.green("✔")} Saved ${type}/${id} in ${stageName}`);
      return 0;
    }

    case "rm": {
      const type = need(args, 0, "type");
      const id = need(args, 1, "id");
      await guardWrite(stageName, `Delete ${type}/${id}`);
      await (await ws.stage(stageName)).deleteItem(type, id);
      console.log(`${c.green("✔")} Deleted ${type}/${id} from ${stageName}`);
      return 0;
    }

    case "diff": {
      const from = need(args, 0, "from");
      const to = need(args, 1, "to");
      if (!flags.type) throw new UsageError("--type is required.");
      const diff = await ws.diff(from, to, flags.type);
      if (flags.json) {
        printJson(diff);
        return 0;
      }
      const rows = diff.map((d) => [
        STATUS_STYLE[d.status](d.status),
        d.id,
        [d.changedFields?.join(", "), d.conditionalValuesDiffer ? "conditions" : ""].filter(Boolean).join(" · "),
      ]);
      console.log(rows.length ? table(rows, ["status", "id", "changes"]) : c.dim("Nothing to compare."));
      return 0;
    }

    case "promote": {
      const from = need(args, 0, "from");
      const to = need(args, 1, "to");
      if (!flags.type) throw new UsageError("--type is required.");
      const dryRun = !!flags["dry-run"];
      if (!dryRun) await guardWrite(to, `Promote ${flags.type} from ${from}`);
      const report = await ws.promote({ from, to, type: flags.type, ids: flags.id, dryRun });
      if (flags.json) {
        printJson(report);
        return 0;
      }
      console.log(c.bold(`${dryRun ? "Dry run: " : ""}${from} → ${to} (${flags.type})`));
      for (const i of report.items) console.log(`  ${i.action.padEnd(8)} ${i.id}${i.reason ? c.dim(` (${i.reason})`) : ""}`);
      for (const f of report.files) console.log(c.dim(`  file ${f.action.padEnd(8)} ${f.path}`));
      return 0;
    }

    case "rc": {
      if (args[0] !== "pull") throw new UsageError("Usage: emberdeck rc pull [--stage <name>]");
      const { template } = await (await ws.stage(stageName)).remoteConfig.getTemplate();
      printJson(template);
      return 0;
    }

    case "studio": {
      const port = flags.port ? Number(flags.port) : undefined;
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
        throw new UsageError("--port must be a valid port number.");
      }
      const studio = await startStudio(ws, { port });
      console.log(`\n  ${c.ember("🔥 emberdeck studio")} ${c.dim(`(${ws.loaded.path})`)}\n`);
      console.log(`  ${c.bold(studio.url)}\n`);
      console.log(c.dim("  This link contains your session token. Press Ctrl+C to stop.\n"));
      if (flags.open !== false) openBrowser(studio.url);
      await new Promise<void>((resolveStop) => {
        const stop = () => void studio.close().then(resolveStop);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }

    default:
      throw new UsageError(`Unknown command "${command}". Run \`emberdeck --help\`.`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await run(argv);
  } catch (err) {
    if (err instanceof UsageError || isEmberdeckError(err) || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      console.error(c.red(`✖ ${(err as Error).message}`));
      if (isEmberdeckError(err) && Array.isArray(err.details) && err.code === "VALIDATION_FAILED") {
        for (const issue of err.details as { path: string; message: string }[]) {
          console.error(c.dim(`  ${issue.path}: ${issue.message}`));
        }
      }
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
