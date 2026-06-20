// Browse page — redirects to home (merged into main tab interface)
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/browse")({
  beforeLoad: () => { throw redirect({ to: "/" }); },
  component: () => null,
});
