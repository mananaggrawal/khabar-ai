// History page removed — redirect to home
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/history")({
  beforeLoad: () => { throw redirect({ to: "/" }); },
  component: () => null,
});
