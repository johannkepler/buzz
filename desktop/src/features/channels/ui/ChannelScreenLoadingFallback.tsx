import { HuddleStartingView } from "@/features/huddle/components/HuddleStartingView";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

export function ChannelScreenLoadingFallback({
  isHuddleTranscript,
}: {
  isHuddleTranscript: boolean;
}) {
  return (
    // While the lazy ChannelPane chunk is suspended, the timeline — and its
    // own render-pending marker — is not mounted. The switch tracer polls
    // that marker to defer its settle, so the fallback itself must read as
    // pending or a settle could record before the pane ever painted.
    // `contents` keeps the wrapper out of layout.
    <div className="contents" data-render-pending="true">
      {isHuddleTranscript ? (
        <HuddleStartingView />
      ) : (
        <ViewLoadingFallback includeHeader kind="channel" />
      )}
    </div>
  );
}
