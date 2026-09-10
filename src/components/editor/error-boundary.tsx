import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Download, RotateCcw } from "lucide-react";
import type { Project } from "@/editor/types";
import { writeRecovery } from "@/editor/persistence";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** Reads the live project so it can be snapshotted at the moment of failure. */
  getProject: () => Project | null;
  onClose: () => void;
}

interface State {
  error: Error | null;
  saved: boolean;
}

/**
 * Catches a render crash without taking the user's work with it.
 *
 * An editor is the worst place for a white screen: whatever was not autosaved
 * in the last few seconds is simply gone, and the user has no way to know that
 * or to get it back. So the first thing this does — before rendering anything —
 * is snapshot the live project to the recovery slot. The reload that follows
 * then finds it waiting.
 */
export class EditorErrorBoundary extends Component<Props, State> {
  state: State = { error: null, saved: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    let saved = false;
    try {
      const project = this.props.getProject();
      if (project) {
        writeRecovery(project);
        saved = true;
      }
    } catch {
      // The snapshot failing must not stop the boundary from rendering; a
      // second throw here would white-screen the thing meant to prevent that.
    }
    this.setState({ saved });
    console.error("Editor crashed:", error, info.componentStack);
  }

  override render() {
    const { error, saved } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-background p-6">
        <div className="w-full max-w-lg space-y-5">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive">
              <AlertTriangle className="size-5" />
            </span>
            <div>
              <h1 className="text-lg font-bold">The editor stopped</h1>
              <p className="text-sm text-muted-foreground">
                {saved
                  ? "Your project was saved to the recovery slot just now. Reload and it will be offered back to you."
                  : "The project could not be snapshotted, so anything since the last autosave may be lost."}
              </p>
            </div>
          </div>

          <pre className="max-h-40 overflow-auto rounded-lg border bg-muted p-3 text-[11px] whitespace-pre-wrap">
            {error.message || String(error)}
          </pre>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => window.location.reload()}>
              <RotateCcw className="size-3.5" />
              Reload
            </Button>
            <Button variant="secondary" onClick={this.download}>
              <Download className="size-3.5" />
              Download project file
            </Button>
            <Button variant="ghost" onClick={this.props.onClose}>
              Back to projects
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            If this is repeatable, the stack is in the browser console — an issue
            with those lines is worth more than a description of what you clicked.
          </p>
        </div>
      </div>
    );
  }

  /** A file the user holds, in case the recovery slot is also unhappy. */
  private download = () => {
    try {
      const project = this.props.getProject();
      if (!project) return;
      const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.name.replace(/[^\w.-]+/g, "-")}.cutline.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Nothing more to offer.
    }
  };
}
