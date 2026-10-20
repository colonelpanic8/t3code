import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

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
  const screen = await render(<RouterProvider router={router} />, { router: false });
  return Object.assign(screen, { testRouter: router });
}

describe("settings sidebar Back", () => {
  it("shows a single Back above the sections and returns to the last main app page", async () => {
    // The tracker remembers the thread the user left to open Settings.
    {
      await using _thread = await renderAt("/threads/abc");
    }
    await using screen = await renderAt("/settings/general");
    const router = screen.testRouter;
    const container = screen.container;

    const backButtons = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent === "Back",
    );
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
