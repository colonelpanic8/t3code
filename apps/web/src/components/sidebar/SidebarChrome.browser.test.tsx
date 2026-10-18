import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: [], isReady: true }),
  usePullRequestsSupported: () => false,
}));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdatePill: () => null,
  SidebarUpdateArchitectureWarning: () => null,
}));
vi.mock("../ui/sidebar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/sidebar")>()),
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

import { SidebarBackButton, SidebarUtilityMenu } from "./SidebarChrome";
import { MainAppLocationTracker } from "./mainAppLocation";

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

// Mirrors the Settings sidebar: Back above the sections, the footer menu without it.
function SettingsSidebar() {
  return (
    <>
      <ul data-testid="top">
        <SidebarBackButton />
      </ul>
      <SidebarUtilityMenu hideBack />
    </>
  );
}

async function renderAt(path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <MainAppLocationTracker />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/threads/$id", component: () => null }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings/general",
        component: SettingsSidebar,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  root = createRoot(container);
  await act(async () => root!.render(<RouterProvider router={router} />));
  return router;
}

const buttonsLabelled = (label: string) =>
  Array.from(container.querySelectorAll("button")).filter((button) => button.textContent === label);

describe("settings sidebar Back", () => {
  it("shows a single Back above the sections and returns to the last main app page", async () => {
    // The tracker remembers the thread the user left to open Settings.
    await renderAt("/threads/abc");
    await act(async () => root?.unmount());
    const router = await renderAt("/settings/general");

    const backButtons = buttonsLabelled("Back");
    expect(backButtons).toHaveLength(1);
    expect(Array.from(container.querySelectorAll('[data-testid="top"] button'))).toEqual(
      backButtons,
    );

    await act(async () => {
      backButtons[0]!.click();
      await router.load();
    });
    expect(router.state.location.pathname).toBe("/threads/abc");
  });
});
