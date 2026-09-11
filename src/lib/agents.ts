/**
 * The page's side of the agent settings: what agents may do, who has
 * connected, how to register one, and what it has all cost. The server holds
 * the token and never hands it back — only its last few characters, enough to
 * tell one from another.
 */

import { apiJson } from "./server";

export interface AgentPermissions {
  mayExport: boolean;
  mayImport: boolean;
  mayDeleteOthersClips: boolean;
}

export interface SeenClient {
  name: string;
  version: string;
  firstSeen: number;
  lastSeen: number;
  calls: number;
  recent: string[];
}

export interface OpenEditor {
  projectId: string;
  name: string;
  /** The editor that saves this project. */
  holder: boolean;
  connectedAt: number;
  seenAt: number;
}

export interface AgentsView {
  /** The line that registers Cutline with an MCP client. */
  registration: string;
  tokenFile: string;
  /** The last four characters of the token, so a rotation is visible. */
  tokenTail: string;
  permissions: AgentPermissions;
  clients: SeenClient[];
  /** Clients are remembered in memory: this is when the server started. */
  since: number;
  editors: OpenEditor[];
}

export interface UsageSummary {
  since: number;
  totals: { calls: number; inputTokens: number; outputTokens: number; cachedTokens: number; transcribedSeconds: number };
  byDay: { day: string; calls: number; inputTokens: number; outputTokens: number; transcribedSeconds: number }[];
  byModel: { model: string; provider: string; calls: number; inputTokens: number; outputTokens: number }[];
  byProject: { projectId: string; calls: number; inputTokens: number; outputTokens: number }[];
  entriesRead: number;
}

export const getAgents = () => apiJson<AgentsView>("/api/agents");

export const setPermissions = (patch: Partial<AgentPermissions>) =>
  apiJson<AgentPermissions>("/api/agents/permissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });

/** A new bearer token: every agent registered with the old one stops working. */
export const rotateAgentToken = () => apiJson<{ registration: string; tokenTail: string }>("/api/agents/token", { method: "POST" });

export const getUsage = (days = 30) => apiJson<UsageSummary>(`/api/agents/usage?days=${days}`);
