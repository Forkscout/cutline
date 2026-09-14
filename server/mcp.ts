/**
 * `/mcp` — Cutline as an MCP server, over streamable HTTP.
 *
 * Stateless: every request gets a fresh MCP server instance. Nothing about a
 * conversation is held here (turns live in the editor tab), so a restart —
 * which `bun --watch` does on every save in development — cannot strand a
 * client holding a session id the server has forgotten.
 *
 * Authentication is a bearer token kept in `~/Cutline/mcp-token`, not the
 * per-run page token: an MCP client is configured once, and a secret that
 * changed on every start would mean re-registering it every time.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { GUIDE, GUIDE_TOPICS, PROMPTS, guideIndex } from "../src/editor/agent-guide";
import { ACTION_TOOLS, EDITOR_TOOLS, SERVER_INSTRUCTIONS, type ToolSpec } from "../src/editor/agent-tools";
import { THEMES } from "../src/editor/themes";
import type { TabBridge } from "./bridge";
import type { DiskMediaStore } from "./media";
import type { WorkspaceStore } from "./workspace";
import type { AgentSettings } from "./agents";
import { sameSecret } from "./security";

/** A new token, written where the old one was: every agent registered with it stops working. */
export async function rotateMcpToken(home: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await mkdir(home, { recursive: true });
  const file = path.join(home, "mcp-token");
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return token;
}

/** Reads the MCP token, creating it (owner-only) on first run. */
export async function loadMcpToken(home: string): Promise<string> {
  if (process.env.CUTLINE_MCP_TOKEN) return process.env.CUTLINE_MCP_TOKEN;
  const file = path.join(home, "mcp-token");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing) return existing;
  } catch {
    // First run.
  }
  await mkdir(home, { recursive: true });
  const token = randomBytes(32).toString("hex");
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return token;
}

function buildServer(bridge: TabBridge, media: DiskMediaStore, workspace: WorkspaceStore, agents: AgentSettings): McpServer {
  const server = new McpServer({ name: "cutline", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });

  const relay = (spec: ToolSpec) =>
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input,
        annotations: { readOnlyHint: Boolean(spec.readOnly), destructiveHint: false, openWorldHint: false },
      },
      async (args) => {
        try {
          // What an agent may do is the user's to decide, and it is decided here,
          // before the call reaches the tab.
          const permissions = await agents.permissions();
          if (spec.name === "export_video" && !permissions.mayExport) {
            throw new Error("Exporting is turned off for agents in Settings › Agents. Ask the user to export, or to turn it on.");
          }
          if ((spec.name === "import_recording" || spec.name === "import_media" || spec.name === "generate_voice") && !permissions.mayImport) {
            throw new Error("Importing files is turned off for agents in Settings › Agents.");
          }
          return { content: await bridge.call(spec.name, args) };
        } catch (err) {
          return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    );

  for (const spec of Object.values(ACTION_TOOLS)) relay(spec);
  for (const spec of Object.values(EDITOR_TOOLS)) relay(spec);

  // Answered here: recordings are on disk, and listing them needs no editor.
  server.registerTool(
    "list_recordings",
    {
      title: "List recordings",
      description: "Finished recordings on this machine, newest first — the ids import_recording takes.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const sessions = (await media.listSessions()) as {
        id: string;
        name: string;
        createdAt: number;
        durationMs: number;
        tracks: { kind: string; label: string }[];
      }[];
      const summary = sessions.map((s) => ({
        id: s.id,
        name: s.name,
        recordedAt: new Date(s.createdAt).toISOString(),
        seconds: Math.round(s.durationMs / 100) / 10,
        tracks: s.tracks.map((t) => t.kind),
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    },
  );

  // The playbook. Answered here, so an agent can read it before any editor is open.
  server.registerTool(
    "guide",
    {
      title: "Director's guide",
      description: `How to work in Cutline as a director: the workflow and its checkpoints, what to ask the client, what to check in the source, layouts and rhythm, themes, graphics, review, and the gotchas. Call with no topic for the index. Topics: ${GUIDE_TOPICS.join(", ")}.`,
      inputSchema: { topic: z.enum(GUIDE_TOPICS as [string, ...string[]]).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ topic }) => ({
      content: [{ type: "text", text: topic ? `# ${GUIDE[topic]!.title}\n\n${GUIDE[topic]!.body}` : guideIndex() }],
    }),
  );

  server.registerTool(
    "list_themes",
    {
      title: "List themes",
      description: "The design themes: the built-in ones — what each is for, its palette, faces and motion — and looks saved in the Studio, marked with a lookId. Show them on the video with preview_themes; choose with set_theme({ themeId }) or set_theme({ lookId }).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            ...THEMES.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              background: t.palette.backgroundTo ? [t.palette.background, t.palette.backgroundTo] : t.palette.background,
              text: t.palette.text,
              accent: t.palette.accent,
              fonts: { display: t.fonts.display.split(",")[0], body: t.fonts.body.split(",")[0] },
              motion: t.motion.enter,
            })),
            ...((await workspace.list("looks").catch(() => [])) as { id: string; name?: string; description?: string }[]).map((l) => ({
              lookId: l.id,
              name: l.name,
              description: l.description,
            })),
          ]),
        },
      ],
    }),
  );

  for (const [id, topic] of Object.entries(GUIDE)) {
    server.registerResource(
      `guide-${id}`,
      `cutline://guide/${id}`,
      { title: topic.title, description: topic.summary, mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: `# ${topic.title}\n\n${topic.body}` }] }),
    );
  }

  server.registerPrompt(
    "direct",
    { title: PROMPTS.direct.title, description: PROMPTS.direct.description, argsSchema: { goal: z.string().optional() } },
    ({ goal }) => ({ messages: [{ role: "user", content: { type: "text", text: PROMPTS.direct.text(goal) } }] }),
  );
  server.registerPrompt("brief", { title: PROMPTS.brief.title, description: PROMPTS.brief.description }, () => ({
    messages: [{ role: "user", content: { type: "text", text: PROMPTS.brief.text() } }],
  }));
  server.registerPrompt("review", { title: PROMPTS.review.title, description: PROMPTS.review.description }, () => ({
    messages: [{ role: "user", content: { type: "text", text: PROMPTS.review.text() } }],
  }));

  return server;
}

/** Client names by user agent: an initialize says who it is, the calls after it do not. */
const KNOWN = new Map<string, { name?: string; version?: string }>();

export function mcpHandler(options: {
  bridge: TabBridge;
  media: DiskMediaStore;
  workspace: WorkspaceStore;
  agents: AgentSettings;
  /** Read at each request: the user can rotate it without a restart. */
  token: () => string;
  allowedOrigins: string[];
}) {
  const origins = new Set(options.allowedOrigins);
  return async (c: Context): Promise<Response> => {
    // MCP clients are processes and send no Origin. A browser always does, and
    // no web page has any business here.
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) return c.json({ error: "Origin not allowed" }, 403);

    const auth = c.req.header("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!sameSecret(given, options.token())) {
      return c.json({ error: "Missing or wrong bearer token — see ~/Cutline/mcp-token" }, 401);
    }

    // Who is calling, from the message itself: the body is read here and handed
    // on, because a stateless server has no session to hang a name on.
    let request = c.req.raw;
    if (request.method === "POST") {
      const body = await request.text();
      const agent = c.req.header("user-agent") ?? "";
      try {
        const message = JSON.parse(body) as { method?: string; params?: { clientInfo?: { name?: string; version?: string }; name?: string } };
        if (message.method === "initialize" && message.params?.clientInfo) {
          KNOWN.set(agent, message.params.clientInfo);
          options.agents.record(message.params.clientInfo);
        } else if (message.method === "tools/call") {
          options.agents.record(KNOWN.get(agent) ?? null, message.params?.name);
        }
      } catch {
        // Not a message we can read; it will fail on its own below.
      }
      request = new Request(request.url, { method: request.method, headers: request.headers, body });
    }

    const server = buildServer(options.bridge, options.media, options.workspace, options.agents);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // One JSON body per request: nothing here streams, and a plain response
      // is far easier to debug with curl than an event stream.
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      // JSON mode has the whole answer in the Response already.
      void transport.close();
      void server.close();
    }
  };
}
