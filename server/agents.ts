/**
 * What agents may do, who has connected, and what it all cost.
 *
 * Permissions live in `~/Cutline/agents.json` and are enforced where the call
 * arrives: the MCP relay refuses an export or an import it may not make, and
 * the tab refuses to delete a clip the agent did not make. They default to
 * what Cutline has always allowed, so turning one off is a decision the user
 * takes, not a surprise on upgrade.
 *
 * Who has connected is remembered in memory only — a restart forgets, and the
 * list says so rather than pretending to a history it does not keep. What
 * things cost is read back from `usage.jsonl`, which the model and
 * transcription calls append to.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AgentPermissions {
  /** export_video. */
  mayExport: boolean;
  /** import_recording, and copying workspace files into a project. */
  mayImport: boolean;
  /** Deleting clips that carry no sign of having been made by an agent. */
  mayDeleteOthersClips: boolean;
}

export const DEFAULT_PERMISSIONS: AgentPermissions = { mayExport: true, mayImport: true, mayDeleteOthersClips: true };

export interface SeenClient {
  name: string;
  version: string;
  firstSeen: number;
  lastSeen: number;
  calls: number;
  /** The tools it has called, most recent first, at most ten. */
  recent: string[];
}

export interface UsageEntry {
  at: number;
  kind?: "chat" | "transcribe" | "voice";
  provider?: string;
  providerId?: string;
  model?: string;
  projectId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  seconds?: number;
  /** Characters read aloud. */
  characters?: number;
}

export interface UsageSummary {
  since: number;
  totals: { calls: number; inputTokens: number; outputTokens: number; cachedTokens: number; transcribedSeconds: number; spokenCharacters: number };
  byDay: { day: string; calls: number; inputTokens: number; outputTokens: number; transcribedSeconds: number }[];
  byModel: { model: string; provider: string; calls: number; inputTokens: number; outputTokens: number }[];
  byProject: { projectId: string; calls: number; inputTokens: number; outputTokens: number }[];
  /** The log is read from the end; this says how much of it was read. */
  entriesRead: number;
}

/** Entries read back from the log, at most: enough for months of ordinary use. */
const MAX_ENTRIES = 20_000;

export class AgentSettings {
  private readonly file: string;
  private readonly usageFile: string;
  private readonly seen = new Map<string, SeenClient>();
  private readonly startedAt = Date.now();

  constructor(home: string) {
    this.file = path.join(home, "agents.json");
    this.usageFile = path.join(home, "usage.jsonl");
  }

  async permissions(): Promise<AgentPermissions> {
    try {
      const stored = JSON.parse(await readFile(this.file, "utf8")) as { permissions?: Partial<AgentPermissions> };
      return { ...DEFAULT_PERMISSIONS, ...stored.permissions };
    } catch {
      return { ...DEFAULT_PERMISSIONS };
    }
  }

  async setPermissions(patch: Partial<AgentPermissions>): Promise<AgentPermissions> {
    const next = { ...(await this.permissions()), ...patch };
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ permissions: next }, null, 2), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.file);
    return next;
  }

  /** An MCP client said hello, or called something. */
  record(client: { name?: string; version?: string } | null, tool?: string): void {
    const name = client?.name?.slice(0, 80) || "an MCP client";
    const entry = this.seen.get(name) ?? { name, version: client?.version?.slice(0, 40) ?? "", firstSeen: Date.now(), lastSeen: 0, calls: 0, recent: [] };
    entry.lastSeen = Date.now();
    if (client?.version) entry.version = client.version.slice(0, 40);
    if (tool) {
      entry.calls += 1;
      entry.recent = [tool, ...entry.recent.filter((t) => t !== tool)].slice(0, 10);
    }
    this.seen.set(name, entry);
  }

  clients(): { since: number; clients: SeenClient[] } {
    return { since: this.startedAt, clients: [...this.seen.values()].sort((a, b) => b.lastSeen - a.lastSeen) };
  }

  /** What the Director and transcription have spent, from the log's tail. */
  async usage(days = 30): Promise<UsageSummary> {
    const since = Date.now() - days * 24 * 3600_000;
    let lines: string[] = [];
    try {
      lines = (await readFile(this.usageFile, "utf8")).split("\n").filter(Boolean).slice(-MAX_ENTRIES);
    } catch {
      // Nothing spent yet.
    }
    const totals = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, transcribedSeconds: 0, spokenCharacters: 0 };
    const byDay = new Map<string, { day: string; calls: number; inputTokens: number; outputTokens: number; transcribedSeconds: number }>();
    const byModel = new Map<string, { model: string; provider: string; calls: number; inputTokens: number; outputTokens: number }>();
    const byProject = new Map<string, { projectId: string; calls: number; inputTokens: number; outputTokens: number }>();

    for (const line of lines) {
      let entry: UsageEntry;
      try {
        entry = JSON.parse(line) as UsageEntry;
      } catch {
        continue;
      }
      if (!entry.at || entry.at < since) continue;
      const input = entry.inputTokens ?? 0;
      const output = entry.outputTokens ?? 0;
      const seconds = entry.seconds ?? 0;
      totals.calls += 1;
      totals.inputTokens += input;
      totals.outputTokens += output;
      totals.cachedTokens += entry.cachedTokens ?? 0;
      totals.transcribedSeconds += seconds;
      totals.spokenCharacters += entry.characters ?? 0;

      const day = new Date(entry.at).toISOString().slice(0, 10);
      const d = byDay.get(day) ?? { day, calls: 0, inputTokens: 0, outputTokens: 0, transcribedSeconds: 0 };
      d.calls += 1;
      d.inputTokens += input;
      d.outputTokens += output;
      d.transcribedSeconds += seconds;
      byDay.set(day, d);

      if (entry.model) {
        const key = `${entry.provider ?? ""}:${entry.model}`;
        const m = byModel.get(key) ?? { model: entry.model, provider: entry.provider ?? "", calls: 0, inputTokens: 0, outputTokens: 0 };
        m.calls += 1;
        m.inputTokens += input;
        m.outputTokens += output;
        byModel.set(key, m);
      }
      if (entry.projectId) {
        const p = byProject.get(entry.projectId) ?? { projectId: entry.projectId, calls: 0, inputTokens: 0, outputTokens: 0 };
        p.calls += 1;
        p.inputTokens += input;
        p.outputTokens += output;
        byProject.set(entry.projectId, p);
      }
    }

    return {
      since,
      totals,
      byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      byModel: [...byModel.values()].sort((a, b) => b.calls - a.calls),
      byProject: [...byProject.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)).slice(0, 20),
      entriesRead: lines.length,
    };
  }
}
