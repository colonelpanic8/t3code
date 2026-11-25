import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react";
import { CalendarClockIcon } from "lucide-react";
import { memo } from "react";

import { environmentIdsKey } from "../../state/environmentAtomList";
import { scheduledTasksListAtom } from "../../state/server";
import { formatDateTimeTimestamp } from "../../timestampFormat";
import { upcomingSidebarScheduledTasks } from "../Sidebar.logic";
import { useSidebar } from "../ui/sidebar";

export const SidebarScheduledTasks = memo(function SidebarScheduledTasks({
  environmentIds,
  scopedProjectKeys,
  timestampFormat,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly timestampFormat: TimestampFormat;
}) {
  const gt = useGT();
  const { isMobile, setOpenMobile } = useSidebar();
  const queries = useAtomValue(scheduledTasksListAtom(environmentIdsKey(environmentIds)));
  const tasks = upcomingSidebarScheduledTasks(
    environmentIds.map((environmentId, index) => ({
      environmentId,
      tasks: AsyncResult.getOrElse(queries[index]!, () => null)?.tasks ?? [],
    })),
    scopedProjectKeys,
  );
  if (tasks.length === 0) return null;

  const label = gt("Scheduled tasks");
  return (
    <section aria-label={label} className="mb-2">
      <h2 className="px-2 py-1 text-xs font-medium text-sidebar-muted-foreground">{label}</h2>
      <ul className="flex flex-col gap-px">
        {tasks.map((task) => (
          <li key={`${task.environmentId}:${task.id}`}>
            <Link
              to="/settings/scheduled-tasks"
              search={{ environmentId: task.environmentId, taskId: task.id }}
              onClick={isMobile ? () => setOpenMobile(false) : undefined}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <CalendarClockIcon
                aria-hidden
                className="size-4 shrink-0 text-sidebar-muted-foreground"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm">{task.title}</span>
                <time dateTime={task.runAt} className="block text-xs text-sidebar-muted-foreground">
                  {formatDateTimeTimestamp(task.runAt, timestampFormat)}
                </time>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
});
