import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, type ToolContext } from './tools.js';

// One MCP server per request (the endpoint is stateless), acting as one
// member on one household day. Building it is separate from the HTTP
// endpoint so a test can list its tools without a request.
export function createMcpServer(context: ToolContext) {
  const { user, day } = context;
  const server = new McpServer(
    { name: 'tasks', title: 'Pior Labs Tasks', version: '0.1.0' },
    {
      // What the client shows the model before it picks a tool: who it acts
      // as, the household's today (so "tomorrow" means the household's
      // tomorrow), and the things it would otherwise get wrong.
      instructions: [
        `This is Pior Labs Tasks, the household's private task list. It acts as ${user.name}: everything you add, change or complete is recorded as theirs.`,
        `Today is ${day.today} (${day.weekday}) in the household's timezone, ${day.timezone}. Turn relative dates such as "tomorrow" or "next Friday" into YYYY-MM-DD from this date, never from your own clock. Every result repeats today.`,
        'New tasks go to Inbox unless a list is named; list_lists shows the lists. Lists and members can be given by name or id. Task ids come from list_tasks or add_task; never guess one.',
        'Lists cannot be created, renamed, shared or deleted here. delete_task is permanent: confirm with the person first, and use complete_task for a task that was done.',
      ].join(' '),
    },
  );
  const tools = registerTools(server, context);
  return { server, tools };
}
