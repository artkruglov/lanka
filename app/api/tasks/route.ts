import {
  actorFrom,
  sameOrigin,
  jsonBody,
  errorResponse,
} from "@/lib/server/auth";
import {
  createTask,
  getTask,
  listTasks,
  taskCommand,
  taskEvents,
} from "@/lib/server/tasks";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const actor = actorFrom(req),
      url = new URL(req.url),
      id = url.searchParams.get("taskId");
    return Response.json(
      id
        ? {
            task: await getTask(actor, id),
            events: await taskEvents(
              actor,
              id,
              Math.max(0, Number(url.searchParams.get("after")) || 0),
            ),
          }
        : { tasks: await listTasks(actor) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(req: Request) {
  try {
    const actor = actorFrom(req);
    sameOrigin(req);
    const { action, ...body } = await jsonBody(req, 850_000);
    return Response.json(
      action === "create"
        ? { task: await createTask(actor, body) }
        : await taskCommand(actor, { action, ...body }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
