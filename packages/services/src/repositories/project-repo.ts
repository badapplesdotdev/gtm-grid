/**
 * `ProjectRepo` — the Effect <-> Drizzle adapter for the `projects` table.
 *
 * Ports the project reads/writes of `convex/projects.ts` (listProjects :17,
 * createProject :29): list a workspace's projects, look one up, insert a new one.
 * Two Layers like the worked example {@link import("./workspace-repo.js").WorkspaceRepo}:
 *   - {@link ProjectRepoLive} — Drizzle-backed, depends on {@link DbClient}.
 *   - {@link projectRepoLayer} — in-memory over a shared {@link GridStore}, so the
 *     grid service + procedures run with NO live database.
 */

import { schema } from "@gtmgrid/db";
import { asc, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";
import { cascadeDeleteProject, type GridStore } from "./grid-store.js";

/** A project row projection the grid domain uses. */
export interface Project {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly createdAt: number;
}

/** Fields a `createProject` insert supplies. */
export interface NewProject {
  /**
   * Client-supplied primary key. Optional: the DB generates one when omitted.
   * Supplied by the cloud grid so an optimistic project insert matches the
   * server's id.
   */
  readonly id?: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly createdAt: number;
}

/** Raised when a project read/write fails (DB/transport error). */
export class ProjectRepoError extends Data.TaggedError("ProjectRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (op: string) => (cause: unknown) =>
  new ProjectRepoError({
    message: cause instanceof Error ? cause.message : `${op} failed`,
    cause,
  });

/** Reads/writes the `projects` table. */
export class ProjectRepo extends Context.Tag("ProjectRepo")<
  ProjectRepo,
  {
    /** The project for `id`, or `None`. */
    readonly findById: (
      id: string,
    ) => Effect.Effect<Option.Option<Project>, ProjectRepoError>;
    /** A workspace's projects, oldest first (creation order). */
    readonly listByWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<readonly Project[], ProjectRepoError>;
    /** Insert a project and return its id. */
    readonly insert: (
      values: NewProject,
    ) => Effect.Effect<string, ProjectRepoError>;
    /**
     * Delete a project; the Postgres `project_id` FK cascades drop its
     * folders, tables (and their columns/rows/cells/webhooks/...), and
     * pipelines. RESTRICTed pipeline-version dependants must be purged by
     * the caller first (PipelineRepo.deletePipeline per project pipeline).
     */
    readonly remove: (id: string) => Effect.Effect<void, ProjectRepoError>;
  }
>() {}

/** The Drizzle-backed `ProjectRepo` Layer. */
export const ProjectRepoLive: Layer.Layer<ProjectRepo, never, DbClient> =
  Layer.effect(
    ProjectRepo,
    Effect.gen(function* () {
      const db = yield* DbClient;
      const columns = {
        id: schema.projects.id,
        workspaceId: schema.projects.workspaceId,
        name: schema.projects.name,
        createdAt: schema.projects.createdAt,
      } as const;
      return {
        findById: (id) =>
          UUID_RE.test(id)
            ? Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select(columns)
                    .from(schema.projects)
                    .where(eq(schema.projects.id, id))
                    .limit(1);
                  return Option.fromNullable(rows[0] ?? null);
                },
                catch: fail("project lookup"),
              })
            : Effect.succeed(Option.none<Project>()),
        listByWorkspace: (workspaceId) =>
          UUID_RE.test(workspaceId)
            ? Effect.tryPromise({
                try: () =>
                  db
                    .select(columns)
                    .from(schema.projects)
                    .where(eq(schema.projects.workspaceId, workspaceId))
                    .orderBy(asc(schema.projects.createdAt)),
                catch: fail("project list"),
              })
            : Effect.succeed([] as readonly Project[]),
        insert: (values) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .insert(schema.projects)
                .values(values)
                .returning({ id: schema.projects.id });
              const id = rows[0]?.id;
              if (id === undefined) {
                throw new Error("project insert returned no id");
              }
              return id;
            },
            catch: fail("project insert"),
          }),
        remove: (id) =>
          Effect.tryPromise({
            try: () => db.delete(schema.projects).where(eq(schema.projects.id, id)),
            catch: fail("project delete"),
          }),
      };
    }),
  );

/** An in-memory `ProjectRepo` Layer over a shared {@link GridStore}. */
export const projectRepoLayer = (store: GridStore): Layer.Layer<ProjectRepo> =>
  Layer.succeed(ProjectRepo, {
    findById: (id) =>
      Effect.succeed(
        Option.fromNullable(store.projects.find((p) => p.id === id)),
      ),
    listByWorkspace: (workspaceId) =>
      Effect.succeed(
        [...store.projects]
          .filter((p) => p.workspaceId === workspaceId)
          .sort((a, b) => a.createdAt - b.createdAt),
      ),
    insert: (values) =>
      Effect.sync(() => {
        const id = values.id ?? store.nextId("project");
        store.projects.push({ ...values, id });
        return id;
      }),
    remove: (id) => Effect.sync(() => cascadeDeleteProject(store, id)),
  });
