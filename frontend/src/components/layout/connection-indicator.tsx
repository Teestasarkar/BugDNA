"use client";

/**
 * Realtime connection status.
 *
 * Small, but it earns its place: when live progress stops arriving, the user
 * needs to know whether the analysis stalled or the socket dropped. Without this
 * the two are indistinguishable, and the natural response to both is to re-click
 * the button.
 *
 * Nothing is shown while healthy — a green dot that is always green teaches
 * people to ignore it.
 */
import * as React from "react";
import { CloudOff, RefreshCw, Wifi } from "lucide-react";
import { getConnectionState, onConnectionStateChange, type ConnectionState } from "@/lib/realtime";
import { InfoTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function ConnectionIndicator({ compact = false }: { compact?: boolean }) {
  const [state, setState] = React.useState<ConnectionState>(getConnectionState);

  React.useEffect(() => onConnectionStateChange(setState), []);

  // Healthy and idle are both non-events.
  if (state === "connected" || state === "idle") {
    if (!compact) {
      return (
        <InfoTooltip label="Live updates are connected. Analysis progress arrives without refreshing.">
          <span className="flex items-center gap-1.5 px-1 text-[0.6875rem] text-sidebar-foreground/50">
            <Wifi className="size-3" aria-hidden />
            Live
          </span>
        </InfoTooltip>
      );
    }
    return null;
  }

  const presentation =
    state === "failed"
      ? {
          icon: CloudOff,
          label: "Live updates offline",
          hint: "The realtime connection could not be established. Analysis progress will still update, but only when the page refetches.",
          className: "text-risk-moderate",
        }
      : {
          icon: RefreshCw,
          label: "Reconnecting",
          hint: "Reconnecting to live updates. Anything missed will be refetched automatically.",
          className: "text-muted-foreground",
        };

  return (
    <InfoTooltip label={presentation.hint}>
      <span
        className={cn(
          "flex items-center gap-1.5 px-1 text-[0.6875rem] font-medium",
          presentation.className,
        )}
      >
        <presentation.icon
          className={cn("size-3", state === "reconnecting" && "animate-spin")}
          aria-hidden
        />
        {!compact && presentation.label}
      </span>
    </InfoTooltip>
  );
}
