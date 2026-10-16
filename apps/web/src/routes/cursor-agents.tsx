import { createFileRoute, redirect } from "@tanstack/react-router";

import { CursorAgentsPage } from "../components/cursorAgents/CursorAgentsPage";

export const Route = createFileRoute("/cursor-agents")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: CursorAgentsPage,
});
