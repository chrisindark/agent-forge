# agent-forge

Agent Forge is an agent framework with a built-in execution harness.

Agent Creation
Define
Build agents through code and configuration.

- Agent identity, instructions, and objectives
- Model and generation settings
- Tool declarations and permissions
- Memory and knowledge-source configuration
- Reusable agent definitions

Agent Runtime
Execute
Turn an agent definition into actual behavior.

- Reasoning and action loops
- LLM requests through Echo Gate
- Tool execution and result handling
- Context assembly and conversation state
- Stop conditions, iteration limits, and timeouts

Agent Harness
Control
Constrain, observe, and evaluate agent execution.

- Tool permission enforcement
- Execution budgets and iteration limits
- Tracing, events, and audit logs
- Retries and failure handling
- Test fixtures, evaluations, and reproducibility

Component Responsibility
Agent: Identity, instructions, tools, and configuration
AgentRuntime: Reasoning loop and action execution
AgentHarness: Policies, budgets, observability, and evaluation
AgentRunner: Public entry point that brings them together
