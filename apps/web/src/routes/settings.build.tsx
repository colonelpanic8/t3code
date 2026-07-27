import { createFileRoute } from "@tanstack/react-router";

import { StackSettings } from "../components/settings/StackSettings";

function SettingsBuildRoute() {
  return <StackSettings />;
}

export const Route = createFileRoute("/settings/build")({
  component: SettingsBuildRoute,
});
