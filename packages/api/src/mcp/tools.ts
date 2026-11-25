import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { REPEAT_UNITS, isCalendarDate } from '../repeat.js';
import type { AppDatabase } from '../services/database.js';
import { type List, listLists } from '../services/lists.js';
import { type Member, listMembers } from '../services/members.js';
import { type Task, createTask, deleteTask, findTasks, getTask, updateTask } from '../services/tasks.js';
import type { ActingUser } from './caller.js';
import { resolveList, resolveMember } from './resolve.js';
import type { HouseholdDay } from './today.js';

// The seven Tasks tools. Each one calls the same services as the web API
// (src/services/), as the acting user, so an agent can do exactly what that
// member can do in the web app and is refused in the same words. Lists and
// members can be named instead of numbered (src/mcp/resolve.ts).
//
// Results carry both a short text for the model and structuredContent, and
// always report the household's today and timezone. Results name people by
// display name, never by email address (D-9).

export type ToolContext = {
  db: AppDatabase;
  user: ActingUser;
  day: HouseholdDay;
  // The server's UTC date, which bounds the `today` a completion may send.
  serverToday: string;
};

export const DEFAULT_TASK_LIMIT = 100;
export const MAX_TASK_LIMIT = 200;

const todayLine = ({ day }: ToolContext) => `Today is ${day.today} (${day.weekday}) in ${day.timezone}.`;

function respond(context: ToolContext, text: string, data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: `${text}\n\n${todayLine(context)}` }],
    structuredContent: { today: context.day.today, timezone: context.day.timezone, ...data },
  };
}

// A refusal: the message is the first text, exactly as the service (or the
// name lookup) worded it.
function refuse(context: ToolContext, message: string): CallToolResult {
  return {
    content: [
      { type: 'text', text: message },
      { type: 'text', text: todayLine(context) },
    ],
    structuredContent: { error: message, today: context.day.today, timezone: context.day.timezone },
    isError: true,
  };
}

// A tool must answer, not throw: the SDK would put the raw error message,
// which can quote task content, into the result. Only the tool name and the
// error's class are logged.
async function run(context: ToolContext, tool: string, handler: () => Promise<CallToolResult>) {
  try {
    return await handler();
  } catch (error) {
    console.error('MCP tool failed', tool, error instanceof Error ? error.name : 'unknown');
    return refuse(context, 'Tasks could not finish this request because of a server error. Try again later.');
  }
}

type Names = { lists: List[]; listNames: Map<number, string>; members: Member[]; memberNames: Map<number, string> };
async function names(context: ToolContext): Promise<Names> {
  const [lists, members] = await Promise.all([listLists(context.db, context.user.id), listMembers(context.db)]);
  return {
    lists,
    listNames: new Map(lists.map((list) => [list.id, list.name])),
    members,
    memberNames: new Map(members.map((member) => [member.id, member.name])),
  };
}

// A task as the tools show it. `list` is the list's name, or "Inbox".
function present(task: Task, { listNames, memberNames }: Names) {
  const member = (id: number | null) => (id === null ? null : (memberNames.get(id) ?? null));
  return {
    id: task.id,
    title: task.title,
    list_id: task.listId,
    list: task.listId === null ? 'Inbox' : (listNames.get(task.listId) ?? null),
    due_date: task.dueDate,
    repeat: task.repeat,
    notes: task.notes,
    completed: task.completed,
    completed_by: member(task.completedById),
    assignee_id: task.assigneeId,
    assignee: member(task.assigneeId),
    created_by: member(task.createdById),
    created_at: task.createdAt.toISOString(),
  };
}
type PresentedTask = ReturnType<typeof present>;

function describe(task: PresentedTask) {
  const parts = [task.list ?? 'a list', task.due_date ? `due ${task.due_date}` : 'no due date'];
  if (task.repeat) parts.push(`repeats every ${task.repeat.every} ${task.repeat.unit}${task.repeat.every === 1 ? '' : 's'}`);
  if (task.assignee) parts.push(`assigned to ${task.assignee}`);
  if (task.completed) parts.push(task.completed_by ? `completed by ${task.completed_by}` : 'completed');
  return `[#${task.id}] ${task.title} (${parts.join(', ')})${task.notes ? `\n    notes: ${task.notes}` : ''}`;
}

const listReference = z
  .union([z.string(), z.number().int()])
  .describe('A list name (letter case and spacing do not matter), its id from list_lists, or "Inbox".');
const assigneeReference = z
  .union([z.string(), z.number().int()])
  .describe(
    'A household member\'s display name or id, or "me". Only a task in a shared list can have an assignee; null means nobody.',
  );
const dueDate = z
  .string()
  .describe(
    'The due date as YYYY-MM-DD. Work out relative days ("tomorrow", "next Friday") from the today this server reports, not from your own clock.',
  );
const repeat = z
  .object({
    every: z.number().int().describe('How many units between occurrences, 1 to 99.'),
    unit: z.enum(REPEAT_UNITS),
  })
  .describe('Repeat on a fixed schedule from the due date, such as { "every": 1, "unit": "week" }. Needs a due date.');
const notes = z.string().describe('Plain-text notes, at most 5000 characters.');
const taskId = z.number().int().positive().describe('The task id, from list_tasks or add_task.');

export function registerTools(server: McpServer, context: ToolContext): string[] {
  const { db, user } = context;

  server.registerTool(
    'list_lists',
    {
      title: 'List lists',
      description:
        'The lists tasks can go in: Inbox (no list), your own lists, and every shared list, with whose each one is. Lists cannot be created, renamed, shared or deleted with these tools.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(context, 'list_lists', async () => {
        const known = await names(context);
        const lists = [
          { id: null, name: 'Inbox', shared: false, owner: user.name, mine: true },
          ...known.lists.map((list) => ({
            id: list.id,
            name: list.name,
            shared: list.shared,
            owner: known.memberNames.get(list.ownerId) ?? null,
            mine: list.ownerId === user.id,
          })),
        ];
        const text = lists
          .map((list) =>
            list.id === null
              ? '- Inbox (no list; new tasks go here by default)'
              : `- [id ${list.id}] ${list.name}${list.shared ? ' (shared' : ' (private'}${list.mine ? ', yours)' : `, ${list.owner ?? 'another member'}'s)`}`,
          )
          .join('\n');
        return respond(context, `Lists:\n${text}`, { lists });
      }),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description: `Find tasks. Every filter given must match. Without filters: every open task in Inbox, your lists and the shared lists. Ordered by due date (tasks without one last), then oldest first; at most ${DEFAULT_TASK_LIMIT} unless limit says otherwise, and the result says when more matched. Use the reported today to turn "tomorrow" or "this week" into dates.`,
      inputSchema: {
        list: listReference.optional(),
        due_from: z.string().optional().describe('Only tasks due on or after this day (YYYY-MM-DD).'),
        due_to: z.string().optional().describe('Only tasks due on or before this day (YYYY-MM-DD).'),
        overdue: z.boolean().optional().describe('true: only open tasks due before today.'),
        assigned_to_me: z.boolean().optional().describe('true: only tasks assigned to you.'),
        include_completed: z.boolean().optional().describe('Also show completed tasks. Default false.'),
        search: z.string().optional().describe('Only tasks whose title contains this text, ignoring letter case.'),
        limit: z.number().int().min(1).max(MAX_TASK_LIMIT).optional().describe(`At most this many tasks, 1 to ${MAX_TASK_LIMIT}. Default ${DEFAULT_TASK_LIMIT}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(context, 'list_tasks', async () => {
        for (const [field, value] of [['due_from', args.due_from], ['due_to', args.due_to]] as const) {
          if (value !== undefined && !isCalendarDate(value)) {
            return refuse(context, `${field} must be a real calendar date written as YYYY-MM-DD.`);
          }
        }
        if (args.due_from !== undefined && args.due_to !== undefined && args.due_from > args.due_to) {
          return refuse(context, 'due_from is after due_to, so no task could match.');
        }
        const known = await names(context);
        let listId: number | null | undefined;
        if (args.list !== undefined) {
          const resolved = resolveList(args.list, known.lists, user, known.memberNames);
          if (!resolved.ok) return refuse(context, resolved.message);
          listId = resolved.value;
        }
        const search = args.search?.trim() || undefined;
        const limit = args.limit ?? DEFAULT_TASK_LIMIT;
        const found = await findTasks(db, user.id, {
          listId,
          dueFrom: args.due_from,
          dueTo: args.due_to,
          overdueBefore: args.overdue ? context.day.today : undefined,
          assigneeId: args.assigned_to_me ? user.id : undefined,
          includeCompleted: args.include_completed ?? false,
          search,
          limit,
        });
        const tasks = found.tasks.map((task) => present(task, known));
        const heading =
          tasks.length === 0
            ? 'No tasks match.'
            : `${tasks.length} task${tasks.length === 1 ? '' : 's'}${found.truncated ? ` (only the first ${limit}; more match, so narrow the filters or raise limit)` : ''}:`;
        return respond(context, [heading, ...tasks.map((task) => `- ${describe(task)}`)].join('\n'), {
          tasks,
          truncated: found.truncated,
        });
      }),
  );

  server.registerTool(
    'add_task',
    {
      title: 'Add a task',
      description:
        'Add a task, by default to Inbox. Write the title as the person would ("Buy broccoli"). For a due date such as "tomorrow", use the reported today to work out the YYYY-MM-DD.',
      inputSchema: {
        title: z.string().describe('The task title, at most 200 characters.'),
        due_date: dueDate.nullable().optional(),
        notes: notes.nullable().optional(),
        repeat: repeat.nullable().optional(),
        list: listReference.nullable().optional(),
        assignee: assigneeReference.nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(context, 'add_task', async () => {
        const known = await names(context);
        let listId: number | null = null;
        if (args.list !== undefined) {
          const resolved = resolveList(args.list, known.lists, user, known.memberNames);
          if (!resolved.ok) return refuse(context, resolved.message);
          listId = resolved.value;
        }
        let assigneeId: number | null | undefined;
        if (args.assignee !== undefined) {
          const resolved = resolveMember(args.assignee, known.members, user);
          if (!resolved.ok) return refuse(context, resolved.message);
          assigneeId = resolved.value;
        }
        const result = await createTask(db, user.id, {
          title: args.title,
          notes: args.notes,
          dueDate: args.due_date,
          repeat: args.repeat,
          listId,
          assigneeId,
        });
        if (!result.ok) return refuse(context, result.failure.message);
        const task = present(result.value, known);
        return respond(context, `Added ${describe(task)}`, { task });
      }),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Change a task',
      description:
        'Change a task\'s title, due date, notes, repeat, list or assignee. Give only what changes; null clears a due date, notes, repeat or assignee, and list null (or "Inbox") moves it to Inbox. A task moved out of a shared list loses its assignee. Use complete_task and reopen_task to tick it off or undo that.',
      inputSchema: {
        task_id: taskId,
        title: z.string().optional().describe('The new title, at most 200 characters.'),
        due_date: dueDate.nullable().optional(),
        notes: notes.nullable().optional(),
        repeat: repeat.nullable().optional(),
        list: listReference.nullable().optional(),
        assignee: assigneeReference.nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(context, 'update_task', async () => {
        const { task_id: id, title, due_date, notes: newNotes, repeat: newRepeat, list, assignee } = args;
        if ([title, due_date, newNotes, newRepeat, list, assignee].every((value) => value === undefined)) {
          return refuse(context, 'Give at least one of title, due_date, notes, repeat, list or assignee to change.');
        }
        const known = await names(context);
        let listId: number | null | undefined;
        if (list !== undefined) {
          const resolved = resolveList(list, known.lists, user, known.memberNames);
          if (!resolved.ok) return refuse(context, resolved.message);
          listId = resolved.value;
        }
        let assigneeId: number | null | undefined;
        if (assignee !== undefined) {
          const resolved = resolveMember(assignee, known.members, user);
          if (!resolved.ok) return refuse(context, resolved.message);
          assigneeId = resolved.value;
        }
        const result = await updateTask(
          db,
          user.id,
          id,
          { title, notes: newNotes, dueDate: due_date, repeat: newRepeat, listId, assigneeId },
          context.serverToday,
        );
        if (!result.ok) return refuse(context, result.failure.message);
        const task = present(result.value.task, known);
        return respond(context, `Updated ${describe(task)}`, { task });
      }),
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete a task',
      description:
        'Tick a task off as done, recorded as completed by you. Completing a repeating task adds its next occurrence, scheduled from the household\'s today; the result names it.',
      inputSchema: { task_id: taskId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(context, 'complete_task', async () => {
        const result = await updateTask(
          db,
          user.id,
          args.task_id,
          { completed: true, today: context.day.today },
          context.serverToday,
        );
        if (!result.ok) return refuse(context, result.failure.message);
        const known = await names(context);
        const task = present(result.value.task, known);
        const nextTask = result.value.nextTask && present(result.value.nextTask, known);
        const lines = [result.value.completionChanged ? `Completed ${describe(task)}` : `Already completed, nothing changed: ${describe(task)}`];
        if (nextTask) lines.push(`Next occurrence: ${describe(nextTask)}`);
        else if (result.value.completionChanged && task.repeat) {
          lines.push('No new occurrence was added: the next one already exists, or it would fall after 2100-12-31.');
        }
        return respond(context, lines.join('\n'), {
          task,
          next_task: nextTask,
          changed: result.value.completionChanged,
        });
      }),
  );

  server.registerTool(
    'reopen_task',
    {
      title: 'Reopen a task',
      description:
        'Undo completing a task. If completing it had added a next occurrence that is still open, that occurrence is removed again.',
      inputSchema: { task_id: taskId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(context, 'reopen_task', async () => {
        const result = await updateTask(db, user.id, args.task_id, { completed: false }, context.serverToday);
        if (!result.ok) return refuse(context, result.failure.message);
        const known = await names(context);
        const task = present(result.value.task, known);
        const { removedTaskId } = result.value;
        const lines = [result.value.completionChanged ? `Reopened ${describe(task)}` : `Already open, nothing changed: ${describe(task)}`];
        if (removedTaskId !== null) lines.push(`Removed its open next occurrence, task #${removedTaskId}.`);
        return respond(context, lines.join('\n'), {
          task,
          removed_task_id: removedTaskId,
          changed: result.value.completionChanged,
        });
      }),
  );

  server.registerTool(
    'delete_task',
    {
      title: 'Delete a task',
      description:
        'Delete a task permanently. There is no undo or archive. Confirm with the person first, and prefer complete_task when the task was done.',
      inputSchema: { task_id: taskId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(context, 'delete_task', async () => {
        const existing = await getTask(db, user.id, args.task_id);
        const result = await deleteTask(db, user.id, args.task_id);
        if (!result.ok) return refuse(context, result.failure.message);
        return respond(
          context,
          `Deleted task #${args.task_id}${existing ? ` "${existing.title}"` : ''} permanently.`,
          { deleted_task_id: args.task_id },
        );
      }),
  );

  return ['list_lists', 'list_tasks', 'add_task', 'update_task', 'complete_task', 'reopen_task', 'delete_task'];
}
