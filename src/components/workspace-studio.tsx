/**
 * Studio: everything reused across videos — brand kits, looks, recipes and
 * references. A project copies what it uses and records the version, so
 * editing a kit here never changes a video that is already finished.
 */

import { useEffect, useState } from "react";
import { Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { RECIPES } from "@/editor/recipes";
import { THEMES, themeById } from "@/editor/themes";
import type { BrandKit, LayoutStyle, Look, Recipe, WorkspaceReference } from "@/editor/types";
import { listItems, newItemId, removeItem, saveItem, uploadItemFile, type WorkspaceKind } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const commas = (text: string) => text.split(",").map((l) => l.trim()).filter(Boolean);
const selectClass = "h-8 w-full rounded-md border bg-card px-2 text-xs";
const LAYOUTS: LayoutStyle[] = ["side-panel", "b-roll", "pip", "lower-thirds", "graphics-only"];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** The list of one kind beside the thing being edited: everything here is small enough for one page. */
function Kind<K extends WorkspaceKind>({
  kind,
  title,
  blurb,
  empty,
  make,
  render,
}: {
  kind: K;
  title: string;
  blurb: string;
  empty: string;
  make: () => { id: string; name: string } & Record<string, unknown>;
  render: (item: any, set: (patch: Record<string, unknown>) => void, save: () => Promise<void>) => React.ReactNode;
}) {
  const [items, setItems] = useState<any[] | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const refresh = () => listItems(kind).then((list) => setItems(list as any[])).catch(() => setItems([]));
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const save = async () => {
    if (!editing) return;
    try {
      const saved = await saveItem(kind, editing);
      toast.success(`${saved.name} saved (version ${saved.version})`);
      setEditing(saved);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save it.");
    }
  };
  const remove = async (id: string, name: string) => {
    await removeItem(kind, id).catch(() => toast.error("Could not delete it."));
    if (editing?.id === id) setEditing(null);
    toast.success(`${name} deleted`);
    await refresh();
  };

  return (
    <div className="grid gap-4 sm:grid-cols-[220px_1fr]">
      <div className="space-y-1">
        <div className="flex items-center">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => setEditing(make())}>
            <Plus className="size-3.5" />
            New
          </Button>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">{blurb}</p>
        <ul className="mt-2 space-y-1">
          {items === null ? (
            <li className="text-[11px] text-muted-foreground">Loading…</li>
          ) : items.length === 0 ? (
            <li className="text-[11px] text-muted-foreground">{empty}</li>
          ) : (
            items.map((item) => (
              <li key={item.id} className="flex items-center gap-1">
                <button
                  className={cn("flex-1 truncate rounded-md px-2 py-1 text-left text-xs hover:bg-accent", editing?.id === item.id && "bg-accent font-medium")}
                  onClick={() => setEditing(item)}
                >
                  {item.name}
                  <span className="ml-1 text-[10px] text-muted-foreground">v{item.version}</span>
                </button>
                <button className="text-muted-foreground hover:text-destructive" aria-label={`Delete ${item.name}`} onClick={() => void remove(item.id, item.name)}>
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
      <div className="min-w-0">
        {editing ? (
          <div className="space-y-2 rounded-xl border p-3">
            <Row label="Name">
              <Input className="h-8 text-xs" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Row>
            {render(editing, (patch) => setEditing({ ...editing, ...patch }), save)}
            <div className="flex gap-2 pt-1">
              <Button size="sm" className="h-8 text-xs" onClick={() => void save()}>
                Save
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setEditing(null)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <p className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">Pick one on the left, or make a new one.</p>
        )}
      </div>
    </div>
  );
}

function FileSlot({ kind, id, role, name, onNamed }: { kind: WorkspaceKind; id: string; role: string; name?: string; onNamed: (name: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className="flex items-center gap-2 rounded-md border px-2 py-1 text-[11px]">
      <span className="w-20 shrink-0 text-muted-foreground">{role}</span>
      <span className="truncate">{name ?? "—"}</span>
      <input
        type="file"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setBusy(true);
          try {
            onNamed(await uploadItemFile(kind, id, file));
            toast.success(`${file.name} stored — save to keep it`);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not store it.");
          } finally {
            setBusy(false);
          }
        }}
      />
      <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground">
        <Upload className="size-3" />
        {busy ? "Storing…" : "Choose"}
      </span>
    </label>
  );
}

export function WorkspaceStudio() {
  return (
    <Tabs defaultValue="brand-kits" className="py-6">
      <TabsList className="h-9">
        <TabsTrigger value="brand-kits" className="text-xs">Brand kits</TabsTrigger>
        <TabsTrigger value="looks" className="text-xs">Looks</TabsTrigger>
        <TabsTrigger value="recipes" className="text-xs">Recipes</TabsTrigger>
        <TabsTrigger value="references" className="text-xs">References</TabsTrigger>
      </TabsList>

      <TabsContent value="brand-kits" className="mt-4">
        <Kind
          kind="brand-kits"
          title="Brand kits"
          blurb="A client's colours, faces, logo and standing rules. Applying one copies it into the project."
          empty="No kits yet."
          make={() => ({ id: newItemId("kit"), name: "New brand kit", files: {}, colors: [], fonts: [], tone: "", rules: [], layout: null, lowerThird: { name: "", role: "" }, notes: "" })}
          render={(kit: BrandKit, set) => (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <Row label="Colours (comma separated hex)">
                  <Input className="h-8 text-xs" value={kit.colors.join(", ")} onChange={(e) => set({ colors: commas(e.target.value) })} placeholder="#0B3D2E, #F5B301" />
                </Row>
                <Row label="Fonts (display, body)">
                  <Input className="h-8 text-xs" value={kit.fonts.join(", ")} onChange={(e) => set({ fonts: commas(e.target.value) })} placeholder="Poppins, Inter" />
                </Row>
                <Row label="Tone">
                  <Input className="h-8 text-xs" value={kit.tone} onChange={(e) => set({ tone: e.target.value })} placeholder="Plain, warm, never salesy" />
                </Row>
                <Row label="Default layout">
                  <select className={selectClass} value={kit.layout ?? ""} onChange={(e) => set({ layout: (e.target.value || null) as LayoutStyle | null })}>
                    <option value="">No default</option>
                    {LAYOUTS.map((l) => (
                      <option key={l} value={l}>
                        {l.replace("-", " ")}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="Lower third — name">
                  <Input className="h-8 text-xs" value={kit.lowerThird.name} onChange={(e) => set({ lowerThird: { ...kit.lowerThird, name: e.target.value } })} />
                </Row>
                <Row label="Lower third — role">
                  <Input className="h-8 text-xs" value={kit.lowerThird.role} onChange={(e) => set({ lowerThird: { ...kit.lowerThird, role: e.target.value } })} />
                </Row>
              </div>
              <Row label="Standing rules, one per line">
                <Textarea rows={3} className="text-xs" value={kit.rules.join("\n")} onChange={(e) => set({ rules: lines(e.target.value) })} placeholder="Never show prices without a date." />
              </Row>
              <Row label="Notes">
                <Textarea rows={2} className="text-xs" value={kit.notes} onChange={(e) => set({ notes: e.target.value })} />
              </Row>
              <div className="space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">Files — copied into a project's Brand bin</span>
                {(["logo", "logoDark", "intro", "outro", "watermark"] as const).map((role) => (
                  <FileSlot
                    key={role}
                    kind="brand-kits"
                    id={kit.id}
                    role={role === "logoDark" ? "logo (dark)" : role}
                    name={kit.files[role]}
                    onNamed={(name) => set({ files: { ...kit.files, [role]: name } })}
                  />
                ))}
              </div>
            </>
          )}
        />
      </TabsContent>

      <TabsContent value="looks" className="mt-4">
        <Kind
          kind="looks"
          title="Looks"
          blurb="Themes to reuse: start from a built-in one, change its colours, and apply it to any project."
          empty="No saved looks. The built-in themes are always there."
          make={() => {
            const base = THEMES[0]!;
            const id = newItemId("look");
            return { id, name: `${base.name} copy`, description: base.description, theme: { ...base, id, name: `${base.name} copy` } };
          }}
          render={(look: Look, set) => (
            <>
              <Row label="From">
                <select
                  className={selectClass}
                  value=""
                  onChange={(e) => {
                    const base = themeById(e.target.value);
                    set({ theme: { ...base, id: look.id, name: look.name }, description: base.description });
                  }}
                >
                  <option value="">Start from a built-in theme…</option>
                  {THEMES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Description">
                <Input className="h-8 text-xs" value={look.description} onChange={(e) => set({ description: e.target.value })} />
              </Row>
              <div className="grid gap-2 sm:grid-cols-3">
                {(["background", "text", "accent"] as const).map((token) => (
                  <Row key={token} label={token}>
                    <div className="flex items-center gap-1">
                      <input
                        type="color"
                        className="size-8 rounded border bg-transparent"
                        value={/^#[0-9a-f]{6}$/i.test(look.theme.palette[token]) ? look.theme.palette[token] : "#000000"}
                        onChange={(e) => set({ theme: { ...look.theme, palette: { ...look.theme.palette, [token]: e.target.value } } })}
                      />
                      <Input
                        className="h-8 text-xs"
                        value={look.theme.palette[token]}
                        onChange={(e) => set({ theme: { ...look.theme, palette: { ...look.theme.palette, [token]: e.target.value } } })}
                      />
                    </div>
                  </Row>
                ))}
              </div>
              <Row label="Fonts (display, body)">
                <Input
                  className="h-8 text-xs"
                  value={`${look.theme.fonts.display.split(",")[0]}, ${look.theme.fonts.body.split(",")[0]}`}
                  onChange={(e) => {
                    const [display, body] = commas(e.target.value);
                    set({ theme: { ...look.theme, fonts: { ...look.theme.fonts, display: display ?? look.theme.fonts.display, body: body ?? display ?? look.theme.fonts.body } } });
                  }}
                />
              </Row>
            </>
          )}
        />
      </TabsContent>

      <TabsContent value="recipes" className="mt-4 space-y-4">
        <Kind
          kind="recipes"
          title="Recipes"
          blurb="What a kind of video needs: brief defaults, what to ask, how the storyboard usually goes, and the formats to deliver."
          empty="No saved recipes. The built-in ones are below."
          make={() => ({ id: newItemId("recipe"), name: "New recipe", description: "", brief: {}, questions: [], patterns: [], qa: [], exports: [{ name: "Landscape 1080p", width: 1920, height: 1080 }] })}
          render={(recipe: Recipe, set) => (
            <>
              <Row label="Description">
                <Input className="h-8 text-xs" value={recipe.description} onChange={(e) => set({ description: e.target.value })} />
              </Row>
              <div className="grid gap-2 sm:grid-cols-3">
                <Row label="Platform">
                  <Input className="h-8 text-xs" value={recipe.brief.platform ?? ""} onChange={(e) => set({ brief: { ...recipe.brief, platform: e.target.value } })} />
                </Row>
                <Row label="Layout">
                  <select className={selectClass} value={recipe.brief.layout ?? ""} onChange={(e) => set({ brief: { ...recipe.brief, layout: (e.target.value || undefined) as LayoutStyle | undefined } })}>
                    <option value="">None</option>
                    {LAYOUTS.map((l) => (
                      <option key={l} value={l}>
                        {l.replace("-", " ")}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="Captions">
                  <select className={selectClass} value={recipe.brief.captions ?? ""} onChange={(e) => set({ brief: { ...recipe.brief, captions: (e.target.value || undefined) as "yes" | "no" | undefined } })}>
                    <option value="">Not set</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </Row>
              </div>
              {(["questions", "patterns", "qa"] as const).map((field) => (
                <Row key={field} label={field === "qa" ? "Checks before export, one per line" : `${field === "questions" ? "Questions to ask" : "Storyboard patterns"}, one per line`}>
                  <Textarea rows={3} className="text-xs" value={recipe[field].join("\n")} onChange={(e) => set({ [field]: lines(e.target.value) })} />
                </Row>
              ))}
              <Row label="Formats — name width×height, one per line">
                <Textarea
                  rows={2}
                  className="text-xs"
                  value={recipe.exports.map((x) => `${x.name} ${x.width}x${x.height}`).join("\n")}
                  onChange={(e) =>
                    set({
                      exports: lines(e.target.value).flatMap((line) => {
                        const m = /^(.*?)\s*(\d{2,5})\s*[x×]\s*(\d{2,5})$/.exec(line);
                        return m ? [{ name: m[1]!.trim() || `${m[2]}×${m[3]}`, width: Number(m[2]), height: Number(m[3]) }] : [];
                      }),
                    })
                  }
                />
              </Row>
            </>
          )}
        />
        <div>
          <h3 className="text-xs font-semibold">Built in</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {RECIPES.map((r) => (
              <div key={r.id} className="rounded-xl border p-3">
                <p className="text-xs font-semibold">{r.name}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{r.description}</p>
              </div>
            ))}
          </div>
        </div>
      </TabsContent>

      <TabsContent value="references" className="mt-4">
        <Kind
          kind="references"
          title="References"
          blurb="Videos, images and links worth pointing at, with what to take from each."
          empty="No references yet."
          make={() => ({ id: newItemId("reference"), name: "New reference", url: null, note: "", tags: [] })}
          render={(ref: WorkspaceReference, set) => (
            <>
              <Row label="Link">
                <Input className="h-8 text-xs" value={ref.url ?? ""} onChange={(e) => set({ url: e.target.value || null })} placeholder="https://…" />
              </Row>
              <Row label="What to take from it">
                <Textarea rows={2} className="text-xs" value={ref.note} onChange={(e) => set({ note: e.target.value })} placeholder="The pacing; the lower thirds." />
              </Row>
              <Row label="Tags (comma separated)">
                <Input className="h-8 text-xs" value={ref.tags.join(", ")} onChange={(e) => set({ tags: commas(e.target.value) })} />
              </Row>
              <FileSlot kind="references" id={ref.id} role="file" name={ref.file} onNamed={(name) => set({ file: name })} />
            </>
          )}
        />
      </TabsContent>
    </Tabs>
  );
}
