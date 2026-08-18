import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../server/trpc.js";

const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "/trpc";

// El cliente tRPC con split: subscriptions por SSE, resto por batch http
export const trpc = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      condition(op) { return op.type === "subscription"; },
      true: httpSubscriptionLink({ url: apiUrl, transformer: superjson }),
      false: httpBatchLink({ url: apiUrl, transformer: superjson })
    })
  ]
});
