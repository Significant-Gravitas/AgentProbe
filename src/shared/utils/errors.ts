export class AgentProbeConfigError extends Error {
  override name = "AgentProbeConfigError";
}

export class AgentProbeRuntimeError extends Error {
  override name = "AgentProbeRuntimeError";
}

export function errorPayload(error: unknown): { type: string; message: string } {
  if (error instanceof Error) {
    return {
      type: error.name || "Error",
      message: error.message,
    };
  }

  return {
    type: "Error",
    message: String(error),
  };
}
