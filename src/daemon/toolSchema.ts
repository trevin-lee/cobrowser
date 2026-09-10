export interface Tool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

const WORKSPACE_PARAM = {
  type: 'string',
  description:
    'Which workspace to act on — its folder name, or full path when names collide. Call list_workspaces to see the options.',
};

/**
 * Add the `workspace` selector — only for an unscoped caller, who has to name a target.
 * A workspace-scoped session gets the plain surface, because its target is already fixed by
 * the credential it presented, and offering an argument it cannot use would invite the agent
 * to try reaching somewhere it will be refused.
 */
export function withWorkspaceArg(tools: Tool[]): Tool[] {
  return tools.map((t) => ({
    ...t,
    inputSchema: {
      ...t.inputSchema,
      properties: { workspace: WORKSPACE_PARAM, ...(t.inputSchema?.properties ?? {}) },
      required: ['workspace', ...(t.inputSchema?.required ?? [])],
    },
  }));
}

/** The description differs by caller: a scoped session has no `workspace` argument to fill
 *  in, so telling it to pass one would just be wrong. */
export function listWorkspacesTool(scoped: boolean): Tool {
  return {
    name: 'list_workspaces',
    description: scoped
      ? 'Show the workspace this session is bound to. Its browser is the only one this session can drive.'
      : 'List the open cobrowser workspaces. Every other tool needs one of these as its `workspace` argument.',
    inputSchema: { type: 'object', properties: {} },
  };
}
