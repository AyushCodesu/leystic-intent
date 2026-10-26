import { deleteProjectHandler, project } from "@/lib/api/handlers";
import { respond } from "@/lib/api/route";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  return respond(request, (caller) => project(caller, id));
}

export async function DELETE(request: Request, { params }: Context) {
  const { id } = await params;
  return respond(request, (caller) => deleteProjectHandler(caller, id));
}
