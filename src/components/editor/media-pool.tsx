import { useMemo, useRef, useState } from "react";
import {
  Camera,
  Film,
  FolderPlus,
  Grid3x3,
  Image as ImageIcon,
  List,
  Mic,
  Monitor,
  Music,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import type { Action } from "@/editor/project";
import { importFiles } from "@/editor/media";
import type { MediaAsset, Project } from "@/editor/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { AutoCaptionOptions } from "@/components/editor/auto-captions";
import { formatBytes, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

type SortKey = "name" | "date" | "duration" | "size";
type ViewMode = "grid" | "list";

const KIND_ICON = { video: Film, audio: Music, image: ImageIcon } as const;
const SOURCE_ICON = {
  screen: Monitor,
  camera: Camera,
  microphone: Mic,
  "system-audio": Music,
} as const;

function assetIcon(asset: MediaAsset) {
  if (asset.sourceKind) return SOURCE_ICON[asset.sourceKind];
  return KIND_ICON[asset.kind];
}

export function MediaPool({
  project,
  dispatch,
  onInsert,
  onAutoCaption,
  selectedAssetId,
  onSelectAsset,
}: {
  project: Project;
  dispatch: (action: Action, coalesce?: boolean) => void;
  onInsert: (asset: MediaAsset) => void;
  /** Transcribes an asset and captions where it is heard on the timeline. */
  onAutoCaption?: (assetId: string, options?: AutoCaptionOptions) => void;
  selectedAssetId: string | null;
  onSelectAsset: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("date");
  const [view, setView] = useState<ViewMode>("grid");
  const [binId, setBinId] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = project.assets.filter((asset) => {
      if (binId && asset.binId !== binId) return false;
      if (!needle) return true;
      return (
        asset.name.toLowerCase().includes(needle) ||
        asset.tags.some((t) => t.toLowerCase().includes(needle)) ||
        asset.kind.includes(needle)
      );
    });
    return filtered.sort((a, b) => {
      switch (sort) {
        case "name":
          return a.name.localeCompare(b.name);
        case "duration":
          return b.durationSec - a.durationSec;
        case "size":
          return b.bytes - a.bytes;
        default:
          return b.createdAt - a.createdAt;
      }
    });
  }, [project.assets, query, sort, binId]);

  const runImport = async (files: File[]) => {
    if (files.length === 0) return;
    setImporting(`Importing ${files.length} file${files.length > 1 ? "s" : ""}…`);
    try {
      const { assets, failed } = await importFiles(files, (p) => {
        const pct = p.fraction === undefined ? "" : ` ${Math.round(p.fraction * 100)}%`;
        setImporting(`${p.stage}${pct} · ${p.name} (${p.index + 1}/${p.total})`);
      });
      if (assets.length > 0) {
        dispatch({ type: "addAssets", assets: assets.map((a) => ({ ...a, binId })) });
        toast.success(`Imported ${assets.length} file${assets.length > 1 ? "s" : ""}`);
      }
      // One unreadable file in a batch is worth naming; silently importing
      // nine of ten and saying "done" is how people lose footage.
      for (const f of failed) toast.error(`${f.name}: ${f.reason}`);
    } finally {
      setImporting(null);
    }
  };

  return (
    <div
      className={cn(
        "flex h-full flex-col",
        dragOver && "outline-2 outline-offset--2 outline-primary outline-dashed",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void runImport(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <span className="text-xs font-medium">Media</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-6"
          title="Import files"
          onClick={() => fileInput.current?.click()}
        >
          <Upload className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          title="New bin"
          onClick={() => dispatch({ type: "addBin", name: `Bin ${project.bins.length + 1}` })}
        >
          <FolderPlus className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          title={view === "grid" ? "List view" : "Thumbnail view"}
          onClick={() => setView(view === "grid" ? "list" : "grid")}
        >
          {view === "grid" ? <List className="size-3.5" /> : <Grid3x3 className="size-3.5" />}
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          className="hidden"
          onChange={(e) => {
            void runImport(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>

      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="h-7 pl-6.5 text-xs"
          />
        </div>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="h-7 w-[86px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="date">Date</SelectItem>
            <SelectItem value="name">Name</SelectItem>
            <SelectItem value="duration">Length</SelectItem>
            <SelectItem value="size">Size</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {project.bins.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b px-2 py-1.5">
          <Badge
            variant={binId === null ? "default" : "secondary"}
            className="cursor-pointer text-[10px]"
            onClick={() => setBinId(null)}
          >
            All
          </Badge>
          {project.bins.map((bin) => (
            <Badge
              key={bin.id}
              variant={binId === bin.id ? "default" : "secondary"}
              className="cursor-pointer text-[10px]"
              onClick={() => setBinId(bin.id)}
            >
              {bin.name}
            </Badge>
          ))}
        </div>
      )}

      {importing && (
        <div className="border-b px-2 py-1.5 text-[11px] text-muted-foreground">{importing}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Upload className="size-6 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">
              Drop files here
              <br />
              or use the import button
            </p>
          </div>
        ) : view === "grid" ? (
          <div className="grid grid-cols-2 gap-2">
            {visible.map((asset) => {
              const Icon = assetIcon(asset);
              return (
                <ContextMenu key={asset.id}>
                  <ContextMenuTrigger asChild>
                    <button
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("cutline/asset", asset.id)}
                      onClick={() => onSelectAsset(asset.id)}
                      onDoubleClick={() => onInsert(asset)}
                      title={`${asset.name}\nDouble-click to add to the timeline`}
                      className={cn(
                        "group overflow-hidden rounded-md border bg-card text-left transition-colors hover:border-primary/60",
                        selectedAssetId === asset.id && "border-primary ring-1 ring-primary",
                        asset.offline && "opacity-50",
                      )}
                    >
                      <div className="relative flex aspect-video items-center justify-center bg-black/40">
                        {asset.thumbnail ? (
                          <img src={asset.thumbnail} alt="" className="size-full object-cover" />
                        ) : (
                          <Icon className="size-5 text-muted-foreground" />
                        )}
                        {asset.durationSec > 0 && (
                          <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[9px] tabular-nums text-white">
                            {formatDuration(asset.durationSec * 1000)}
                          </span>
                        )}
                        {asset.favorite && (
                          <Star className="absolute top-1 left-1 size-3 fill-amber-400 text-amber-400" />
                        )}
                        {asset.proxyName && (
                          <span
                            className="absolute top-1 right-1 rounded bg-primary px-1 text-[8px] font-bold text-primary-foreground"
                            title="Played from a 720p proxy. The export uses the original."
                          >
                            PROXY
                          </span>
                        )}
                      </div>
                      <div className="px-1.5 py-1">
                        <p className="truncate text-[11px] font-medium">{asset.name}</p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {asset.offline
                            ? "Offline"
                            : asset.width > 0
                              ? `${asset.width}×${asset.height}`
                              : formatBytes(asset.bytes)}
                        </p>
                      </div>
                    </button>
                  </ContextMenuTrigger>
                  <AssetMenu asset={asset} dispatch={dispatch} onInsert={onInsert} onAutoCaption={onAutoCaption} />
                </ContextMenu>
              );
            })}
          </div>
        ) : (
          <div className="space-y-0.5">
            {visible.map((asset) => {
              const Icon = assetIcon(asset);
              return (
                <ContextMenu key={asset.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("cutline/asset", asset.id)}
                      onClick={() => onSelectAsset(asset.id)}
                      onDoubleClick={() => onInsert(asset)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent",
                        selectedAssetId === asset.id && "bg-accent",
                      )}
                    >
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{asset.name}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatDuration(asset.durationSec * 1000)}
                      </span>
                    </div>
                  </ContextMenuTrigger>
                  <AssetMenu asset={asset} dispatch={dispatch} onInsert={onInsert} onAutoCaption={onAutoCaption} />
                </ContextMenu>
              );
            })}
          </div>
        )}
      </div>

      {selectedAssetId && (
        <AssetDetails
          asset={project.assets.find((a) => a.id === selectedAssetId)}
          dispatch={dispatch}
          onInsert={onInsert}
          onAutoCaption={onAutoCaption}
        />
      )}
    </div>
  );
}

function AssetDetails({
  asset,
  dispatch,
  onInsert,
  onAutoCaption,
}: {
  asset: MediaAsset | undefined;
  dispatch: (action: Action, coalesce?: boolean) => void;
  onInsert: (asset: MediaAsset) => void;
  onAutoCaption?: (assetId: string, options?: AutoCaptionOptions) => void;
}) {
  if (!asset) return null;
  const rows: [string, string][] = [
    ["Type", asset.kind],
    ["Size", formatBytes(asset.bytes)],
    ["Length", formatDuration(asset.durationSec * 1000)],
    ...(asset.width > 0 ? ([["Resolution", `${asset.width}×${asset.height}`]] as [string, string][]) : []),
    ...(asset.hasVideo ? ([["Frame rate", `${asset.frameRate.toFixed(2)} fps`]] as [string, string][]) : []),
    ...(asset.sampleRate
      ? ([["Audio", `${(asset.sampleRate / 1000).toFixed(1)} kHz · ${asset.channels ?? 1}ch`]] as [string, string][])
      : []),
    ["Format", asset.mimeType || "—"],
    ...(asset.proxyName
      ? ([["Playback", "720p proxy · export uses the original"]] as [string, string][])
      : []),
    ["Added", new Date(asset.createdAt).toLocaleDateString()],
  ];

  return (
    <div className="border-t p-2">
      <div className="mb-1.5 flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{asset.name}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          title={asset.favorite ? "Remove from favorites" : "Add to favorites"}
          onClick={() =>
            dispatch({ type: "patchAsset", assetId: asset.id, patch: { favorite: !asset.favorite } })
          }
        >
          <Star className={cn("size-3.5", asset.favorite && "fill-amber-400 text-amber-400")} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          title="Add to timeline"
          onClick={() => onInsert(asset)}
        >
          <Plus className="size-3.5" />
        </Button>
        {asset.hasAudio && onAutoCaption && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title="Generate captions"
            onClick={() => onAutoCaption(asset.id)}
          >
            <Sparkles className="size-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          title="Remove from project"
          onClick={() => dispatch({ type: "removeAsset", assetId: asset.id })}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** What a right-click on a media item offers. */
function AssetMenu({
  asset,
  dispatch,
  onInsert,
  onAutoCaption,
}: {
  asset: MediaAsset;
  dispatch: (action: Action, coalesce?: boolean) => void;
  onInsert: (asset: MediaAsset) => void;
  onAutoCaption?: (assetId: string, options?: AutoCaptionOptions) => void;
}) {
  return (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => onInsert(asset)}>
        <Plus className="size-3.5" />
        Add to timeline
      </ContextMenuItem>
      {asset.hasAudio && onAutoCaption && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onAutoCaption(asset.id)}>
            <Sparkles className="size-3.5" />
            Generate captions
          </ContextMenuItem>
          {asset.transcript && (
            <ContextMenuItem onClick={() => onAutoCaption(asset.id, { force: true })}>Transcribe again</ContextMenuItem>
          )}
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => dispatch({ type: "removeAsset", assetId: asset.id })}>
        <Trash2 className="size-3.5" />
        Remove from project
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
