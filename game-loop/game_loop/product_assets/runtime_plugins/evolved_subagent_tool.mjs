export const name = "evolved-subagent-tool";
export const inject = ["tools", "subagents", "systemPrompt"];

const SUBAGENT_SECTION_ORDER = 116.5;

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`evolved-subagent-tool: ${field} must be a non-empty string`);
  }
}

function validateConfig(config) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("evolved-subagent-tool: config must be an object");
  }
  requireNonEmptyString(config.provider, "provider");
  requireNonEmptyString(config.toolName, "toolName");
  requireNonEmptyString(config.toolDescription, "toolDescription");
  requireNonEmptyString(config.persona, "persona");
  if (
    !Number.isSafeInteger(config.maxDepth)
    || config.maxDepth < 0
    || Object.is(config.maxDepth, -0)
  ) {
    throw new TypeError(
      "evolved-subagent-tool: maxDepth must be a non-negative safe integer",
    );
  }
  if (config.toolFilter !== undefined) {
    const filter = config.toolFilter;
    if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
      throw new TypeError("evolved-subagent-tool: toolFilter must be an object");
    }
    const hasAllow = Array.isArray(filter.allow);
    const hasDeny = Array.isArray(filter.deny);
    if (hasAllow === hasDeny) {
      throw new Error(
        "evolved-subagent-tool: toolFilter must name exactly one of allow or deny",
      );
    }
    const values = hasAllow ? filter.allow : filter.deny;
    if (!values.every((value) => typeof value === "string" && value.trim() !== "")) {
      throw new TypeError(
        "evolved-subagent-tool: toolFilter entries must be non-empty strings",
      );
    }
  }
  if (config.agentOptions !== undefined) {
    const options = config.agentOptions;
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("evolved-subagent-tool: agentOptions must be an object");
    }
    if (
      options.maxTokens !== undefined
      && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1)
    ) {
      throw new TypeError(
        "evolved-subagent-tool: agentOptions.maxTokens must be a positive safe integer",
      );
    }
  }
}

function validateArgs(args) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new TypeError("evolved subagent arguments must be an object");
  }
  requireNonEmptyString(args.description, "arguments.description");
  requireNonEmptyString(args.prompt, "arguments.prompt");
}

function outputValueText(values) {
  return values
    .filter((value) => (
      typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && value.type === "text"
      && typeof value.text === "string"
    ))
    .map((value) => value.text)
    .join("");
}

function stopReasonError(result) {
  switch (result.stopReason) {
    case "completed": return undefined;
    case "aborted": return "subagent run was cancelled";
    case "error": return "subagent run failed";
    case "max-tokens": return "subagent run hit its token limit before finishing";
    case "refusal": return "subagent declined the task";
    default: return `subagent run ended abnormally (${String(result.stopReason)})`;
  }
}

export function apply(ctx, config) {
  validateConfig(config);

  let disposeTool;
  const mount = (provider) => {
    if (!provider.capabilities.depthLimit) {
      throw new Error(
        `evolved-subagent-tool: provider ${provider.name} cannot enforce maxDepth`,
      );
    }
    if (provider.prepareContinuable === undefined) {
      throw new Error(
        `evolved-subagent-tool: provider ${provider.name} does not support background continuations`,
      );
    }
    disposeTool = ctx.tools.register({
      name: config.toolName,
      description: (
        `${config.toolDescription} This starts in the background, returns a child id `
        + "immediately, and sends a completion notice with the child's final artifact report."
      ),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: {
            type: "string",
            description: "A short 3-5 word label for the delegated artifact slice.",
          },
          prompt: {
            type: "string",
            description: (
              "The bounded task for the child. It inherits completed parent turns; "
              + "name the owned slice, runnable deliverable, and check to return."
            ),
          },
        },
        required: ["description", "prompt"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", const: "continuable" },
            subagentId: { type: "string" },
          },
          required: ["kind", "subagentId"],
        },
        render: (_args, value) => [{
          type: "text",
          text: `started background child ${value.subagentId}`,
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        validateArgs(args);
        const parent = exec.agent;
        if (!parent) {
          throw new Error("evolved subagent tool requires a calling agent");
        }
        const boundedRequest = [
          args.prompt,
          "\n\n## Bounded child completion contract\n",
          "Work on the owned slice only. Produce the smallest runnable result, run its "
            + "local check, then return a concise handoff with status, changed paths, "
            + "artifact summary, check evidence, and any integration note. Stop after the "
            + "handoff; do not start another child or broaden the task.",
        ].join("");
        const child = await ctx.subagents.startContinuable({
          provider: config.provider,
          label: args.description,
          request: {
            prompt: [{ type: "text", text: boundedRequest }],
            parent,
            persona: config.persona,
            maxDepth: config.maxDepth,
            ...(config.agentOptions !== undefined
              ? { agentOptions: config.agentOptions }
              : {}),
            ...(config.toolFilter !== undefined
              ? { toolFilter: config.toolFilter }
              : {}),
          },
          signal: exec.signal,
        });
        return { kind: "continuable", subagentId: child.childId };
      },
    });
  };

  ctx.on("subagent/provider-added", (provider) => {
    if (provider.name === config.provider && disposeTool === undefined) {
      mount(provider);
    }
  });
  ctx.on("subagent/provider-removed", (providerName) => {
    if (providerName !== config.provider || disposeTool === undefined) return;
    disposeTool();
    disposeTool = undefined;
  });
  const present = ctx.subagents.getProvider(config.provider);
  if (present !== undefined) mount(present);
  ctx.systemPrompt.section({
    name: `tool:${config.toolName}`,
    order: SUBAGENT_SECTION_ORDER,
    text: () => (
      disposeTool === undefined
        ? ""
        : `When an independent bounded slice matches ${config.toolName}, start it in the `
          + "background and continue useful root work while it runs. The runtime sends a "
          + "completion notice containing the child's final artifact report. This is an "
          + "optional capability: do not invoke it when the evolved use condition does not match."
    ),
  });
}
