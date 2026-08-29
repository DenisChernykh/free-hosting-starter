export type RequestContextVariables = {
  requestId: string;
};

export type WorkerHttpEnv<TVariables extends Record<string, unknown> = Record<string, never>> = {
  Bindings: CloudflareBindings;
  Variables: RequestContextVariables & TVariables;
};
