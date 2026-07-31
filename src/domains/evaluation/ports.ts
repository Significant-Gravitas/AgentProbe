import type {
  AdapterReply,
  AutogptAuthResult,
  Endpoints,
  OpenAiResponsesRequest,
  OpenAiResponsesResponse,
  UploadedFile,
} from "../../shared/types/contracts.ts";

export type EndpointAdapter = {
  healthCheck: (renderContext: Record<string, unknown>) => Promise<void>;
  openScenario: (
    renderContext: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  sendUserTurn: (
    renderContext: Record<string, unknown>,
  ) => Promise<AdapterReply>;
  closeScenario: (renderContext: Record<string, unknown>) => Promise<void>;
  uploadFile?: (filePath: string, fileName: string) => Promise<UploadedFile>;
};

export type EndpointAdapterFactoryContext = {
  userId: string;
  userName?: string;
  baseUrlOverride?: string;
};

export type EndpointAdapterFactory = (
  endpoint: Endpoints,
  context: EndpointAdapterFactoryContext,
) => EndpointAdapter;

export type AutogptAuthResolver = () =>
  | Promise<AutogptAuthResult>
  | AutogptAuthResult;

export type LlmResponsesClient = {
  create(request: OpenAiResponsesRequest): Promise<OpenAiResponsesResponse>;
};
