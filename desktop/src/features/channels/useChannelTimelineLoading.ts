import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useChannelSwitchTraceMarks } from "@/features/channels/useChannelSwitchTraceMarks";
import { hasPersistedHydratedChannel } from "@/features/messages/lib/channelHeadCache";
import {
  resolveTimelineLoadingLatch,
  selectTimelineLoadingState,
} from "@/features/messages/lib/timelineLoadingState";
import type { Channel } from "@/shared/api/types";

/**
 * Latches the timeline loading state per channel and drives the
 * channel-switch trace marks from that same latch, so the tracer settles on
 * exactly the loading state the screen renders from.
 */
export function useChannelTimelineLoading(
  activeChannel: Channel | null,
  messagesQuery: {
    data: readonly unknown[] | undefined;
    isFetching: boolean;
    isPending: boolean;
    isPlaceholderData: boolean;
  },
): boolean {
  const queryClient = useQueryClient();
  const activeChannelId = activeChannel?.id ?? null;
  const settledChannelIdRef = React.useRef<string | null>(null);
  const hasSettledThisChannel =
    activeChannelId !== null && settledChannelIdRef.current === activeChannelId;
  const timelineLoadingNow =
    activeChannel !== null &&
    activeChannel.channelType !== "forum" &&
    selectTimelineLoadingState(
      {
        isPending: messagesQuery.isPending,
        isFetching: messagesQuery.isFetching,
        isPlaceholderData: messagesQuery.isPlaceholderData,
        dataLength: messagesQuery.data?.length ?? null,
      },
      // A persisted head only counts as hydrated when it has rows to paint
      // (channelHeadCache.ts), so this bypass never settles onto an empty
      // placeholder while the authoritative refresh is still in flight.
      hasSettledThisChannel ||
        (activeChannelId !== null &&
          hasPersistedHydratedChannel(queryClient, activeChannelId)),
    );
  const { settledChannelId, isLoading: isTimelineLoading } =
    resolveTimelineLoadingLatch(
      settledChannelIdRef.current,
      activeChannelId,
      timelineLoadingNow,
    );
  settledChannelIdRef.current = settledChannelId;
  useChannelSwitchTraceMarks({
    activeChannelId,
    activeChannelType: activeChannel?.channelType ?? null,
    isTimelineLoading,
  });
  return isTimelineLoading;
}
